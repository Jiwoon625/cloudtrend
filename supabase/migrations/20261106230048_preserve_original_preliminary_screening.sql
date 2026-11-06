-- Owner-approved original preliminary evidence; confirmed history is untouched.
create table public.screening_recovery_evidence (
  user_id uuid not null references auth.users(id),
  run_id text not null check (length(run_id) between 1 and 256),
  date date not null,
  market text not null check (market = 'KR'),
  strategy_version text not null,
  calculated_at timestamptz not null,
  created_at timestamptz not null default now(),
  publication_phase text not null check (publication_phase = 'PRELIMINARY'),
  source_path text not null,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_bytes bigint not null check (source_bytes > 0 and source_bytes <= 83886080),
  source_code_version text not null check (source_code_version ~ '^[a-f0-9]{40}$'),
  snapshot jsonb not null,
  primary key (user_id, run_id),
  check (source_path = user_id::text || '/results/screening/' || run_id || '.json'),
  check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 33554432),
  check (coalesce(snapshot->>'runId' = run_id and snapshot->>'asOfDate' = date::text
    and snapshot->>'market' = market and snapshot->>'strategyVersion' = strategy_version
    and (snapshot->>'savedAt')::timestamptz = calculated_at, false))
);
alter table public.screening_recovery_evidence enable row level security;
revoke all on public.screening_recovery_evidence from public, anon, authenticated, service_role;
grant select on public.screening_recovery_evidence to authenticated;
grant select, insert on public.screening_recovery_evidence to service_role;
create policy screening_recovery_owner_read on public.screening_recovery_evidence
  for select to authenticated using ((select auth.uid()) = user_id);
comment on table public.screening_recovery_evidence is
  'Original preliminary execution evidence recovered by approval. Never a confirmed history or ledger input.';
