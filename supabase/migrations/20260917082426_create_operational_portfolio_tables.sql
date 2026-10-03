create table if not exists public.portfolio_settings (
  user_id uuid primary key,
  initial_capital numeric(18,2) not null default 10000000 check (initial_capital > 0),
  max_positions integer not null default 30 check (max_positions between 1 and 100),
  sector_cap numeric(6,4) not null default 0.30 check (sector_cap > 0 and sector_cap <= 1),
  round_trip_cost_rate numeric(8,6) not null default 0.003 check (round_trip_cost_rate >= 0 and round_trip_cost_rate < 0.1),
  updated_at timestamptz not null default now()
);

alter table public.portfolio_settings enable row level security;
drop policy if exists portfolio_settings_owner on public.portfolio_settings;
create policy portfolio_settings_owner on public.portfolio_settings
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.portfolio_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  symbol text not null,
  name text not null,
  market text not null check (market in ('KOSPI','KOSDAQ','ETF')),
  sector_code text not null default '',
  sector_name text not null default '',
  signal_date date not null,
  entry_date date not null,
  entry_price numeric(18,4) not null check (entry_price > 0),
  entry_technical_points numeric(8,4),
  entry_priority_points numeric(8,4),
  entry_status text not null,
  target_weight numeric(10,8) not null check (target_weight > 0 and target_weight <= 1),
  target_amount numeric(18,2) not null check (target_amount > 0),
  shares integer not null check (shares > 0),
  buy_amount numeric(18,2) not null check (buy_amount > 0),
  entry_fee numeric(18,2) not null default 0,
  mark_date date,
  current_price numeric(18,4),
  current_technical_points numeric(8,4),
  current_priority_points numeric(8,4),
  current_status text,
  holding_days integer not null default 1 check (holding_days >= 0),
  exit_signal_date date,
  exit_date date,
  exit_price numeric(18,4),
  exit_reason text,
  exit_fee numeric(18,2) not null default 0,
  realized_pnl numeric(18,2),
  realized_return numeric(12,6),
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol, signal_date)
);

alter table public.portfolio_trades enable row level security;
drop policy if exists portfolio_trades_owner on public.portfolio_trades;
create policy portfolio_trades_owner on public.portfolio_trades
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create index if not exists portfolio_trades_user_status_idx
  on public.portfolio_trades (user_id, status, entry_date desc);
create index if not exists portfolio_trades_user_signal_idx
  on public.portfolio_trades (user_id, signal_date desc);
