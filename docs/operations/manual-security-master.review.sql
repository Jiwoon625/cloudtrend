-- Review-only SQL; not installed by this branch. Generate an approved migration before cutover.
create table public.manual_security_master (
  user_id uuid primary key references auth.users(id),
  revision integer not null check (revision > 0),
  as_of date not null,
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 1 and 2000 and octet_length(rows::text) <= 4000000),
  saved_at timestamptz not null default now()
);
alter table public.manual_security_master enable row level security;
revoke all on public.manual_security_master from public, anon, authenticated;
grant select, insert on public.manual_security_master to authenticated;
grant update (revision, as_of, rows, saved_at) on public.manual_security_master to authenticated;
create policy master_read on public.manual_security_master for select to authenticated using ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false));
create policy master_insert on public.manual_security_master for insert to authenticated with check ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false));
create policy master_update on public.manual_security_master for update to authenticated using ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false)) with check ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false));
