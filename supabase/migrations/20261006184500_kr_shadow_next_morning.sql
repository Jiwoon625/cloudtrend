begin;

create or replace function public.ledger_append_own_october_model_session(
  p_run jsonb, p_previous_date date, p_previous_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_id text := p_run->>'bookId';
  v_kind text;
  v_market text;
  v_zone text;
  v_date date;
  v_first date;
  v_close time;
  v_available timestamptz;
  v_decision timestamptz;
  v_decision_session date;
  v_start date;
  v_end date;
  v_expected jsonb;
  v_receipt jsonb;
  v_receipt_json text;
  v_hash text;
  v_series public.ledger_model_series%rowtype;
  v_previous public.ledger_model_sessions%rowtype;
  v_existing public.ledger_model_sessions%rowtype;
  v_latest public.ledger_model_sessions%rowtype;
  v_next date;
begin
  if v_user is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'Authenticated non-anonymous model owner required' using errcode='42501';
  end if;
  if pg_catalog.jsonb_typeof(p_run) is distinct from 'object'
     or v_id is null or v_id !~ '^adopted-shadow-2026-10-05-v1:(KR_MIXED|KR_KOSPI|KR_KOSDAQ|US_A0|ETF_V02|US_A2|US_B3|KR_KOSPI_CONFIRM1_BEAR)$'
     or p_run->>'book' is distinct from 'MODEL' then
    raise exception 'Only the eight October MODEL series are allowed';
  end if;
  -- Same lock as the existing append RPC: ownership/registry/head validation and
  -- delegation below are one serialized transaction, including cross-date races.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text || ':MODEL:' || v_id,0));
  select * into v_series from public.ledger_model_series where user_id=v_user and series_id=v_id;
  if not found then raise exception 'Existing owner October registry required' using errcode='42501'; end if;
  v_kind := pg_catalog.split_part(v_id,':',2);
  v_market := case when v_kind in ('US_A0','US_A2','US_B3') then 'US' else 'KR' end;
  v_zone := case when v_market='US' then 'America/New_York' else 'Asia/Seoul' end;
  v_first := case when v_market='US' then date '2026-10-05' else date '2026-10-06' end;
  if p_run ? 'publicationArtifact' then
    return public.ledger_append_model_session(v_user,v_series.payload,p_run,p_previous_date,p_previous_hash);
  end if;
  if v_series.strategy_id is distinct from v_kind
     or v_series.role is distinct from (case when v_kind in ('US_A2','US_B3','KR_KOSPI_CONFIRM1_BEAR') then 'ALTERNATIVE_SHADOW' else 'ADOPTED_SHADOW' end)
     or v_series.scheduled_start is distinct from date '2026-10-05'
     or v_series.payload->>'book' is distinct from 'MODEL'
     or v_series.payload->>'bookId' is distinct from v_id
     or v_series.payload->>'version' is distinct from 'adopted-shadow-2026-10-05-v1'
     or v_series.payload->>'accountingStartDate' is distinct from '2026-10-05'
     or v_series.payload#>>'{policy,kind}' is distinct from v_kind
     or v_series.payload#>>'{policy,market}' is distinct from v_market
     or v_series.config_hash is distinct from v_series.payload->>'configHash'
     or p_run->>'contractHash' is distinct from v_series.payload->>'contractHash'
     or p_run#>>'{receipt,book}' is distinct from 'MODEL'
     or p_run#>>'{receipt,bookId}' is distinct from v_id
     or p_run#>>'{receipt,contractHash}' is distinct from v_series.payload->>'contractHash'
     or p_run#>>'{receipt,configHash}' is distinct from v_series.config_hash
     or p_run#>>'{receipt,codeHash}' is distinct from v_series.payload->>'codeHash'
     or p_run->>'previousStateHash' is distinct from p_previous_hash then
    raise exception 'October frozen model identity mismatch';
  end if;
  foreach v_hash in array array[
    v_series.payload->>'contractHash',v_series.config_hash,v_series.payload->>'codeHash',v_series.payload->>'sourceHash',
    p_run->>'stateHash',p_run#>>'{receipt,sourceHash}',p_run#>>'{receipt,runHash}',
    p_run#>>'{calendar,sourceHash}',p_run#>>'{publication,inputHash}',p_run#>>'{publication,sourceHash}'
  ] loop
    if v_hash is null or v_hash !~ '^sha256:[a-f0-9]{64}$' then raise exception 'Invalid October provenance hash'; end if;
  end loop;
  if (p_previous_date is null) <> (p_previous_hash is null)
     or (p_previous_hash is not null and p_previous_hash !~ '^sha256:[a-f0-9]{64}$') then
    raise exception 'Invalid October predecessor';
  end if;
  if p_run#>>'{receipt,date}' is null or p_run#>>'{receipt,date}' !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Invalid October session date';
  end if;
  v_date := (p_run#>>'{receipt,date}')::date;
  if v_date < v_first or v_date > (v_now at time zone v_zone)::date then
    raise exception 'October session is before first regular close or in the future';
  end if;

  -- Receipt contains only seven fixed ASCII-string fields. Their canonical JSON
  -- is unambiguous across PostgreSQL and JS; never use this for arbitrary engine
  -- state JSON, where floating-point/exponent formatting differs from jsonb::text.
  v_receipt := pg_catalog.jsonb_build_object(
    'book','MODEL','bookId',v_id,'date',v_date::text,
    'contractHash',v_series.payload->>'contractHash','codeHash',v_series.payload->>'codeHash',
    'configHash',v_series.config_hash,'sourceHash',p_run#>>'{receipt,sourceHash}');
  if (p_run->'receipt')-'runHash' is distinct from v_receipt then raise exception 'Invalid October receipt fields'; end if;
  select '{' || pg_catalog.string_agg(pg_catalog.to_json(key)::text || ':' || value::text,',' order by key collate "C") || '}'
    into v_receipt_json from pg_catalog.jsonb_each(v_receipt);
  if p_run#>>'{receipt,runHash}' is distinct from 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_receipt_json,'UTF8')),'hex') then
    raise exception 'October receipt hash mismatch';
  end if;

  -- This is the reviewed Q4 exchange calendar, not a caller-selected holiday set.
  -- Extend both this guard and application evidence after reviewing later notices.
  if p_run#>>'{calendar,market}' is distinct from v_market
     or p_run#>>'{calendar,coverageStart}' is distinct from '2026-10-05'
     or p_run#>>'{calendar,coverageEnd}' is null
     or p_run#>>'{calendar,coverageEnd}' !~ '^\d{4}-\d{2}-\d{2}$'
     or pg_catalog.jsonb_typeof(p_run#>'{calendar,regularSessions}') is distinct from 'array' then
    raise exception 'Invalid October calendar';
  end if;
  v_start := date '2026-10-05';
  v_end := (p_run#>>'{calendar,coverageEnd}')::date;
  if v_end < v_date or v_end > date '2026-12-31' then raise exception 'Reviewed October calendar coverage missing'; end if;
  select coalesce(pg_catalog.jsonb_agg(d::text order by d),'[]'::jsonb) into v_expected
  from (select v_start + n as d from pg_catalog.generate_series(0,v_end-v_start) n) days
  where extract(isodow from d) <= 5
    and not (v_market='KR' and d in (date '2026-10-05',date '2026-10-09',date '2026-12-25',date '2026-12-31'))
    and not (v_market='US' and d in (date '2026-11-26',date '2026-12-25'));
  if p_run#>'{calendar,regularSessions}' is distinct from v_expected or not (v_expected ? v_date::text) then
    raise exception 'October calendar is incomplete or session is not regular';
  end if;
  if v_market='KR' and v_date=date '2026-11-19' then
    raise exception 'KR special-session hours require reviewed exchange confirmation';
  end if;

  if p_run#>>'{publication,version}' is distinct from 'october-manual-publication-v1'
     or p_run#>>'{publication,availableAt}' is null or p_run#>>'{publication,decisionAt}' is null
     or p_run#>>'{publication,availableAt}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
     or p_run#>>'{publication,decisionAt}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'Explicit October publication timestamps required';
  end if;
  v_available := (p_run#>>'{publication,availableAt}')::timestamptz;
  v_decision := (p_run#>>'{publication,decisionAt}')::timestamptz;
  v_close := case when v_market='KR' then time '15:30:00'
    when v_date in (date '2026-11-27',date '2026-12-24') then time '13:00:00' else time '16:00:00' end;
  if v_market='US' then
    if (v_available at time zone v_zone)::date is distinct from v_date
       or (v_decision at time zone v_zone)::date is distinct from v_date
       or v_available < (v_date + v_close) at time zone v_zone
       or v_available > v_decision or v_decision > v_now then
      raise exception 'US October publication must follow the same-session regular close and not be future';
    end if;
  else
    select min(d) into v_decision_session
    from (
      select v_date + n as d
      from pg_catalog.generate_series(1, date '2026-12-31' - v_date) n
    ) days
    where extract(isodow from d) <= 5
      and d not in (date '2026-10-09',date '2026-12-25',date '2026-12-31');
    if v_decision_session is null
       or v_decision_session = date '2026-11-19'
       or (v_available at time zone 'Asia/Seoul')::date is distinct from v_decision_session
       or (v_decision at time zone 'Asia/Seoul')::date is distinct from v_decision_session
       or v_available < (v_date + v_close) at time zone 'Asia/Seoul'
       or v_available > v_decision
       or v_decision >= (v_decision_session + time '09:00:00') at time zone 'Asia/Seoul'
       or v_decision > v_now then
      raise exception 'KR October publication requires the next regular-session morning refresh before open';
    end if;
  end if;

  select * into v_existing from public.ledger_model_sessions where user_id=v_user and series_id=v_id and session_date=v_date;
  if found then
    if v_existing.payload is distinct from p_run or v_existing.previous_session_date is distinct from p_previous_date then
      raise exception 'Immutable October model date conflict';
    end if;
    -- Exact existing retries remain valid after the head has advanced.
    return public.ledger_append_model_session(v_user,v_series.payload,p_run,p_previous_date,p_previous_hash);
  end if;
  select * into v_latest from public.ledger_model_sessions where user_id=v_user and series_id=v_id order by session_date desc limit 1;
  if found then
    if p_previous_date is distinct from v_latest.session_date or p_previous_hash is distinct from v_latest.state_hash then
      raise exception 'October predecessor/head conflict';
    end if;
    v_previous := v_latest;
    if p_run#>>'{calendar,coverageStart}' > v_previous.payload#>>'{calendar,coverageStart}'
       or p_run#>>'{calendar,coverageEnd}' < v_previous.payload#>>'{calendar,coverageEnd}'
       or v_previous.payload#>>'{calendar,market}' is distinct from v_market
       or (select coalesce(pg_catalog.jsonb_agg(value order by value),'[]'::jsonb)
           from pg_catalog.jsonb_array_elements_text(v_expected) dates(value)
           where value >= v_previous.payload#>>'{calendar,coverageStart}' and value <= v_previous.payload#>>'{calendar,coverageEnd}')
          is distinct from v_previous.payload#>'{calendar,regularSessions}' then
      raise exception 'Previously frozen October calendar coverage changed';
    end if;
    select min(value::date) into v_next from pg_catalog.jsonb_array_elements_text(v_expected) dates(value) where value::date > v_latest.session_date;
  else
    if p_previous_date is not null or p_previous_hash is not null then raise exception 'Unexpected initial October predecessor'; end if;
    v_next := v_first;
  end if;
  if v_date is distinct from v_next then raise exception 'October model cannot skip a regular session'; end if;
  -- Original same-day decision evidence is retained for a next-day crash recovery.
  -- This is an owner-scoped recording API: digest integrity does not authenticate
  -- external prices, prove a decision existed then, or certify an engine outcome.
  return public.ledger_append_model_session(v_user,v_series.payload,p_run,p_previous_date,p_previous_hash);
end;
$$;

alter function public.ledger_append_own_october_model_session(jsonb,date,text) owner to postgres;
revoke all on function public.ledger_append_own_october_model_session(jsonb,date,text) from public,anon,authenticated,service_role;
grant execute on function public.ledger_append_own_october_model_session(jsonb,date,text) to authenticated;
comment on function public.ledger_append_own_october_model_session(jsonb,date,text) is
'Owner-only append/staging for eight October 2026 MODEL registries. US keeps same-session publication. KR accepts only the next reviewed regular-session morning after the completed close and before that next open. Existing identity, receipt, calendar, chain and owner guards remain unchanged.';

commit;
