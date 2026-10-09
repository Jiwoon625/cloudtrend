-- Add the separately authorized October 12 contract; preserve all beta rows and owner guards.
begin;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_proc where oid='public.ledger_append_model_session(uuid,jsonb,jsonb,date,text)'::regprocedure and pg_catalog.pg_get_userbyid(proowner)='postgres' and not prosecdef)
    or not exists (select 1 from pg_catalog.pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure and pg_catalog.pg_get_userbyid(proowner)='postgres' and prosecdef)
  then raise exception 'Reviewed postgres-owned append boundary required'; end if;
end;
$$;
CREATE OR REPLACE FUNCTION public.ledger_append_model_session(p_user_id uuid, p_series jsonb, p_run jsonb, p_previous_date date, p_previous_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_contract_start date := case when p_series->>'bookId' like 'adopted-shadow-2026-10-12-v1:%' then date '2026-10-12' else date '2026-10-05' end;
  v_series text := p_series->>'bookId';
  v_date date := (p_run#>>'{receipt,date}')::date;
  v_saved jsonb;
  v_latest public.ledger_model_sessions%rowtype;
  v_artifact_now timestamptz := pg_catalog.statement_timestamp();
  v_registry public.ledger_model_series%rowtype;
  v_entry_registry public.ledger_model_series%rowtype;
  v_archive public.ledger_provenance_archive%rowtype;
  v_artifact jsonb; v_payload jsonb; v_snapshot jsonb; v_element jsonb; v_entry_run jsonb; v_ref jsonb;
  v_pair record;
  v_artifact_kind text; v_artifact_hash text; v_source_id text; v_market text; v_zone text; v_hash text;
  v_expected_kinds jsonb;
  v_close time; v_available timestamptz; v_decision timestamptz; v_prepared_at timestamptz; v_ref_date date; v_decision_session date;
begin
  -- Bounded October staging uses the existing append-only provenance table.
  -- This service-only function keeps its signature, invoker mode and grants.
  if p_run ? 'publicationArtifact' then
    if p_user_id is null or pg_catalog.jsonb_typeof(p_run) is distinct from 'object'
       or (p_run - array['book','bookId','contractHash','publicationArtifact']) <> '{}'::jsonb
       or p_run->>'book' is distinct from 'MODEL' or p_run->>'bookId' is distinct from v_series
       or v_series is null or v_series !~ '^adopted-shadow-2026-10-(05|12)-v1:(KR_MIXED|KR_KOSPI|KR_KOSDAQ|US_A0|ETF_V02|US_A2|US_B3|KR_KOSPI_CONFIRM1_BEAR)$'
       or p_previous_date is not null or p_previous_hash is not null
       or pg_catalog.octet_length(p_run::text) > 16777216
       or pg_catalog.jsonb_typeof(p_run->'publicationArtifact') is distinct from 'object'
       or ((p_run->'publicationArtifact') - array['kind','hash','payload']) <> '{}'::jsonb then
      raise exception 'Invalid bounded October artifact envelope';
    end if;
    select * into v_registry from public.ledger_model_series where user_id=p_user_id and series_id=v_series;
    if not found or v_registry.payload is distinct from p_series
       or p_run->>'contractHash' is distinct from v_registry.payload->>'contractHash'
       or v_registry.payload->>'book' is distinct from 'MODEL'
       or v_registry.payload->>'version' is distinct from pg_catalog.split_part(v_series,':',1)
       or v_registry.payload->>'accountingStartDate' is distinct from v_contract_start::text
       or v_registry.strategy_id is distinct from pg_catalog.split_part(v_series,':',2)
       or v_registry.scheduled_start is distinct from v_contract_start
       or v_registry.config_hash is distinct from v_registry.payload->>'configHash' then
      raise exception 'Existing owner October artifact registry required';
    end if;
    v_artifact := p_run->'publicationArtifact';
    v_payload := v_artifact->'payload';
    v_artifact_kind := v_artifact->>'kind';
    v_artifact_hash := v_artifact->>'hash';
    v_market := case when pg_catalog.split_part(v_series,':',2) in ('US_A0','US_A2','US_B3') then 'US' else 'KR' end;
    v_zone := case when v_market='US' then 'America/New_York' else 'Asia/Seoul' end;
    if v_registry.payload#>>'{policy,kind}' is distinct from v_registry.strategy_id
       or v_registry.payload#>>'{policy,market}' is distinct from v_market
       or v_registry.role is distinct from (case when v_registry.strategy_id in ('US_A2','US_B3','KR_KOSPI_CONFIRM1_BEAR') then 'ALTERNATIVE_SHADOW' else 'ADOPTED_SHADOW' end)
       or pg_catalog.jsonb_typeof(v_payload) is distinct from 'object'
       or v_artifact_kind is null or v_artifact_kind not in ('KR_DAILY_INPUT','PREPARED_PUBLICATION')
       or v_artifact_hash is null or v_artifact_hash !~ '^sha256:[a-f0-9]{64}$'
       or v_payload->>'date' is null or v_payload->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Invalid October artifact identity/hash/date';
    end if;
    v_date := (v_payload->>'date')::date;
    if (v_contract_start=date '2026-10-05' and v_date>=date '2026-10-12') or v_date < (case when v_contract_start=date '2026-10-12' then v_contract_start when v_market='US' then date '2026-10-05' else date '2026-10-06' end)
       or v_date > (v_artifact_now at time zone v_zone)::date or v_date > date '2026-12-31'
       or extract(isodow from v_date)>5
       or (v_market='KR' and v_date in (date '2026-10-09',date '2026-11-19',date '2026-12-25',date '2026-12-31'))
       or (v_market='US' and v_date in (date '2026-11-26',date '2026-12-25')) then
      raise exception 'October artifact requires an observed reviewed regular session';
    end if;
    v_close := case when v_market='KR' then time '15:30:00'
      when v_date in (date '2026-11-27',date '2026-12-24') then time '13:00:00' else time '16:00:00' end;
    if v_artifact_kind='KR_DAILY_INPUT' then
      if v_market <> 'KR' or v_payload->>'version' is distinct from 'kr-daily-inputs-v1'
         or (v_payload - array['version','date','inputs']) <> '{}'::jsonb
         or pg_catalog.jsonb_typeof(v_payload->'inputs') is distinct from 'object'
         or ((v_payload->'inputs') - array['snapshots','bars','markets','marketGates']) <> '{}'::jsonb
         or pg_catalog.jsonb_typeof(v_payload#>'{inputs,snapshots}') is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_payload#>'{inputs,snapshots}') <> 1
         or pg_catalog.jsonb_typeof(v_payload#>'{inputs,bars}') is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_payload#>'{inputs,markets}') is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_payload#>'{inputs,marketGates}') is distinct from 'object'
         or v_payload#>'{inputs,bars}' = '{}'::jsonb then
        raise exception 'Only bounded one-session KR daily inputs can be archived';
      end if;
      v_snapshot := v_payload#>'{inputs,snapshots,0}';
      if pg_catalog.jsonb_typeof(v_snapshot) is distinct from 'object'
         or (v_snapshot - array['date','asOfDate','savedAt','sourceRegisteredAt','marketGateStatus','kospiMarketGate','totalCount','passedCount','gradeACount','gradeBCount','entries']) <> '{}'::jsonb
         or v_snapshot->>'date' is distinct from v_date::text or v_snapshot->>'asOfDate' is distinct from v_date::text
         or pg_catalog.jsonb_typeof(v_snapshot->'entries') is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_snapshot->'entries') > 10000
         or v_snapshot->>'savedAt' is null or v_snapshot->>'savedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'Invalid dated KR input snapshot';
      end if;
      v_decision := (v_snapshot->>'savedAt')::timestamptz;
      select min(d) into v_decision_session
      from (
        select v_date + n as d
        from pg_catalog.generate_series(1, date '2026-12-31' - v_date) n
      ) days
      where extract(isodow from d) <= 5
        and d not in (date '2026-10-09',date '2026-12-25',date '2026-12-31');
      if v_decision_session is null
         or v_decision_session = date '2026-11-19'
         or (v_decision at time zone 'Asia/Seoul')::date <> v_decision_session
         or v_decision > v_artifact_now
         or v_decision < (v_date+v_close) at time zone 'Asia/Seoul'
         or v_decision >= (v_decision_session+time '09:00:00') at time zone 'Asia/Seoul'
         then raise exception 'KR input snapshot requires the next regular-session morning refresh before open'; end if;
      if exists(select 1 from pg_catalog.jsonb_each(v_payload#>'{inputs,markets}') e
                where e.key !~ '^[A-Z0-9]{6}$' or e.value not in ('"KOSPI"'::jsonb,'"KOSDAQ"'::jsonb))
         or (select count(*) from pg_catalog.jsonb_object_keys(v_payload#>'{inputs,markets}')) > 10000
         or exists(select 1 from pg_catalog.jsonb_each(v_payload#>'{inputs,marketGates}') e
                   where e.key <> v_date::text or pg_catalog.jsonb_typeof(e.value) <> 'object' or e.value->>'date' is distinct from v_date::text) then
        raise exception 'Invalid KR input markets or dated market gates';
      end if;
      for v_element in select value from pg_catalog.jsonb_array_elements(v_snapshot->'entries') loop
        if pg_catalog.jsonb_typeof(v_element) is distinct from 'object' or v_element->>'instrumentType' is distinct from 'STOCK'
           or v_element->>'symbol' is null or not (v_payload#>'{inputs,markets}' ? (v_element->>'symbol'))
           or (v_element - array['symbol','name','instrumentType','sectorCode','sectorName','grade','status','totalScore','scoreDelta1d','technicalPoints','priorityPoints','hardFilterPassed','hardFilterStatus','pendingRules','kosdaq80Onset','kospiEightPointEntry','kospi80Onset','kospiEntry','operationalSignalVersion','exitSignal']) <> '{}'::jsonb then
          raise exception 'KR archive snapshot contains a non-stock or unknown field';
        end if;
        -- Older immutable snapshots omit both fields. Preserve those bytes and
        -- their historical meaning; validate current evidence only when present.
        if v_element ? 'hardFilterStatus' or v_element ? 'pendingRules' then
          if pg_catalog.jsonb_typeof(v_element->'hardFilterStatus') is distinct from 'string'
             or v_element->>'hardFilterStatus' not in ('PASS','FAIL','PENDING')
             or pg_catalog.jsonb_typeof(v_element->'hardFilterPassed') is distinct from 'boolean'
             or pg_catalog.jsonb_typeof(v_element->'pendingRules') is distinct from 'array' then
            raise exception 'Invalid KR archive hard-filter evidence types';
          end if;
          if pg_catalog.jsonb_array_length(v_element->'pendingRules') > 16
             or exists (
               select 1 from pg_catalog.jsonb_array_elements(v_element->'pendingRules') rule
               where pg_catalog.jsonb_typeof(rule) is distinct from 'string'
                 or (rule #>> '{}') !~ '[^[:space:]]'
                 or pg_catalog.length(rule #>> '{}') > 256
             ) then
            raise exception 'Invalid bounded KR archive pending rules';
          end if;
          -- FAIL may still carry pending evidence when another rule has failed.
          if v_element->'hardFilterPassed' is distinct from pg_catalog.to_jsonb(v_element->>'hardFilterStatus' = 'PASS')
             or (v_element->>'hardFilterStatus' = 'PASS' and pg_catalog.jsonb_array_length(v_element->'pendingRules') <> 0)
             or (v_element->>'hardFilterStatus' = 'PENDING' and pg_catalog.jsonb_array_length(v_element->'pendingRules') = 0) then
            raise exception 'Inconsistent KR archive hard-filter evidence';
          end if;
        end if;
      end loop;
      for v_pair in select key,value from pg_catalog.jsonb_each(v_payload#>'{inputs,bars}') loop
        if v_pair.key !~ '^[A-Z0-9]{6}$' or not (v_payload#>'{inputs,markets}' ? v_pair.key)
           or pg_catalog.jsonb_typeof(v_pair.value) is distinct from 'array' or pg_catalog.jsonb_array_length(v_pair.value) <> 1
           or pg_catalog.jsonb_typeof(v_pair.value->0) is distinct from 'object'
           or v_pair.value#>>'{0,tradeDate}' is distinct from v_date::text
           or ((v_pair.value->0) ? 'openObserved' and pg_catalog.jsonb_typeof(v_pair.value#>'{0,openObserved}') is distinct from 'boolean')
           or ((v_pair.value->0) ? 'volumeObserved' and pg_catalog.jsonb_typeof(v_pair.value#>'{0,volumeObserved}') is distinct from 'boolean')
           or ((v_pair.value->0) - array['tradeDate','openObserved','volumeObserved','open','high','low','close','volume','tradingValue','marketCap','foreignNetBuyValue','institutionNetBuyValue','shortSellingVolumeRate','lendingBalanceQuantity','priceSource','marketCapSource','tradingValueSource','etfUnderlyingIndexClose','etfMarketCap','etfTradingValue']) <> '{}'::jsonb then
          raise exception 'KR archive bars must contain exactly one dated price per symbol';
        end if;
      end loop;
      v_source_id := 'october-input:KR:' || v_date::text || ':' || pg_catalog.substr(v_artifact_hash,8);
    else
      if v_payload->>'version' is distinct from 'october-prepared-publication-v1'
         or (v_payload - array['version','market','date','sourceHash','codeHash','runtimeCodeHash','inputHash','preparedAt','entries','preparedHash']) <> '{}'::jsonb
         or v_payload->>'market' is distinct from v_market
         or pg_catalog.jsonb_typeof(v_payload->'entries') is distinct from 'array'
         or v_payload->>'preparedAt' is null or v_payload->>'preparedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'Invalid bounded prepared October publication';
      end if;
      foreach v_hash in array array[v_payload->>'sourceHash',v_payload->>'codeHash',v_payload->>'runtimeCodeHash',v_payload->>'inputHash',v_payload->>'preparedHash'] loop
        if v_hash is null or v_hash !~ '^sha256:[a-f0-9]{64}$' then raise exception 'Invalid prepared October hash'; end if;
      end loop;
      v_prepared_at := (v_payload->>'preparedAt')::timestamptz;
      if v_prepared_at > v_artifact_now or v_prepared_at < (v_date+v_close) at time zone v_zone then raise exception 'Prepared October timestamp is before close or in the future'; end if;
      v_expected_kinds := case when v_market='US' then '["US_A0","US_A2","US_B3"]'::jsonb
        else '["KR_MIXED","KR_KOSPI","KR_KOSDAQ","ETF_V02","KR_KOSPI_CONFIRM1_BEAR"]'::jsonb end;
      if (select pg_catalog.jsonb_agg(value#>>'{series,policy,kind}' order by ordinal)
          from pg_catalog.jsonb_array_elements(v_payload->'entries') with ordinality e(value,ordinal)) is distinct from v_expected_kinds then
        raise exception 'Prepared October publication requires its complete exact market book set';
      end if;
      for v_element in select value from pg_catalog.jsonb_array_elements(v_payload->'entries') loop
        v_entry_run := v_element->'run';
        select * into v_entry_registry from public.ledger_model_series
          where user_id=p_user_id and series_id=v_element#>>'{series,bookId}';
        if not found or pg_catalog.jsonb_typeof(v_element) is distinct from 'object'
           or (v_element - array['series','run','previousDate','previousHash']) <> '{}'::jsonb
           or v_entry_registry.payload is distinct from v_element->'series'
           or v_entry_registry.series_id is distinct from pg_catalog.split_part(v_series,':',1) || ':' || (v_element#>>'{series,policy,kind}')
           or v_entry_registry.payload#>>'{policy,market}' is distinct from v_market
           or v_entry_registry.payload->>'book' is distinct from 'MODEL'
           or v_entry_registry.payload->>'version' is distinct from pg_catalog.split_part(v_series,':',1)
           or v_entry_registry.payload->>'accountingStartDate' is distinct from v_contract_start::text
           or v_entry_registry.config_hash is distinct from v_entry_registry.payload->>'configHash'
           or v_entry_registry.strategy_id is distinct from v_element#>>'{series,policy,kind}'
           or pg_catalog.jsonb_typeof(v_entry_run) is distinct from 'object'
           or (v_entry_run - array['book','bookId','contractHash','receipt','previousStateHash','calendar','result','stateHash','publication','frozenInputs','frozenInputArchive','firstValidSessionDate']) <> '{}'::jsonb
           or pg_catalog.jsonb_typeof(v_entry_run->'result') is distinct from 'object'
           or v_entry_run->>'book' is distinct from 'MODEL'
           or v_entry_run->>'bookId' is distinct from v_entry_registry.series_id
           or v_entry_run->>'contractHash' is distinct from v_entry_registry.payload->>'contractHash'
           or v_entry_run#>>'{receipt,date}' is distinct from v_date::text
           or v_entry_run#>>'{receipt,book}' is distinct from 'MODEL'
           or v_entry_run#>>'{receipt,bookId}' is distinct from v_entry_registry.series_id
           or v_entry_run#>>'{receipt,contractHash}' is distinct from v_entry_registry.payload->>'contractHash'
           or v_entry_run#>>'{receipt,configHash}' is distinct from v_entry_registry.config_hash
           or v_entry_run#>>'{receipt,codeHash}' is distinct from v_entry_registry.payload->>'codeHash'
           or v_entry_run#>>'{receipt,codeHash}' is distinct from v_payload->>'codeHash'
           or v_entry_run->>'previousStateHash' is distinct from v_element->>'previousHash'
           or (v_element->>'previousDate' is null) <> (v_element->>'previousHash' is null)
           or v_entry_run#>>'{publication,version}' is distinct from 'october-manual-publication-v1'
           or v_entry_run#>>'{publication,inputHash}' is distinct from v_payload->>'inputHash'
           or v_entry_run#>>'{publication,sourceHash}' is distinct from v_payload->>'sourceHash'
           or v_entry_run#>>'{publication,runtimeCodeHash}' is distinct from v_payload->>'runtimeCodeHash' then
          raise exception 'Prepared October run/owner registry identity mismatch';
        end if;
        foreach v_hash in array array[v_entry_run->>'stateHash',v_entry_run#>>'{receipt,sourceHash}',v_entry_run#>>'{receipt,runHash}',v_entry_run#>>'{receipt,contractHash}',v_entry_run#>>'{receipt,configHash}',v_entry_run#>>'{receipt,codeHash}'] loop
          if v_hash is null or v_hash !~ '^sha256:[a-f0-9]{64}$' then raise exception 'Invalid prepared run hash'; end if;
        end loop;
        if v_element->>'previousDate' is not null and (v_element->>'previousDate' !~ '^\d{4}-\d{2}-\d{2}$'
           or (v_element->>'previousDate')::date >= v_date or v_element->>'previousHash' !~ '^sha256:[a-f0-9]{64}$') then raise exception 'Invalid prepared predecessor'; end if;
        if v_entry_run#>>'{publication,availableAt}' is null or v_entry_run#>>'{publication,decisionAt}' is null
           or v_entry_run#>>'{publication,availableAt}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
           or v_entry_run#>>'{publication,decisionAt}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then raise exception 'Prepared publication timestamp required'; end if;
        v_available := (v_entry_run#>>'{publication,availableAt}')::timestamptz;
        v_decision := (v_entry_run#>>'{publication,decisionAt}')::timestamptz;
        if v_market='US' then
          if (v_available at time zone v_zone)::date <> v_date or (v_decision at time zone v_zone)::date <> v_date
             or v_available < (v_date+v_close) at time zone v_zone or v_available > v_decision
             or v_decision > v_artifact_now or v_decision > v_prepared_at
             then raise exception 'Invalid prepared US same-session close evidence'; end if;
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
             or (v_available at time zone 'Asia/Seoul')::date <> v_decision_session
             or (v_decision at time zone 'Asia/Seoul')::date <> v_decision_session
             or v_available < (v_date+v_close) at time zone 'Asia/Seoul'
             or v_available > v_decision
             or v_decision >= (v_decision_session+time '09:00:00') at time zone 'Asia/Seoul'
             or v_decision > v_artifact_now or v_decision > v_prepared_at
             then raise exception 'Invalid prepared KR next-session morning evidence'; end if;
        end if;
        if v_entry_registry.strategy_id in ('KR_MIXED','KR_KOSPI','KR_KOSDAQ') then
          if v_entry_run->'frozenInputs' is distinct from '{"snapshots":[],"bars":{},"markets":{},"marketGates":{}}'::jsonb
             or v_entry_run#>>'{frozenInputArchive,version}' is distinct from 'kr-daily-inputs-v1'
             or pg_catalog.jsonb_typeof(v_entry_run#>'{frozenInputArchive,days}') is distinct from 'array'
             or v_entry_run#>>'{frozenInputArchive,prefixHash}' is null or v_entry_run#>>'{frozenInputArchive,prefixHash}' !~ '^sha256:[a-f0-9]{64}$'
             or ((v_entry_run->'frozenInputArchive') - array['version','days','prefixHash']) <> '{}'::jsonb then raise exception 'Prepared KR run requires compact daily-input references'; end if;
          v_ref_date := null;
          for v_ref in select value from pg_catalog.jsonb_array_elements(v_entry_run#>'{frozenInputArchive,days}') loop
            if pg_catalog.jsonb_typeof(v_ref) is distinct from 'object' or (v_ref-array['date','hash']) <> '{}'::jsonb
               or v_ref->>'date' is null or v_ref->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
               or v_ref->>'hash' is null or v_ref->>'hash' !~ '^sha256:[a-f0-9]{64}$'
               or (v_ref->>'date')::date < date '2026-10-06' or (v_ref->>'date')::date > v_date
               or (v_ref_date is not null and (v_ref->>'date')::date <= v_ref_date)
               or not exists(select 1 from public.ledger_provenance_archive where user_id=p_user_id
                 and source_id='october-input:KR:'||(v_ref->>'date')||':'||pg_catalog.substr(v_ref->>'hash',8)
                 and source_revision='1' and source_hash=v_ref->>'hash') then raise exception 'Prepared KR daily input reference is missing or invalid'; end if;
            v_ref_date := (v_ref->>'date')::date;
          end loop;
          if v_ref_date is distinct from v_date then raise exception 'Prepared KR input must end at its publication date'; end if;
        end if;
      end loop;
      v_source_id := 'october-prepared:' || v_market || ':' || v_date::text;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':OCTOBER_ARTIFACT:' || v_source_id,0));
    if (select count(*) from public.ledger_provenance_archive where user_id=p_user_id and source_id=v_source_id and source_revision='1') > 1 then
      raise exception 'Ambiguous October archive identity';
    end if;
    select * into v_archive from public.ledger_provenance_archive where user_id=p_user_id and source_id=v_source_id and source_revision='1';
    if found then
      if v_artifact_kind='PREPARED_PUBLICATION' then
        if v_archive.payload->>'inputHash' is distinct from v_payload->>'inputHash'
           or v_archive.payload->>'sourceHash' is distinct from v_payload->>'sourceHash'
           or v_archive.payload->>'codeHash' is distinct from v_payload->>'codeHash'
           or v_archive.payload->>'runtimeCodeHash' is distinct from v_payload->>'runtimeCodeHash' then raise exception 'Immutable prepared October input conflict'; end if;
      elsif v_archive.source_hash is distinct from v_artifact_hash or v_archive.payload is distinct from v_payload then
        raise exception 'Immutable October daily input conflict';
      end if;
      return pg_catalog.jsonb_build_object('artifact',v_archive.payload);
    end if;
    insert into public.ledger_provenance_archive(user_id,source_id,source_revision,source_hash,payload)
      values(p_user_id,v_source_id,'1',v_artifact_hash,v_payload);
    return pg_catalog.jsonb_build_object('artifact',v_payload);
  end if;
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
$function$
;
CREATE OR REPLACE FUNCTION public.ledger_append_own_october_model_session(p_run jsonb, p_previous_date date, p_previous_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_contract_start date := case when p_run->>'bookId' like 'adopted-shadow-2026-10-12-v1:%' then date '2026-10-12' else date '2026-10-05' end;
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
     or v_id is null or v_id !~ '^adopted-shadow-2026-10-(05|12)-v1:(KR_MIXED|KR_KOSPI|KR_KOSDAQ|US_A0|ETF_V02|US_A2|US_B3|KR_KOSPI_CONFIRM1_BEAR)$'
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
  v_first := case when v_contract_start=date '2026-10-12' then v_contract_start when v_market='US' then date '2026-10-05' else date '2026-10-06' end;
  if p_run ? 'publicationArtifact' then
    return public.ledger_append_model_session(v_user,v_series.payload,p_run,p_previous_date,p_previous_hash);
  end if;
  if v_series.strategy_id is distinct from v_kind
     or v_series.role is distinct from (case when v_kind in ('US_A2','US_B3','KR_KOSPI_CONFIRM1_BEAR') then 'ALTERNATIVE_SHADOW' else 'ADOPTED_SHADOW' end)
     or v_series.scheduled_start is distinct from v_contract_start
     or v_series.payload->>'book' is distinct from 'MODEL'
     or v_series.payload->>'bookId' is distinct from v_id
     or v_series.payload->>'version' is distinct from pg_catalog.split_part(v_id,':',1)
     or v_series.payload->>'accountingStartDate' is distinct from v_contract_start::text
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
  if (v_contract_start=date '2026-10-05' and v_date>=date '2026-10-12') or v_date < v_first or v_date > (v_now at time zone v_zone)::date then
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
$function$
;

create table public.screening_run_archive (
 user_id uuid not null references auth.users(id),
 run_id text not null check (length(run_id) between 1 and 256),
 date date not null,
 market text not null check (market in ('KR','US')),
 strategy_version text not null,
 calculated_at timestamptz not null,
 snapshot jsonb not null check (jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=33554432),
 created_at timestamptz not null default now(),
 primary key(user_id,run_id),
 check (coalesce(snapshot->>'runId'=run_id and snapshot->>'asOfDate'=date::text and snapshot->>'market'=market and snapshot->>'strategyVersion'=strategy_version and (snapshot->>'savedAt')::timestamptz=calculated_at,false))
);
alter table public.screening_run_archive enable row level security;
create policy screening_run_owner_read on public.screening_run_archive for select to authenticated using (user_id=(select auth.uid()) and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false));
create policy screening_run_owner_insert on public.screening_run_archive for insert to authenticated with check (user_id=(select auth.uid()) and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false));
grant select,insert on public.screening_run_archive to authenticated;
grant select,insert on public.screening_run_archive to service_role;
revoke update,delete,truncate on public.screening_run_archive from authenticated,anon,service_role;
create index screening_run_owner_time on public.screening_run_archive(user_id,calculated_at desc);
commit;
