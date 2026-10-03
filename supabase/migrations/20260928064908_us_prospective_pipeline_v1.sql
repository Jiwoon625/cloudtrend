
create table if not exists public.us_screening_ingest (
  user_id uuid primary key references auth.users(id) on delete cascade,
  as_of_date date not null,
  storage_bucket text not null default 'cloudtrend-data',
  storage_path text not null,
  row_count integer not null check (row_count >= 0),
  symbol_count integer not null check (symbol_count >= 0),
  data_hash text not null check (data_hash ~ '^sha256:[0-9a-f]{64}$'),
  schema_version text not null default 'us-prospective-v1',
  source_provider text not null default 'TOSS_OPEN_API',
  collected_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.us_screening_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  data_hash text not null,
  rule_version text not null,
  summary jsonb not null default '{}'::jsonb,
  signals jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.us_strategy_registry (
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id text not null,
  label text not null,
  role text not null check (role in ('PRIMARY','SHADOW','BENCHMARK')),
  rule_version text not null,
  config jsonb not null,
  frozen_at timestamptz not null,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, strategy_id)
);

create table if not exists public.us_portfolio_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id text not null,
  date date not null,
  rule_version text not null,
  nav_usd numeric not null check (nav_usd >= 0),
  cash_usd numeric not null check (cash_usd >= 0),
  benchmark_nav numeric,
  daily_return numeric,
  cumulative_return numeric,
  turnover numeric not null default 0,
  fees_usd numeric not null default 0,
  positions_count integer not null default 0 check (positions_count >= 0),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, strategy_id, date)
);

create table if not exists public.us_portfolio_trades (
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_key text not null,
  strategy_id text not null,
  signal_date date not null,
  execution_date date,
  symbol text not null,
  name text,
  sector text,
  side text not null check (side in ('BUY','SELL','REBALANCE_BUY','REBALANCE_SELL')),
  reason text not null,
  status text not null check (status in ('PENDING','EXECUTED','PARTIAL','SKIPPED','CANCELLED')),
  model_price numeric,
  model_shares integer check (model_shares is null or model_shares >= 0),
  model_notional numeric,
  fee_usd numeric not null default 0,
  core_rank numeric,
  actual_price numeric,
  actual_shares integer check (actual_shares is null or actual_shares >= 0),
  actual_fee_usd numeric,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, trade_key)
);

create index if not exists us_screening_history_user_date_idx
  on public.us_screening_history(user_id, date desc);
create index if not exists us_portfolio_snapshots_user_strategy_date_idx
  on public.us_portfolio_snapshots(user_id, strategy_id, date desc);
create index if not exists us_portfolio_trades_user_strategy_date_idx
  on public.us_portfolio_trades(user_id, strategy_id, signal_date desc);

alter table public.us_screening_ingest enable row level security;
alter table public.us_screening_history enable row level security;
alter table public.us_strategy_registry enable row level security;
alter table public.us_portfolio_snapshots enable row level security;
alter table public.us_portfolio_trades enable row level security;

drop policy if exists us_screening_ingest_owner_select on public.us_screening_ingest;
create policy us_screening_ingest_owner_select on public.us_screening_ingest
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists us_screening_history_owner_select on public.us_screening_history;
create policy us_screening_history_owner_select on public.us_screening_history
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists us_strategy_registry_owner_select on public.us_strategy_registry;
create policy us_strategy_registry_owner_select on public.us_strategy_registry
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists us_portfolio_snapshots_owner_select on public.us_portfolio_snapshots;
create policy us_portfolio_snapshots_owner_select on public.us_portfolio_snapshots
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists us_portfolio_trades_owner_select on public.us_portfolio_trades;
create policy us_portfolio_trades_owner_select on public.us_portfolio_trades
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists us_portfolio_trades_owner_update on public.us_portfolio_trades;
create policy us_portfolio_trades_owner_update on public.us_portfolio_trades
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.us_screening_ingest from anon;
revoke all on table public.us_screening_history from anon;
revoke all on table public.us_strategy_registry from anon;
revoke all on table public.us_portfolio_snapshots from anon;
revoke all on table public.us_portfolio_trades from anon;

grant select on table public.us_screening_ingest to authenticated;
grant select on table public.us_screening_history to authenticated;
grant select on table public.us_strategy_registry to authenticated;
grant select on table public.us_portfolio_snapshots to authenticated;
grant select, update on table public.us_portfolio_trades to authenticated;

comment on table public.us_screening_ingest is 'CloudTrend US prospective screener current Toss/OpenAPI source pointer.';
comment on table public.us_screening_history is 'Compact immutable daily US prospective screening history; full latest rows live in private Storage.';
comment on table public.us_strategy_registry is 'Frozen prospective strategy definitions for A0 primary and A2/B3 shadow portfolios.';
comment on table public.us_portfolio_snapshots is 'Daily prospective NAV/state for US primary/shadow portfolios and benchmark.';
comment on table public.us_portfolio_trades is 'US prospective model trade ledger; optional actual execution fields may be manually filled by the owner.';
