-- REVIEW DRAFT ONLY. This file is not an applied/generated migration.
-- Local Supabase/Postgres verification and explicit production approval precede application.
-- Existing public tables, grants, RLS, Storage objects and 90-date UI retention are untouched.
-- No raw broker receipts or private user data belong in this repository.
begin;

create table public.ledger_security_versions (
  user_id uuid not null,
  security_id text not null,
  revision integer not null check (revision > 0),
  symbol text not null,
  market text not null check (market in ('KOSPI','KOSDAQ','US')),
  currency text not null check (currency in ('KRW','USD')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, security_id, revision),
  check ((market = 'US' and currency = 'USD') or (market <> 'US' and currency = 'KRW')),
  check (market = 'US' or symbol ~ '^[A-Z0-9]{6}$')
);

-- A source record maps to exactly one canonical event, while corrections retain its identity.
create table public.ledger_event_sources (
  user_id uuid not null,
  book text not null check (book in ('ACTUAL','MODEL')),
  book_id text not null,
  source_system text not null,
  source_record_id text not null,
  event_id text not null,
  recorded_at timestamptz not null default now(),
  primary key (user_id, book, book_id, source_system, source_record_id),
  unique (user_id, book, book_id, source_system, source_record_id, event_id),
  check ((book = 'ACTUAL' and book_id = 'ACTUAL') or (book = 'MODEL' and book_id <> 'ACTUAL'))
);

-- Raw event revisions are append-only. Corrections/voids append a new version, never UPDATE/DELETE.
create table public.ledger_event_versions (
  user_id uuid not null,
  book text not null check (book in ('ACTUAL','MODEL')),
  book_id text not null,
  event_id text not null,
  revision integer not null check (revision > 0),
  previous_revision integer,
  correction_reason text,
  effective_date date not null,
  event_kind text not null check (event_kind in ('BUY','SELL','DIVIDEND','INTEREST','FEE','TAX','DEPOSIT','WITHDRAWAL','FX','TRANSFER','CORPORATE_ACTION')),
  source_system text not null,
  source_record_id text not null,
  source_revision text not null,
  content_hash text not null check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, book, book_id, event_id, revision),
  foreign key (user_id, book, book_id, source_system, source_record_id, event_id)
    references public.ledger_event_sources(user_id, book, book_id, source_system, source_record_id, event_id),
  foreign key (user_id, book, book_id, event_id, previous_revision)
    references public.ledger_event_versions(user_id, book, book_id, event_id, revision),
  check ((book = 'ACTUAL' and book_id = 'ACTUAL') or (book = 'MODEL' and book_id <> 'ACTUAL')),
  check ((revision = 1 and previous_revision is null and correction_reason is null) or
         (revision > 1 and previous_revision is not null and previous_revision = revision - 1 and correction_reason is not null and length(trim(correction_reason)) > 0))
);
create index ledger_events_date_idx on public.ledger_event_versions(user_id, book, book_id, effective_date);
create index ledger_events_source_idx on public.ledger_event_versions(user_id, source_system, source_record_id);

create table public.ledger_evidence_refs (
  user_id uuid not null,
  evidence_id text not null,
  revision integer not null check (revision > 0),
  locator text not null,
  sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, evidence_id, revision)
);

-- Includes source links, duplicate/conflict quarantine decisions and broker reconciliation.
create table public.ledger_reconciliation_log (
  user_id uuid not null,
  reconciliation_id text not null,
  revision integer not null check (revision > 0),
  status text not null check (status in ('PENDING','QUARANTINED','MATCHED','RESOLVED')),
  reason text not null,
  actor text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, reconciliation_id, revision)
);

-- Each revision pins input event revisions, prices, FX, source/code/config hashes and missingness.
create table public.ledger_valuation_versions (
  user_id uuid not null,
  book text not null check (book in ('ACTUAL','MODEL')),
  book_id text not null,
  valuation_date date not null,
  revision integer not null check (revision > 0),
  content_hash text not null check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, book, book_id, valuation_date, revision),
  check ((book = 'ACTUAL' and book_id = 'ACTUAL') or (book = 'MODEL' and book_id <> 'ACTUAL'))
);

create table public.ledger_model_series (
  user_id uuid not null,
  series_id text not null,
  strategy_id text not null,
  role text not null check (role in ('ADOPTED_SHADOW','ALTERNATIVE_SHADOW','ALLOCATOR_SHADOW')),
  scheduled_start date not null,
  config_hash text not null check (config_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, series_id)
);

create table public.ledger_model_sessions (
  user_id uuid not null,
  series_id text not null,
  session_date date not null,
  previous_session_date date,
  state_hash text not null check (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, series_id, session_date),
  foreign key (user_id, series_id) references public.ledger_model_series(user_id, series_id),
  foreign key (user_id, series_id, previous_session_date) references public.ledger_model_sessions(user_id, series_id, session_date),
  check (previous_session_date is null or previous_session_date < session_date)
);

-- Append-only user-requested receipt recording status. The assistant verifies each destination; no automatic delivery or scheduled retry.
create table public.ledger_recording_log (
  user_id uuid not null,
  task_key text not null,
  revision integer not null check (revision > 0),
  status text not null check (status in ('PENDING','PARTIAL','CONFLICT','VERIFIED')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, task_key, revision)
);

-- Future archive ingestion is separate from screening_history's existing 90-date UI trigger.
-- This table by itself does not archive anything and must not be reported as active retention.
create table public.ledger_provenance_archive (
  user_id uuid not null,
  source_id text not null,
  source_revision text not null,
  source_hash text not null check (source_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (user_id, source_id, source_revision, source_hash)
);

-- SECURITY INVOKER, empty search_path, no auth bypass or public callable privileged functions.
create function public.ledger_reject_mutation() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Ledger history is append-only; append an audited correction';
end;
$$;
revoke all on function public.ledger_reject_mutation() from public, anon, authenticated;
grant execute on function public.ledger_reject_mutation() to service_role;

do $$
declare t text;
begin
  foreach t in array array['ledger_security_versions','ledger_event_sources','ledger_event_versions','ledger_evidence_refs',
    'ledger_reconciliation_log','ledger_valuation_versions','ledger_model_series','ledger_model_sessions','ledger_recording_log','ledger_provenance_archive']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert on public.%I to service_role', t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create trigger immutable_history before update or delete on public.%I for each row execute function public.ledger_reject_mutation()', t);
  end loop;
end;
$$;

-- Atomic service-only event+assisted-recording status append. Must be locally verified before applying.
-- Review authorization and validateEvent are required in the trusted server caller.
create function public.ledger_append_reviewed_event(
  p_user_id uuid, p_expected_revision integer, p_event jsonb, p_recording_task jsonb default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_book text := p_event->>'book';
  v_book_id text := p_event->>'bookId';
  v_id text := p_event->>'id';
  v_revision integer := (p_event->>'revision')::integer;
  v_head integer;
  v_previous public.ledger_event_versions%rowtype;
  v_existing jsonb;
  v_source_event text;
begin
  if p_user_id is null or p_expected_revision is null or p_expected_revision < 0
     or v_id is null or v_book is null or v_book_id is null or v_revision is null
     or v_revision <> p_expected_revision + 1 then
    raise exception 'Invalid reviewed append identity/revision';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':' || v_book || ':' || v_book_id || ':' || v_id, 0));
  select payload into v_existing from public.ledger_event_versions
    where user_id=p_user_id and book=v_book and book_id=v_book_id and event_id=v_id and revision=v_revision;
  if found then
    if v_existing <> p_event then raise exception 'Immutable event revision conflict'; end if;
    -- An explicitly repeated request reuses the existing event and initial tracking record.
    if p_recording_task is not null and not exists (
      select 1 from public.ledger_recording_log where user_id=p_user_id
        and task_key=p_recording_task->>'key' and revision=1 and payload=p_recording_task
    ) then raise exception 'Repeated recording task mismatch'; end if;
    return jsonb_build_object('reused', true, 'revision', v_revision);
  end if;
  select coalesce(max(revision),0) into v_head from public.ledger_event_versions
    where user_id=p_user_id and book=v_book and book_id=v_book_id and event_id=v_id;
  if v_head <> p_expected_revision then raise exception 'Concurrent ledger revision conflict'; end if;
  if v_head > 0 then
    select * into strict v_previous from public.ledger_event_versions
      where user_id=p_user_id and book=v_book and book_id=v_book_id and event_id=v_id and revision=v_head;
    if v_previous.source_system <> p_event#>>'{source,system}' or
       v_previous.source_record_id <> p_event#>>'{source,recordId}' then
      raise exception 'Correction must preserve original source identity';
    end if;
  end if;
  insert into public.ledger_event_sources(user_id,book,book_id,source_system,source_record_id,event_id)
    values(p_user_id,v_book,v_book_id,p_event#>>'{source,system}',p_event#>>'{source,recordId}',v_id)
    on conflict do nothing;
  select event_id into strict v_source_event from public.ledger_event_sources
    where user_id=p_user_id and book=v_book and book_id=v_book_id
      and source_system=p_event#>>'{source,system}' and source_record_id=p_event#>>'{source,recordId}';
  if v_source_event <> v_id then raise exception 'Source already belongs to another canonical event'; end if;
  insert into public.ledger_event_versions(user_id,book,book_id,event_id,revision,previous_revision,
    correction_reason,effective_date,event_kind,source_system,source_record_id,source_revision,content_hash,payload,recorded_at)
  values(p_user_id,v_book,v_book_id,v_id,v_revision,(p_event->>'previousRevision')::integer,
    p_event->>'correctionReason',(p_event->>'effectiveDate')::date,p_event->>'kind',
    p_event#>>'{source,system}',p_event#>>'{source,recordId}',p_event#>>'{source,revision}',
    p_event#>>'{source,contentHash}',p_event,(p_event->>'recordedAt')::timestamptz);
  if p_recording_task is not null then
    if v_book <> 'ACTUAL' or p_recording_task->>'key' is distinct from ('RECEIPT:' || v_id || ':' || v_revision::text) or
       coalesce(length(trim(p_recording_task->>'requestRef')),0) = 0 or p_recording_task->>'eventId' is distinct from v_id or
       (p_recording_task->>'eventRevision')::integer is distinct from v_revision or
       p_recording_task->>'sourceHash' is distinct from p_event#>>'{source,contentHash}' or
       p_recording_task->>'status' is distinct from 'PENDING' then
      raise exception 'Recording task does not match appended actual event';
    end if;
    insert into public.ledger_recording_log(user_id,task_key,revision,status,payload)
      values(p_user_id,p_recording_task->>'key',1,'PENDING',p_recording_task);
  end if;
  return jsonb_build_object('reused', false, 'revision', v_revision);
end;
$$;
revoke all on function public.ledger_append_reviewed_event(uuid,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ledger_append_reviewed_event(uuid,integer,jsonb,jsonb) to service_role;

-- Stable single-statement snapshot: RLS applies because this function is SECURITY INVOKER.
create function public.ledger_read_events(p_user_id uuid, p_book text, p_book_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(payload order by effective_date,event_id,revision),'[]'::jsonb)
  from public.ledger_event_versions where user_id=p_user_id and book=p_book and book_id=p_book_id;
$$;
revoke all on function public.ledger_read_events(uuid,text,text) from public,anon,authenticated;
grant execute on function public.ledger_read_events(uuid,text,text) to authenticated,service_role;

-- One transaction and one lock per series, not one lock per date: no cross-date race/fork.
create function public.ledger_append_model_session(p_user_id uuid,p_series jsonb,p_run jsonb,p_previous_date date,p_previous_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_series text := p_series->>'bookId';
  v_date date := (p_run#>>'{receipt,date}')::date;
  v_saved jsonb;
  v_latest public.ledger_model_sessions%rowtype;
begin
  if p_user_id is null or v_series is null or v_date is null or p_run->>'book' is distinct from 'MODEL'
     or p_run->>'bookId' is distinct from v_series or p_run->>'contractHash' is distinct from p_series->>'contractHash'
     or p_run#>>'{receipt,codeHash}' is distinct from p_series->>'codeHash'
     or p_run#>>'{receipt,configHash}' is distinct from p_series->>'configHash'
     or p_run->>'previousStateHash' is distinct from p_previous_hash
     or v_date < (p_series->>'accountingStartDate')::date then raise exception 'Invalid frozen model append'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':MODEL:' || v_series,0));
  select payload into v_saved from public.ledger_model_series where user_id=p_user_id and series_id=v_series;
  if found then
    if v_saved <> p_series then raise exception 'Frozen model registry mismatch'; end if;
  else
    if p_previous_date is not null then raise exception 'Missing model registry'; end if;
    insert into public.ledger_model_series(user_id,series_id,strategy_id,role,scheduled_start,config_hash,payload)
    values(p_user_id,v_series,p_series#>>'{policy,kind}','ADOPTED_SHADOW',(p_series->>'accountingStartDate')::date,p_series->>'configHash',p_series);
  end if;
  select payload into v_saved from public.ledger_model_sessions where user_id=p_user_id and series_id=v_series and session_date=v_date;
  if found then
    if v_saved <> p_run then raise exception 'Immutable model date conflict'; end if;
    return jsonb_build_object('reused',true,'stateHash',p_run->>'stateHash');
  end if;
  select * into v_latest from public.ledger_model_sessions where user_id=p_user_id and series_id=v_series order by session_date desc limit 1;
  if found then
    if p_previous_date is distinct from v_latest.session_date or p_previous_hash is distinct from v_latest.state_hash or v_date <= v_latest.session_date then raise exception 'Model predecessor/head conflict'; end if;
  elsif p_previous_date is not null or p_previous_hash is not null then raise exception 'Unexpected initial model predecessor'; end if;
  insert into public.ledger_model_sessions(user_id,series_id,session_date,previous_session_date,state_hash,payload)
  values(p_user_id,v_series,v_date,p_previous_date,p_run->>'stateHash',p_run);
  return jsonb_build_object('reused',false,'stateHash',p_run->>'stateHash');
end;
$$;
revoke all on function public.ledger_append_model_session(uuid,jsonb,jsonb,date,text) from public,anon,authenticated;
grant execute on function public.ledger_append_model_session(uuid,jsonb,jsonb,date,text) to service_role;
commit;
