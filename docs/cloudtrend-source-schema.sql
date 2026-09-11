-- CloudTrend validated source-data registry.
-- Run after docs/cloud-schema.sql. The existing legacy objects remain available
-- while source/<type>/... and results/<type>/... become the canonical paths.

create table if not exists public.analysis_source_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('screening', 'backtest')),
  original_filename text not null check (char_length(original_filename) between 1 and 180),
  storage_bucket text not null default 'cloudtrend-data',
  storage_path text not null,
  content_type text not null,
  canonical_format text not null default 'csv',
  file_size_bytes bigint not null check (file_size_bytes between 0 and 47185920),
  normalized_size_bytes bigint not null check (normalized_size_bytes between 0 and 47185920),
  file_hash text not null check (file_hash ~ '^sha256:[0-9a-f]{64}$'),
  data_hash text not null check (data_hash ~ '^sha256:[0-9a-f]{64}$'),
  schema_hash text not null check (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  row_count bigint not null check (row_count >= 0),
  symbol_count integer not null check (symbol_count >= 0),
  min_date date,
  max_date date,
  market_count integer not null default 0 check (market_count >= 0),
  kospi_count integer not null default 0 check (kospi_count >= 0),
  kosdaq_count integer not null default 0 check (kosdaq_count >= 0),
  stock_count integer not null default 0 check (stock_count >= 0),
  etf_count integer not null default 0 check (etf_count >= 0),
  sector_mapped_count integer not null default 0 check (sector_mapped_count >= 0),
  sector_unmapped_count integer not null default 0 check (sector_unmapped_count >= 0),
  upload_source text not null check (upload_source in ('web', 'gpt', 'github_action', 'migration')),
  status text not null check (
    status in ('validating', 'valid', 'invalid', 'active', 'archived', 'superseded', 'deleted')
  ),
  validation_result jsonb not null default '{}'::jsonb
    check (octet_length(validation_result::text) <= 2097152),
  overlap_result jsonb check (
    overlap_result is null or octet_length(overlap_result::text) <= 1048576
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  superseded_by uuid references public.analysis_source_files(id) on delete set null,
  constraint analysis_source_files_date_order check (
    min_date is null or max_date is null or min_date <= max_date
  ),
  constraint analysis_source_files_owner_path check (
    split_part(storage_path, '/', 1) = user_id::text
  )
);

comment on table public.analysis_source_files is
'Validated CloudTrend screening/backtest source registry. Result bundles are never registered here.';

create index if not exists analysis_source_files_active_idx
on public.analysis_source_files (user_id, source_type, status, created_at);
create index if not exists analysis_source_files_file_hash_idx
on public.analysis_source_files (user_id, source_type, file_hash);
create index if not exists analysis_source_files_data_hash_idx
on public.analysis_source_files (user_id, source_type, data_hash);
create index if not exists analysis_source_files_superseded_by_idx
on public.analysis_source_files (superseded_by)
where superseded_by is not null;

create or replace function public.set_analysis_source_files_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;
revoke execute on function public.set_analysis_source_files_updated_at() from public, anon, authenticated;

drop trigger if exists set_analysis_source_files_updated_at on public.analysis_source_files;
create trigger set_analysis_source_files_updated_at
before update on public.analysis_source_files
for each row execute function public.set_analysis_source_files_updated_at();

alter table public.analysis_source_files enable row level security;
revoke all on public.analysis_source_files from anon, authenticated;
grant select, insert, update on public.analysis_source_files to authenticated;
grant select, insert, update, delete on public.analysis_source_files to service_role;

drop policy if exists analysis_source_files_owner_select on public.analysis_source_files;
create policy analysis_source_files_owner_select
on public.analysis_source_files for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists analysis_source_files_owner_insert on public.analysis_source_files;
create policy analysis_source_files_owner_insert
on public.analysis_source_files for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists analysis_source_files_owner_update on public.analysis_source_files;
create policy analysis_source_files_owner_update
on public.analysis_source_files for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.activate_analysis_source_file(
  p_source_id uuid,
  p_mode text
)
returns public.analysis_source_files
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected public.analysis_source_files;
  caller_uid uuid;
begin
  select auth.uid() into caller_uid;
  select * into selected
  from public.analysis_source_files
  where id = p_source_id
  for update;

  if selected.id is null then raise exception 'source file not found'; end if;
  if caller_uid is not null and caller_uid is distinct from selected.user_id then
    raise exception 'source owner mismatch';
  end if;
  if selected.status not in ('valid', 'active', 'archived', 'superseded') then
    raise exception 'source status cannot be activated: %', selected.status;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(selected.user_id::text || ':' || selected.source_type, 0)
  );

  if selected.source_type = 'screening' and p_mode = 'replace' then
    update public.analysis_source_files
    set status = 'superseded', superseded_by = selected.id
    where user_id = selected.user_id and source_type = 'screening'
      and status = 'active' and id <> selected.id;
  elsif selected.source_type = 'screening' and p_mode in ('append', 'merge') then
    null;
  elsif selected.source_type = 'backtest' and p_mode = 'replace_all' then
    update public.analysis_source_files
    set status = 'superseded', superseded_by = selected.id
    where user_id = selected.user_id and source_type = 'backtest'
      and status = 'active' and id <> selected.id;
  elsif selected.source_type = 'backtest' and p_mode = 'add' then
    null;
  else
    raise exception 'mode % is invalid for %', p_mode, selected.source_type;
  end if;

  update public.analysis_source_files
  set status = 'active', activated_at = coalesce(activated_at, pg_catalog.now()), superseded_by = null
  where id = selected.id
  returning * into selected;
  return selected;
end;
$$;
revoke execute on function public.activate_analysis_source_file(uuid, text) from public, anon;
grant execute on function public.activate_analysis_source_file(uuid, text) to authenticated, service_role;

update storage.buckets
set file_size_limit = 47185920,
    allowed_mime_types = array[
      'application/json',
      'text/csv',
      'text/plain',
      'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
where id = 'cloudtrend-data';

drop policy if exists cloudtrend_owner_insert_source on storage.objects;
create policy cloudtrend_owner_insert_source
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'source'
  and (storage.foldername(name))[3] in ('screening', 'backtest')
  and (storage.foldername(name))[4] ~ '^[0-9a-f-]{36}$'
  and lower(name) ~ '[.](csv|txt|json|xlsx)$'
);

drop policy if exists cloudtrend_owner_update_source on storage.objects;
create policy cloudtrend_owner_update_source
on storage.objects for update to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'source'
)
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'source'
  and (storage.foldername(name))[3] in ('screening', 'backtest')
  and (storage.foldername(name))[4] ~ '^[0-9a-f-]{36}$'
  and lower(name) ~ '[.](csv|txt|json|xlsx)$'
);

drop policy if exists cloudtrend_owner_insert_results on storage.objects;
create policy cloudtrend_owner_insert_results
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'results'
  and (storage.foldername(name))[3] in ('screening', 'backtest', 'ingestion')
  and name like '%.json'
);

drop policy if exists cloudtrend_owner_update_results on storage.objects;
create policy cloudtrend_owner_update_results
on storage.objects for update to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'results'
)
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'results'
  and (storage.foldername(name))[3] in ('screening', 'backtest', 'ingestion')
  and name like '%.json'
);

