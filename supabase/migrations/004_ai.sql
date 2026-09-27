-- Kosha AI: the Reconciliation Copilot's investigations.
--
-- The Copilot (lib/ai/recon-copilot) investigates one open reconciliation exception and
-- proposes a resolution. It never moves money. Its proposal is stored here, and a person
-- accepts it (which runs resolve_recon_item() in the same transaction) or dismisses it.
--
-- Safe to run on a database that already has 001-003 applied: every statement is idempotent.

create table if not exists ai_investigations (
  id              uuid primary key default gen_random_uuid(),
  recon_item_id   uuid not null references reconciliation_items(id),
  status          text not null default 'PROPOSED' check (status in ('PROPOSED', 'ACCEPTED', 'DISMISSED', 'SUPERSEDED')),
  recommendation  text not null check (recommendation in ('MARK_PAID', 'MARK_REVIEWED', 'ESCALATE')),
  confidence      text not null check (confidence in ('high', 'medium', 'low')),
  result          jsonb not null,               -- the structured diagnosis (see lib/ai/recon-copilot/schema.ts)
  verification    jsonb not null,               -- deterministic checks run on the diagnosis
  trace           jsonb not null default '[]',  -- tool calls the agent made, for the audit trail
  model           text not null,
  usage           jsonb not null default '{}',  -- token counts
  latency_ms      integer not null check (latency_ms >= 0),
  created_by      text not null,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now(),

  constraint ai_decision_fields
    check ((status in ('ACCEPTED', 'DISMISSED')) = (decided_by is not null and decided_at is not null))
);

create index if not exists ai_investigations_item_idx on ai_investigations (recon_item_id, created_at desc);

-- ---------------------------------------------------------------------------
-- save_ai_investigation: store a new proposal. An earlier open proposal for the same item
-- is marked SUPERSEDED, so there is at most one open proposal per item.
-- ---------------------------------------------------------------------------
create or replace function save_ai_investigation(
  p_item_id        uuid,
  p_actor          text,
  p_recommendation text,
  p_confidence     text,
  p_result         jsonb,
  p_verification   jsonb,
  p_trace          jsonb,
  p_model          text,
  p_usage          jsonb,
  p_latency_ms     integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_item reconciliation_items;
  v_row  ai_investigations;
begin
  perform _check_actor(p_actor);
  if p_actor not in ('admin', 'accountant') then
    perform _fail('forbidden', 'Only admins and accountants can run the Reconciliation Copilot.');
  end if;

  select * into v_item from reconciliation_items where id = p_item_id for update;
  if not found then
    perform _fail('recon_item_not_found', 'Reconciliation item not found.');
  end if;
  if v_item.bucket = 'MATCHED' then
    perform _fail('recon_item_matched', 'Matched items need no investigation.');
  end if;
  if v_item.resolution is not null then
    perform _fail('recon_item_already_resolved', format('This item was already resolved by %s.', v_item.resolved_by));
  end if;

  update ai_investigations set status = 'SUPERSEDED'
   where recon_item_id = p_item_id and status = 'PROPOSED';

  insert into ai_investigations (recon_item_id, recommendation, confidence, result, verification, trace,
                                 model, usage, latency_ms, created_by, created_at)
  values (p_item_id, p_recommendation, p_confidence, p_result, p_verification, coalesce(p_trace, '[]'),
          p_model, coalesce(p_usage, '{}'), p_latency_ms, p_actor, kosha_now())
  returning * into v_row;

  perform _audit(p_actor, 'ai.investigated', 'reconciliation_item', p_item_id::text, jsonb_build_object(
    'investigation_id', v_row.id, 'gateway_ref', v_item.gateway_ref, 'bucket', v_item.bucket,
    'recommendation', p_recommendation, 'confidence', p_confidence, 'model', p_model));

  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_ai_investigation: a person accepts or dismisses a proposal.
--   ACCEPT  runs resolve_recon_item() with the (possibly edited) note, in this transaction.
--           MARK_PAID -> MARKED_PAID, MARK_REVIEWED -> REVIEWED. ESCALATE cannot be accepted:
--           it means "a person must look at this", so it is resolved by hand or dismissed.
--   DISMISS records that the suggestion was not used, with a reason.
-- ---------------------------------------------------------------------------
create or replace function decide_ai_investigation(
  p_investigation_id uuid,
  p_decision         text,
  p_actor            text,
  p_note             text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv  ai_investigations;
  v_item reconciliation_items;
  v_note text := nullif(trim(p_note), '');
  v_resolved jsonb;
begin
  perform _check_actor(p_actor);
  if p_actor not in ('admin', 'accountant') then
    perform _fail('forbidden', 'Only admins and accountants can act on Copilot suggestions.');
  end if;
  if p_decision is null or p_decision not in ('ACCEPT', 'DISMISS') then
    perform _fail('invalid_decision', 'Decision must be accept or dismiss.');
  end if;

  select * into v_inv from ai_investigations where id = p_investigation_id for update;
  if not found then
    perform _fail('investigation_not_found', 'Copilot investigation not found.');
  end if;
  if v_inv.status <> 'PROPOSED' then
    perform _fail('investigation_closed', format('This suggestion is already %s.', lower(v_inv.status)));
  end if;
  select * into v_item from reconciliation_items where id = v_inv.recon_item_id;

  if p_decision = 'ACCEPT' then
    if v_inv.recommendation = 'ESCALATE' then
      perform _fail('invalid_decision', 'An escalation cannot be accepted. Resolve the item by hand after checking with the gateway.');
    end if;
    -- resolve_recon_item takes its own locks (student, payment, item) and writes its own audit row.
    v_resolved := resolve_recon_item(
      v_inv.recon_item_id,
      case v_inv.recommendation when 'MARK_PAID' then 'MARKED_PAID' else 'REVIEWED' end,
      p_actor,
      v_note);
  else
    if v_note is null or length(v_note) < 3 then
      perform _fail('note_required', 'Say why the suggestion was not used.');
    end if;
  end if;

  update ai_investigations
     set status = case p_decision when 'ACCEPT' then 'ACCEPTED' else 'DISMISSED' end,
         decided_by = p_actor, decided_at = kosha_now(), decision_note = v_note
   where id = p_investigation_id
  returning * into v_inv;

  perform _audit(p_actor, case p_decision when 'ACCEPT' then 'ai.suggestion_accepted' else 'ai.suggestion_dismissed' end,
    'reconciliation_item', v_item.id::text, jsonb_build_object(
      'investigation_id', v_inv.id, 'gateway_ref', v_item.gateway_ref, 'bucket', v_item.bucket,
      'recommendation', v_inv.recommendation, 'note', v_note));

  return jsonb_build_object('investigation', to_jsonb(v_inv), 'resolved', v_resolved);
end;
$$;

-- ---------------------------------------------------------------------------
-- reset_demo: same as 002, plus the Copilot's table (it references reconciliation_items).
-- ---------------------------------------------------------------------------
create or replace function reset_demo(p_actor text default 'admin') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  perform _check_actor(p_actor);
  if p_actor not in ('admin', 'system') then
    perform _fail('forbidden', 'Only an admin can reset demo data.');
  end if;

  perform pg_advisory_xact_lock(hashtext('kosha.reset_demo'));

  perform set_config('kosha.resetting', 'on', true);
  truncate table ai_investigations, reconciliation_items, reconciliation_runs, audit_log, ledger_entries,
                 payment_allocations, payment_events, mock_gateway_txns, payments, concessions,
                 installments, students, fee_heads, courses
    restart identity;
  perform set_config('kosha.resetting', 'off', true);

  perform setval('receipt_seq', 1, false);
  perform setval('gateway_ref_seq', 1, false);

  v_result := seed_demo();
  perform set_config('kosha.clock', '', true);

  perform _audit(p_actor, 'demo.reset', 'demo', null, v_result);
  return v_result;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on ai_investigations from anon, authenticated, service_role;
    grant select on ai_investigations to service_role;
    revoke execute on function
      save_ai_investigation(uuid, text, text, text, jsonb, jsonb, jsonb, text, jsonb, integer),
      decide_ai_investigation(uuid, text, text, text)
    from public, anon, authenticated;
    grant execute on function
      save_ai_investigation(uuid, text, text, text, jsonb, jsonb, jsonb, text, jsonb, integer),
      decide_ai_investigation(uuid, text, text, text),
      reset_demo(text)
    to service_role;
  end if;
end;
$$;
