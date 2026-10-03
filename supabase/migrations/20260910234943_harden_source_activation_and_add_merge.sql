
create or replace function public.activate_analysis_source_file(
  p_source_id uuid,
  p_mode text
)
returns public.analysis_source_files
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected public.analysis_source_files;
  caller_uid uuid;
begin
  select auth.uid() into caller_uid;

  select * into selected
  from public.analysis_source_files
  where id = p_source_id
  for update;

  if selected.id is null then
    raise exception 'source file not found';
  end if;
  if caller_uid is not null and caller_uid is distinct from selected.user_id then
    raise exception 'source owner mismatch';
  end if;
  if selected.status not in ('valid', 'active', 'archived', 'superseded') then
    raise exception 'source status cannot be activated: %', selected.status;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(selected.user_id::text || ':' || selected.source_type, 0)
  );

  if selected.source_type = 'screening' and p_mode = 'replace' then
    update public.analysis_source_files
    set status = 'superseded', superseded_by = selected.id
    where user_id = selected.user_id
      and source_type = 'screening'
      and status = 'active'
      and id <> selected.id;
  elsif selected.source_type = 'screening' and p_mode in ('append', 'merge') then
    null;
  elsif selected.source_type = 'backtest' and p_mode = 'replace_all' then
    update public.analysis_source_files
    set status = 'superseded', superseded_by = selected.id
    where user_id = selected.user_id
      and source_type = 'backtest'
      and status = 'active'
      and id <> selected.id;
  elsif selected.source_type = 'backtest' and p_mode = 'add' then
    null;
  else
    raise exception 'mode % is invalid for %', p_mode, selected.source_type;
  end if;

  update public.analysis_source_files
  set status = 'active',
      activated_at = coalesce(activated_at, pg_catalog.now()),
      superseded_by = null
  where id = selected.id
  returning * into selected;

  return selected;
end;
$$;

revoke execute on function public.activate_analysis_source_file(uuid, text)
from public, anon;
grant execute on function public.activate_analysis_source_file(uuid, text)
to authenticated, service_role;
