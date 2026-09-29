-- Kosha AI: the daily finance brief. Idempotent.
--
-- One or more briefs per day (a refresh adds a new one; the dashboard shows the latest). A brief
-- is a snapshot of computed signals plus the words chosen for them; it changes no money.

create table if not exists ai_briefs (
  id          uuid primary key default gen_random_uuid(),
  brief_date  date not null,
  content     jsonb not null,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
create index if not exists ai_briefs_date_idx on ai_briefs (brief_date desc, created_at desc);

create or replace function save_ai_brief(p_actor text, p_date date, p_content jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row ai_briefs;
begin
  perform _check_actor(p_actor);
  if p_actor not in ('admin', 'accountant') then
    perform _fail('forbidden', 'Only admins and accountants can generate the daily brief.');
  end if;
  insert into ai_briefs (brief_date, content, created_by, created_at)
  values (p_date, p_content, p_actor, kosha_now())
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- reset_demo: as in 004, plus the briefs.
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
  truncate table ai_briefs, ai_investigations, reconciliation_items, reconciliation_runs, audit_log, ledger_entries,
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
    revoke all on ai_briefs from anon, authenticated, service_role;
    grant select on ai_briefs to service_role;
    revoke execute on function save_ai_brief(text, date, jsonb) from public, anon, authenticated;
    grant execute on function save_ai_brief(text, date, jsonb), reset_demo(text) to service_role;
  end if;
end;
$$;
