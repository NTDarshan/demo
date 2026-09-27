-- Kosha AI: audit entries for messages drafted for parents. Idempotent.
--
-- Drafting changes nothing, and Kosha never sends the message, but who drafted what for
-- which student belongs in the audit trail. The API role can only write audit rows through
-- this function, and only for this one action.

create or replace function log_message_draft(
  p_actor      text,
  p_student_id uuid,
  p_details    jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check_actor(p_actor);
  if p_actor not in ('admin', 'accountant') then
    perform _fail('forbidden', 'Only admins and accountants can draft messages to parents.');
  end if;
  if not exists (select 1 from students where id = p_student_id) then
    perform _fail('student_not_found', 'Student not found.');
  end if;
  perform _audit(p_actor, 'ai.message_drafted', 'student', p_student_id::text,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('student_id', p_student_id));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function log_message_draft(text, uuid, jsonb) from public, anon, authenticated;
    grant execute on function log_message_draft(text, uuid, jsonb) to service_role;
  end if;
end;
$$;
