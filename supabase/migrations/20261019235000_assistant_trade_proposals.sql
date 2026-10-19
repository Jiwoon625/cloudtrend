-- Assistant-facing evidence inbox. No actual ledger authorization is delegated.
-- Review is performed only through the existing authenticated owner CAS endpoint.
begin;
create table if not exists public.assistant_trade_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_page_id uuid not null,
  trade jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','RECORDED','REJECTED')),
  ledger_execution_id text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique(user_id,source_page_id),
  check (jsonb_typeof(trade)='object'),
  check ((status='RECORDED')=(ledger_execution_id is not null)),
  check ((status='PENDING')=(reviewed_at is null))
);
create index if not exists assistant_trade_proposals_owner_status
  on public.assistant_trade_proposals(user_id,status,created_at desc);
alter table public.assistant_trade_proposals enable row level security;
revoke all on public.assistant_trade_proposals from public, anon, authenticated;
grant select on public.assistant_trade_proposals to authenticated;
create policy assistant_trade_proposals_owner_read
  on public.assistant_trade_proposals for select to authenticated
  using (user_id = (select auth.uid()));
-- No authenticated INSERT/UPDATE/DELETE policies. Trusted server stages and
-- marks proposals only; the actual journal is written with the owner's JWT.
commit;
