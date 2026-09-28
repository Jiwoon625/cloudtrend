-- Additive migration: legacy trades and signal logs are retained unchanged.
create table if not exists public.portfolio_ledgers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision integer not null default 1 check (revision > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.portfolio_ledgers enable row level security;
revoke all on public.portfolio_ledgers from anon;
grant select, insert, update on public.portfolio_ledgers to authenticated;
grant all on public.portfolio_ledgers to service_role;
create policy portfolio_ledgers_select on public.portfolio_ledgers for select to authenticated
using ((select auth.uid()) = user_id);
create policy portfolio_ledgers_insert on public.portfolio_ledgers for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy portfolio_ledgers_update on public.portfolio_ledgers for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
