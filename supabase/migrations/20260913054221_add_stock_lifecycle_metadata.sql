create table if not exists public.stock_lifecycle_metadata (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_key text not null,
  symbol text not null,
  isin text,
  name text,
  market text,
  security_type text,
  listing_date date,
  delisting_date date,
  delisting_reason text,
  arrant_enforce_date date,
  arrant_end_date date,
  successor_symbol text,
  successor_name text,
  source text not null default 'KRX',
  source_screen text,
  raw jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_lifecycle_metadata_user_record_key unique (user_id, record_key)
);

create index if not exists stock_lifecycle_metadata_user_symbol_idx
  on public.stock_lifecycle_metadata (user_id, symbol);
create index if not exists stock_lifecycle_metadata_listing_date_idx
  on public.stock_lifecycle_metadata (listing_date);
create index if not exists stock_lifecycle_metadata_delisting_date_idx
  on public.stock_lifecycle_metadata (delisting_date);

alter table public.stock_lifecycle_metadata enable row level security;

revoke all on table public.stock_lifecycle_metadata from anon;
grant select, insert, update, delete on table public.stock_lifecycle_metadata to authenticated;
grant all on table public.stock_lifecycle_metadata to service_role;

drop policy if exists stock_lifecycle_metadata_owner_select on public.stock_lifecycle_metadata;
create policy stock_lifecycle_metadata_owner_select
  on public.stock_lifecycle_metadata for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists stock_lifecycle_metadata_owner_insert on public.stock_lifecycle_metadata;
create policy stock_lifecycle_metadata_owner_insert
  on public.stock_lifecycle_metadata for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists stock_lifecycle_metadata_owner_update on public.stock_lifecycle_metadata;
create policy stock_lifecycle_metadata_owner_update
  on public.stock_lifecycle_metadata for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists stock_lifecycle_metadata_owner_delete on public.stock_lifecycle_metadata;
create policy stock_lifecycle_metadata_owner_delete
  on public.stock_lifecycle_metadata for delete to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.stock_trading_halts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  isin text,
  name text,
  market text,
  halt_start date not null,
  resume_date date,
  halt_reason text,
  source text not null default 'KRX',
  source_screen text,
  raw jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_trading_halts_user_symbol_start unique (user_id, symbol, halt_start)
);

create index if not exists stock_trading_halts_user_symbol_idx
  on public.stock_trading_halts (user_id, symbol);
create index if not exists stock_trading_halts_period_idx
  on public.stock_trading_halts (halt_start, resume_date);

alter table public.stock_trading_halts enable row level security;

revoke all on table public.stock_trading_halts from anon;
grant select, insert, update, delete on table public.stock_trading_halts to authenticated;
grant all on table public.stock_trading_halts to service_role;

drop policy if exists stock_trading_halts_owner_select on public.stock_trading_halts;
create policy stock_trading_halts_owner_select
  on public.stock_trading_halts for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists stock_trading_halts_owner_insert on public.stock_trading_halts;
create policy stock_trading_halts_owner_insert
  on public.stock_trading_halts for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists stock_trading_halts_owner_update on public.stock_trading_halts;
create policy stock_trading_halts_owner_update
  on public.stock_trading_halts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists stock_trading_halts_owner_delete on public.stock_trading_halts;
create policy stock_trading_halts_owner_delete
  on public.stock_trading_halts for delete to authenticated
  using ((select auth.uid()) = user_id);