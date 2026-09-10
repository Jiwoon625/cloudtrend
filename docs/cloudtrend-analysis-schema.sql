-- GPT/GitHub Actions 분석 실행 요약 저장소.
-- 상세 결과는 private Storage의 <uid>/analysis/... 경로에 저장하고,
-- 이 테이블에는 대화형 조회에 필요한 요약과 재현성 메타데이터만 보관한다.

create table if not exists public.analysis_runs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('BACKTEST', 'SCREENING')),
  status text not null check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
  run_key text not null,
  requested_by text not null check (char_length(requested_by) <= 100),
  code_version text not null,
  data_version text not null,
  config jsonb not null check (octet_length(config::text) <= 262144),
  summary jsonb not null check (octet_length(summary::text) <= 2097152),
  as_of_date date,
  result_path text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error text check (error is null or char_length(error) <= 4000)
);

alter table public.analysis_runs enable row level security;

revoke all on public.analysis_runs from anon, authenticated;
grant select on public.analysis_runs to authenticated;
grant select, insert, update, delete on public.analysis_runs to service_role;

drop policy if exists analysis_runs_owner_select on public.analysis_runs;
create policy analysis_runs_owner_select
on public.analysis_runs
for select
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists analysis_runs_user_created_idx
on public.analysis_runs (user_id, created_at desc);

create index if not exists analysis_runs_reuse_idx
on public.analysis_runs (user_id, kind, run_key, status, created_at desc);

comment on table public.analysis_runs is
'CloudTrend trusted automation run metadata and GPT-readable summaries; detailed bundles remain in private Storage.';
