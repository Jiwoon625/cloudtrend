-- Atomic KR screening source-set compaction. Existing rows and Storage bytes are
-- retained. Equivalence digests attest trusted service-side verification; SQL
-- cannot independently read/recompute Storage bytes or execute the TS analyzer.
create or replace function public.compact_screening_source_set(
  p_user_id uuid,
  p_operation_id uuid,
  p_expected_sources jsonb,
  p_candidates jsonb,
  p_verification jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
declare
  descriptor_keys constant text[] := array[
    'id', 'user_id', 'source_type', 'original_filename', 'storage_bucket',
    'storage_path', 'content_type', 'canonical_format', 'file_size_bytes',
    'normalized_size_bytes', 'file_hash', 'data_hash', 'schema_hash', 'row_count', 'min_date', 'max_date',
    'upload_source', 'created_at', 'activated_at', 'storage_object_id', 'storage_object_version'
  ];
  verification_keys constant text[] := array[
    'schema_version', 'algorithm', 'source_fingerprint', 'candidate_fingerprint',
    'dataset_before', 'dataset_after', 'analysis_before', 'analysis_after',
    'timing_before', 'timing_after', 'effective_rows_before', 'effective_rows_after', 'config_hash', 'code_version'
  ];
  evidence_keys constant text[] := array['id', 'min_date', 'max_date', 'activated_at', 'created_at'];
  original_source_evidence jsonb := '[]';
  evidence_by_id jsonb := '{}';
  evidence_group jsonb;
  evidence jsonb;
  evidence_normalized jsonb;
  evidence_actual jsonb;
  prior_evidence jsonb;
  origin_row public.analysis_source_files;
  parents jsonb := '[]';
  candidates jsonb := '[]';
  descriptor jsonb;
  normalized jsonb;
  actual_descriptor jsonb;
  source_row public.analysis_source_files;
  parent_ids uuid[];
  candidate_ids uuid[];
  active_ids uuid[];
  parent_count integer;
  candidate_count integer;
  item_index bigint;
  receipt jsonb;
  request_body jsonb;
  superseded_receipt jsonb;
  activation_base timestamptz;
  row_total numeric := 0;
  key_name text;
  storage_identity jsonb;
  is_retry boolean := false;
  affected_rows integer;
begin
  -- ACLs are the primary gate; this also fails closed after an accidental grant.
  if current_user <> 'service_role' then
    raise exception 'screening compaction requires service_role' using errcode = '42501';
  end if;
  if p_user_id is null or p_operation_id is null then
    raise exception 'screening compaction requires owner and operation ids';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_user_id then
    raise exception 'screening compaction owner mismatch' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'screening compaction requires READ COMMITTED isolation';
  end if;
  if pg_catalog.jsonb_typeof(p_expected_sources) is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_candidates) is distinct from 'array' then
    raise exception 'screening compaction source descriptors must be arrays';
  end if;
  parent_count := pg_catalog.jsonb_array_length(p_expected_sources);
  candidate_count := pg_catalog.jsonb_array_length(p_candidates);
  if parent_count < 2 or candidate_count < 1 or candidate_count >= parent_count then
    raise exception 'screening compaction must reduce a nonempty source set';
  end if;
  if pg_catalog.jsonb_typeof(p_verification) is distinct from 'object'
     or not (p_verification ?& verification_keys)
     or p_verification - verification_keys <> '{}'::jsonb
     or p_verification -> 'schema_version' is distinct from '103'::jsonb
     or p_verification ->> 'algorithm' is distinct from 'screening-compaction-v1'
     or pg_catalog.jsonb_typeof(p_verification -> 'code_version') is distinct from 'string'
     or pg_catalog.length(p_verification ->> 'code_version') not between 1 and 200 then
    raise exception 'screening compaction verification contract is invalid';
  end if;
  foreach key_name in array array['source_fingerprint', 'candidate_fingerprint',
      'dataset_before', 'dataset_after', 'analysis_before', 'analysis_after',
      'timing_before', 'timing_after', 'config_hash'] loop
    if pg_catalog.jsonb_typeof(p_verification -> key_name) is distinct from 'string'
       or (p_verification ->> key_name) !~ '^sha256:[0-9a-f]{64}$' then
      raise exception 'screening compaction verification hash is invalid: %', key_name;
    end if;
  end loop;
  if p_verification -> 'dataset_before' is distinct from p_verification -> 'dataset_after'
     or p_verification -> 'analysis_before' is distinct from p_verification -> 'analysis_after'
     or p_verification -> 'timing_before' is distinct from p_verification -> 'timing_after'
     or p_verification -> 'effective_rows_before' is distinct from p_verification -> 'effective_rows_after'
     or pg_catalog.jsonb_typeof(p_verification -> 'effective_rows_before') is distinct from 'number'
     or (p_verification ->> 'effective_rows_before') !~ '^[1-9][0-9]*$' then
    raise exception 'screening compaction equivalence verification failed';
  end if;

  for descriptor, item_index in
    select value, ordinality
    from pg_catalog.jsonb_array_elements(p_expected_sources || p_candidates) with ordinality
  loop
    if pg_catalog.jsonb_typeof(descriptor) is distinct from 'object'
       or not (descriptor ?& descriptor_keys)
       or descriptor - descriptor_keys <> '{}'::jsonb then
      raise exception 'screening compaction descriptor keys are invalid';
    end if;
    if pg_catalog.jsonb_typeof(descriptor -> 'storage_object_id') is distinct from 'string'
       or (descriptor ->> 'storage_object_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or pg_catalog.jsonb_typeof(descriptor -> 'storage_object_version') is distinct from 'string'
       or (descriptor ->> 'storage_object_version') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'screening compaction Storage generation is invalid';
    end if;
    source_row := pg_catalog.jsonb_populate_record(null::public.analysis_source_files, descriptor);
    if source_row.id is null or source_row.user_id is distinct from p_user_id
       or source_row.source_type is distinct from 'screening'
       or source_row.storage_bucket is distinct from 'cloudtrend-data'
       or source_row.canonical_format is distinct from 'csv'
       or source_row.storage_path is null
       or pg_catalog.split_part(source_row.storage_path, '/', 1) <> p_user_id::text
       or pg_catalog.split_part(source_row.storage_path, '/', 2) <> 'source'
       or pg_catalog.split_part(source_row.storage_path, '/', 3) <> 'screening'
       or pg_catalog.split_part(source_row.storage_path, '/', 4) <> source_row.id::text
       or pg_catalog.array_length(pg_catalog.string_to_array(source_row.storage_path, '/'), 1) <> 5
       or source_row.storage_path !~ '[^/]+[.]csv$'
       or source_row.storage_path ~ '(^|/)[.][.]?(/|$)'
       or source_row.storage_path ~ '[[:cntrl:]]'
       or source_row.file_hash is null or source_row.file_hash !~ '^sha256:[0-9a-f]{64}$'
       or source_row.data_hash is null or source_row.data_hash !~ '^sha256:[0-9a-f]{64}$'
       or source_row.schema_hash is null or source_row.schema_hash !~ '^sha256:[0-9a-f]{64}$'
       or source_row.file_size_bytes is null or source_row.file_size_bytes not between 1 and 47185920
       or source_row.normalized_size_bytes is null or source_row.normalized_size_bytes not between 1 and 47185920
       or source_row.row_count is null or source_row.row_count < 1
       or source_row.created_at is null then
      raise exception 'screening compaction descriptor ownership, path, integrity or size is invalid';
    end if;
    if item_index > parent_count and
       (source_row.activated_at is not null or source_row.upload_source is distinct from 'migration') then
      raise exception 'screening compaction candidates must be newly staged migration records';
    end if;
    select pg_catalog.jsonb_object_agg(k, v) into normalized
    from pg_catalog.jsonb_each(pg_catalog.to_jsonb(source_row)) as fields(k, v)
    where k = any(descriptor_keys);
    normalized := normalized || pg_catalog.jsonb_build_object(
      'storage_object_id', descriptor -> 'storage_object_id',
      'storage_object_version', descriptor -> 'storage_object_version'
    );
    if item_index <= parent_count then
      parents := parents || pg_catalog.jsonb_build_array(normalized);
    else
      candidates := candidates || pg_catalog.jsonb_build_array(normalized);
      row_total := row_total + source_row.row_count;
    end if;
  end loop;
  if row_total <> (p_verification ->> 'effective_rows_after')::numeric then
    raise exception 'screening compaction candidate row count differs from verified dataset';
  end if;
  select pg_catalog.array_agg((value ->> 'id')::uuid order by ordinality) into parent_ids
  from pg_catalog.jsonb_array_elements(parents) with ordinality;
  select pg_catalog.array_agg((value ->> 'id')::uuid order by ordinality) into candidate_ids
  from pg_catalog.jsonb_array_elements(candidates) with ordinality;
  if (select pg_catalog.count(distinct id) from pg_catalog.unnest(parent_ids || candidate_ids) id)
       <> parent_count + candidate_count then
    raise exception 'screening compaction ids must be unique and disjoint';
  end if;

  -- A brief table write barrier also closes phantom INSERT/direct UPDATE races
  -- from legacy writers that do not take the per-owner advisory lock. NOWAIT
  -- avoids lock inversion with the existing row-first activation RPC. Retry
  -- only the identical operation after SQLSTATE 55P03; never relax verification.
  lock table public.analysis_source_files in share row exclusive mode nowait;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':screening', 0)
  ) then
    raise exception 'screening source set is busy; retry identical operation' using errcode = '55P03';
  end if;
  perform id from public.analysis_source_files
  where id = any(parent_ids || candidate_ids) order by id for update nowait;

  -- Lock Storage generation metadata to close overwrite/deletion races during
  -- cutover. Storage operations are never issued by this function.
  perform id from storage.buckets where id = 'cloudtrend-data' and public = false for share nowait;
  if not found then
    raise exception 'screening compaction requires the existing private bucket';
  end if;
  perform o.id from storage.objects o
  join pg_catalog.jsonb_to_recordset(parents || candidates) as d(storage_bucket text, storage_path text)
    on o.bucket_id = d.storage_bucket and o.name = d.storage_path
  order by o.id for update of o nowait;

  request_body := pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id, 'user_id', p_user_id, 'source_type', 'screening',
    'parents', parents, 'candidates', candidates, 'verification', p_verification
  );
  select validation_result -> 'screeningCompaction' into receipt
  from public.analysis_source_files where id = candidate_ids[1];
  if receipt is not null then
    if receipt -> 'request' is distinct from request_body then
      raise exception 'screening compaction operation or candidate receipt conflicts';
    end if;
    is_retry := true;
    activation_base := (receipt ->> 'committed_at')::timestamptz;
    if activation_base is null then
      raise exception 'screening compaction receipt activation is missing';
    end if;
    receipt := receipt - 'candidate_order';
  elsif exists (
    select 1 from public.analysis_source_files
    where user_id = p_user_id and (
      validation_result #>> '{screeningCompaction,request,operation_id}' = p_operation_id::text
      or validation_result #>> '{screeningCompactionSuperseded,operation_id}' = p_operation_id::text
    )
  ) then
    raise exception 'screening compaction operation id was already used';
  end if;

  select coalesce(pg_catalog.array_agg(id order by activated_at nulls first, created_at, id), array[]::uuid[])
  into active_ids from public.analysis_source_files
  where user_id = p_user_id and source_type = 'screening' and status = 'active';
  if active_ids is distinct from (case when is_retry then candidate_ids else parent_ids end) then
    raise exception 'screening compaction active source set is stale or unexpected';
  end if;
  -- Old readers did not use id as a tie-breaker; reject unknowable precedence.
  if exists (
    select 1 from pg_catalog.jsonb_to_recordset(parents)
      as p(activated_at timestamptz, created_at timestamptz)
    group by activated_at, created_at having pg_catalog.count(*) > 1
  ) then
    raise exception 'screening compaction original source ordering is ambiguous';
  end if;

  -- Preserve collection/registration evidence, never substitute this cutover's
  -- activation time. Repeated compactions flatten prior evidence to retained raw
  -- origin rows, in first-encounter order. All evidence is checked against those
  -- authoritative rows while the registry write barrier is held.
  for descriptor in select value from pg_catalog.jsonb_array_elements(parents) loop
    select * into source_row from public.analysis_source_files
    where id = (descriptor ->> 'id')::uuid;
    if source_row.id is null then
      raise exception 'screening compaction source record is missing';
    end if;
    if source_row.validation_result ? 'screeningCompaction' then
      evidence_group := source_row.validation_result #> '{screeningCompaction,original_source_evidence}';
      if pg_catalog.jsonb_typeof(evidence_group) is distinct from 'array' then
        raise exception 'screening compaction inherited original timing evidence is missing';
      end if;
      if pg_catalog.jsonb_array_length(evidence_group) = 0 then
        raise exception 'screening compaction inherited original timing evidence is empty';
      end if;
    else
      select pg_catalog.jsonb_build_array(pg_catalog.jsonb_object_agg(k, v)) into evidence_group
      from pg_catalog.jsonb_each(pg_catalog.to_jsonb(source_row)) as fields(k, v)
      where k = any(evidence_keys);
    end if;
    for evidence in select value from pg_catalog.jsonb_array_elements(evidence_group) loop
      if pg_catalog.jsonb_typeof(evidence) is distinct from 'object'
         or not (evidence ?& evidence_keys)
         or evidence - evidence_keys <> '{}'::jsonb then
        raise exception 'screening compaction original timing evidence keys are invalid';
      end if;
      origin_row := pg_catalog.jsonb_populate_record(null::public.analysis_source_files, evidence);
      if origin_row.id is null or origin_row.created_at is null then
        raise exception 'screening compaction original timing identity is invalid';
      end if;
      select pg_catalog.jsonb_object_agg(k, v) into evidence_normalized
      from pg_catalog.jsonb_each(pg_catalog.to_jsonb(origin_row)) as fields(k, v)
      where k = any(evidence_keys);
      prior_evidence := evidence_by_id -> origin_row.id::text;
      if prior_evidence is not null and prior_evidence is distinct from evidence_normalized then
        raise exception 'screening compaction original timing evidence conflicts for duplicate origin';
      end if;
      select * into origin_row from public.analysis_source_files
      where id = origin_row.id and user_id = p_user_id and source_type = 'screening'
      for update nowait;
      if origin_row.id is null then
        raise exception 'screening compaction original timing source is missing or belongs to another owner';
      end if;
      if origin_row.validation_result ? 'screeningCompaction' then
        raise exception 'screening compaction timing evidence must resolve to original sources';
      end if;
      select pg_catalog.jsonb_object_agg(k, v) into evidence_actual
      from pg_catalog.jsonb_each(pg_catalog.to_jsonb(origin_row)) as fields(k, v)
      where k = any(evidence_keys);
      if evidence_actual is distinct from evidence_normalized then
        raise exception 'screening compaction original timing evidence differs from authoritative source';
      end if;
      if prior_evidence is null then
        evidence_by_id := evidence_by_id || pg_catalog.jsonb_build_object(origin_row.id::text, evidence_actual);
        original_source_evidence := original_source_evidence || pg_catalog.jsonb_build_array(evidence_actual);
      end if;
    end loop;
  end loop;
  if is_retry and receipt -> 'original_source_evidence' is distinct from original_source_evidence then
    raise exception 'screening compaction committed original timing evidence changed';
  end if;

  if not is_retry then
    activation_base := pg_catalog.clock_timestamp();
    receipt := pg_catalog.jsonb_build_object(
      'version', 1, 'request', request_body, 'committed_at', activation_base,
      'original_source_evidence', original_source_evidence,
      'parent_ids', pg_catalog.to_jsonb(parent_ids), 'candidate_ids', pg_catalog.to_jsonb(candidate_ids)
    );
  end if;
  superseded_receipt := pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id, 'committed_at', activation_base,
    'candidate_ids', pg_catalog.to_jsonb(candidate_ids),
    'source_fingerprint', p_verification -> 'source_fingerprint',
    'dataset_digest', p_verification -> 'dataset_after',
    'analysis_digest', p_verification -> 'analysis_after',
    'timing_digest', p_verification -> 'timing_after'
  );

  for descriptor, item_index in
    select value, ordinality from pg_catalog.jsonb_array_elements(parents || candidates) with ordinality
  loop
    select * into source_row from public.analysis_source_files where id = (descriptor ->> 'id')::uuid;
    if source_row.id is null then
      raise exception 'screening compaction source record is missing';
    end if;
    if pg_catalog.jsonb_typeof(source_row.validation_result) is distinct from 'object' then
      raise exception 'screening compaction source validation metadata must be an object';
    end if;
    select pg_catalog.jsonb_object_agg(k, v) into actual_descriptor
    from pg_catalog.jsonb_each(pg_catalog.to_jsonb(source_row)) as fields(k, v)
    where k = any(descriptor_keys);
    select pg_catalog.jsonb_build_object('storage_object_id', o.id, 'storage_object_version', o.version)
    into storage_identity from storage.objects o
    where o.bucket_id = source_row.storage_bucket and o.name = source_row.storage_path;
    if storage_identity is null then
      raise exception 'screening compaction Storage object is missing';
    end if;
    actual_descriptor := actual_descriptor || storage_identity;
    if is_retry and item_index > parent_count then
      actual_descriptor := actual_descriptor || '{"activated_at":null}'::jsonb;
    end if;
    if actual_descriptor is distinct from descriptor then
      raise exception 'screening compaction descriptor changed for source %', source_row.id;
    end if;
    if item_index <= parent_count then
      if source_row.status is distinct from (case when is_retry then 'superseded' else 'active' end)
         or source_row.superseded_by is distinct from (case when is_retry then candidate_ids[1] else null::uuid end)
         or (is_retry and source_row.validation_result -> 'screeningCompactionSuperseded' is distinct from superseded_receipt) then
        raise exception 'screening compaction parent state or provenance changed';
      end if;
    else
      if source_row.status is distinct from (case when is_retry then 'active' else 'valid' end)
         or source_row.superseded_by is not null
         or source_row.validation_result -> 'valid' is distinct from 'true'::jsonb
         or source_row.validation_result #>> '{hashes,file}' is distinct from source_row.file_hash
         or source_row.validation_result #>> '{hashes,data}' is distinct from source_row.data_hash
         or source_row.validation_result #>> '{hashes,schema}' is distinct from source_row.schema_hash
         or source_row.validation_result ? 'screeningCompactionSuperseded' then
        raise exception 'screening compaction candidate state or validation changed';
      end if;
      if is_retry then
        if source_row.activated_at is distinct from activation_base + (item_index - parent_count - 1) * interval '1 microsecond'
           or source_row.validation_result -> 'screeningCompaction' is distinct from
              receipt || pg_catalog.jsonb_build_object('candidate_order', item_index - parent_count - 1) then
          raise exception 'screening compaction committed candidate provenance changed';
        end if;
      elsif source_row.validation_result ? 'screeningCompaction' then
        raise exception 'screening compaction candidate already has a receipt';
      end if;
    end if;
  end loop;

  if not is_retry then
    update public.analysis_source_files
    set status = 'superseded', superseded_by = candidate_ids[1],
        validation_result = validation_result || pg_catalog.jsonb_build_object('screeningCompactionSuperseded', superseded_receipt)
    where id = any(parent_ids);
    get diagnostics affected_rows = row_count;
    if affected_rows <> parent_count then
      raise exception 'screening compaction parent update was incomplete';
    end if;
    -- Parent created_at/activated_at and their original validation are retained.
    for item_index in 1..candidate_count loop
      update public.analysis_source_files
      set status = 'active', superseded_by = null,
          activated_at = activation_base + (item_index - 1) * interval '1 microsecond',
          validation_result = validation_result || pg_catalog.jsonb_build_object(
            'screeningCompaction', receipt || pg_catalog.jsonb_build_object('candidate_order', item_index - 1)
          )
      where id = candidate_ids[item_index];
      get diagnostics affected_rows = row_count;
      if affected_rows <> 1 then
        raise exception 'screening compaction candidate update was incomplete';
      end if;
    end loop;
    select coalesce(pg_catalog.array_agg(id order by activated_at nulls first, created_at, id), array[]::uuid[])
    into active_ids from public.analysis_source_files
    where user_id = p_user_id and source_type = 'screening' and status = 'active';
    if active_ids is distinct from candidate_ids or exists (
      select 1 from public.analysis_source_files where id = any(parent_ids)
      and (status <> 'superseded' or superseded_by is distinct from candidate_ids[1])
    ) then
      raise exception 'screening compaction final source set is inconsistent';
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id, 'user_id', p_user_id, 'source_type', 'screening',
    'parent_ids', pg_catalog.to_jsonb(parent_ids), 'candidate_ids', pg_catalog.to_jsonb(candidate_ids),
    'committed_at', activation_base, 'verification', p_verification, 'reused', is_retry,
    'original_source_evidence', original_source_evidence
  );
end;
$$;

revoke execute on function public.compact_screening_source_set(uuid, uuid, jsonb, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.compact_screening_source_set(uuid, uuid, jsonb, jsonb, jsonb)
to service_role;

comment on function public.compact_screening_source_set(uuid, uuid, jsonb, jsonb, jsonb) is
'Atomic service-only screening compaction; exact source CAS, verified canonical103 digests, immutable raw retention, candidate provenance and retry receipt. SQL trusts caller byte verification.';
