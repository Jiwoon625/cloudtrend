-- Indefinite retention of daily screening records; the UI still reads 90 dates.
-- No row/object is deleted, rewritten, or copied. RLS and grants are unchanged.
-- Run in a transaction (Supabase migrations do so); fail rather than wait on a
-- busy production table. No CASCADE is used for unexpected dependencies.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if pg_catalog.to_regclass('public.screening_history') is null then
    raise exception 'screening_history must exist before retention migration';
  end if;
  if exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.screening_history'::regclass
      and t.tgname = 'keep_90_snapshots'
      and t.tgfoid <> coalesce(
        pg_catalog.to_regprocedure('public.trim_screening_history()')::oid, 0
      )
  ) then
    raise exception 'Unexpected keep_90_snapshots trigger; inspect before changing';
  end if;
end;
$$;

drop trigger if exists keep_90_snapshots on public.screening_history;
drop function if exists public.trim_screening_history();
