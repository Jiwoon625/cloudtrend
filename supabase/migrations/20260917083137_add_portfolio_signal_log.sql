create table if not exists public.portfolio_signal_log (
  user_id uuid not null,
  symbol text not null,
  signal_date date not null,
  decision text not null check (decision in ('EXECUTED','SKIPPED_CAPACITY','SKIPPED_SECTOR','SKIPPED_CASH','SKIPPED_HELD')),
  detail text,
  decided_at timestamptz not null default now(),
  primary key (user_id, symbol, signal_date)
);

alter table public.portfolio_signal_log enable row level security;
drop policy if exists portfolio_signal_log_owner on public.portfolio_signal_log;
create policy portfolio_signal_log_owner on public.portfolio_signal_log
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create index if not exists portfolio_signal_log_user_date_idx
  on public.portfolio_signal_log (user_id, signal_date desc);
