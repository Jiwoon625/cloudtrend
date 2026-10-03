create table public.us_actual_portfolio_ledgers (
user_id uuid primary key references auth.users(id) on delete cascade,
revision integer not null default 1 check(revision>0),
payload jsonb not null check(jsonb_typeof(payload)='object'),
updated_at timestamptz not null default now());
alter table public.us_actual_portfolio_ledgers enable row level security;
revoke all on public.us_actual_portfolio_ledgers from anon, authenticated;
grant select,insert,update on public.us_actual_portfolio_ledgers to authenticated;
grant all on public.us_actual_portfolio_ledgers to service_role;
create policy us_actual_select on public.us_actual_portfolio_ledgers for select to authenticated using((select auth.uid())=user_id);
create policy us_actual_insert on public.us_actual_portfolio_ledgers for insert to authenticated with check((select auth.uid())=user_id);
create policy us_actual_update on public.us_actual_portfolio_ledgers for update to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create view public.us_a0_entry_signals with(security_invoker=true) as
select h.user_id,h.date,s->>'symbol' as symbol,coalesce(s->>'name',s->>'symbol') as name
from public.us_screening_history h cross join lateral jsonb_array_elements(h.signals) s where s->>'a0Entry'='true';
revoke all on public.us_a0_entry_signals from anon,authenticated;
grant select on public.us_a0_entry_signals to authenticated,service_role;