-- Rollback to the previously approved integrated owner RPC. Prepared locally; not applied by this file's creation.
-- Only the integrated canonical-validation block changes. No data mutation in this migration.
-- Original body MD5 604613388f3dfac68fafad59ab7f3950; patched body MD5 d96be8e4843146bc5278d56aaca2c7c1.
-- Existing eight-book body, runtime dffdb12, owner, ACL, RLS and function proconfig remain unchanged.
begin;
do $guard$
begin
  if not exists(select 1 from pg_catalog.pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure
    and pg_catalog.pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
    and proacl @> array['postgres=X/postgres','authenticated=X/postgres']::aclitem[]
    and proacl <@ array['postgres=X/postgres','authenticated=X/postgres']::aclitem[]
    and pg_catalog.md5(prosrc) in ('604613388f3dfac68fafad59ab7f3950','d96be8e4843146bc5278d56aaca2c7c1')) then
    raise exception 'Reviewed integrated numeric-rendering boundary required';
  end if;
end;
$guard$;
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
  -- BEGIN BOUNDED INTEGRATED ALLOCATION BRANCH
  if v_id like 'integrated-allocation-shadow-%' then
    declare
      a_initialize boolean := coalesce(p_run->>'action'='INITIALIZE',false);
      a_initial text;
      a_registry jsonb := p_run->'registry';
      a_result jsonb := p_run->'result';
      a_contract text;
      a_canonical text := p_run->>'canonicalPayload';
      a_inner_canonical text := p_run->>'resultCanonicalPayload';
      a_canonical_value jsonb;
      a_rendered text;
      a_valid boolean;
      a_part text;
      a_due jsonb := '[]'::jsonb;
      a_receipt jsonb;
      a_entry jsonb;
      a_previous_receipts jsonb := '[]'::jsonb;
      a_previous_signals jsonb := '[]'::jsonb;
      a_signal_prefix integer := 0;
      a_observations jsonb;
      a_old_observations jsonb;
      a_observation jsonb;
      a_prefix_count integer := 0;
      a_count integer;
      a_market text;
      a_expected_date date;
      a_last date;
      a_market_decision timestamptz;
      a_next_kr date;
      a_new_ids jsonb;
      a_expected_ids jsonb;
      a_month_id text;
      a_month_end date;
    begin
      if pg_catalog.jsonb_typeof(p_run) is distinct from 'object'
         or v_id !~ '^integrated-allocation-shadow-2026-10-12-v1:(O1|S07)$'
         or p_run->>'book' is distinct from 'MODEL'
         or pg_catalog.octet_length(p_run::text)>16777216
         or (p_run-array['book','bookId','contractHash','receipt','previousStateHash','registry','result','publication','calendar','stateHash','canonicalPayload','resultCanonicalPayload','action'])<>'{}'::jsonb
         or pg_catalog.jsonb_typeof(p_run->'canonicalPayload') is distinct from 'string'
         or pg_catalog.jsonb_typeof(p_run->'resultCanonicalPayload') is distinct from 'string'
         or pg_catalog.jsonb_typeof(a_registry) is distinct from 'object'
         or pg_catalog.jsonb_typeof(a_result) is distinct from 'object'
         or (not a_initialize and (pg_catalog.jsonb_typeof(p_run->'publication') is distinct from 'object'
         or pg_catalog.jsonb_typeof(p_run->'receipt') is distinct from 'object')) then
        raise exception 'Invalid bounded integrated MODEL envelope';
      end if;
      if a_canonical::jsonb is distinct from p_run-array['stateHash','canonicalPayload']
         or p_run->>'stateHash' is distinct from 'sha256:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a_canonical,'UTF8')),'hex') then
        raise exception 'Integrated canonical state hash mismatch';
      end if;
      if a_inner_canonical::jsonb is distinct from a_result-'stateHash'
         or a_result->>'stateHash' is distinct from 'sha256:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a_inner_canonical,'UTF8')),'hex') then
        raise exception 'Integrated inner canonical state hash mismatch';
      end if;
      -- Reconstruct exact application canonical bytes without adding any function or privilege.
      -- Only ASCII schema keys and shortest-round-trip representable numbers are admitted.
      if pg_catalog.current_setting('extra_float_digits')::integer<1 then raise exception 'Canonical numeric rendering unavailable'; end if;
      foreach a_part in array array['OUTER','INNER'] loop
        a_canonical_value:=case when a_part='OUTER' then p_run-array['stateHash','canonicalPayload'] else a_result-'stateHash' end;
        WITH RECURSIVE
        nodes(path,value,prefix,object_key) AS (
          SELECT ARRAY[]::bigint[], a_canonical_value, ''::text, NULL::text
          UNION ALL
          SELECT n.path||c.ord, c.value,
            (CASE WHEN c.ord>1 THEN ',' ELSE '' END)||
            (CASE WHEN pg_catalog.jsonb_typeof(n.value)='object' THEN pg_catalog.to_jsonb(c.key)::text||':' ELSE '' END),
            c.key
          FROM nodes n
          CROSS JOIN LATERAL (
            SELECT e.key,e.value,pg_catalog.row_number() OVER (ORDER BY e.key COLLATE "C") AS ord
            FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
            UNION ALL
            SELECT NULL::text,e.value,e.ord
            FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY e(value,ord)
          ) c
          WHERE pg_catalog.cardinality(n.path)<64
        ),
        scalar AS (
          SELECT *,pg_catalog.jsonb_typeof(value) AS typ,
            CASE WHEN pg_catalog.jsonb_typeof(value)='number' THEN (value::text)::numeric END AS num
          FROM nodes
        ),
        decimal_parts AS (
          SELECT *,CASE WHEN typ='number' THEN pg_catalog.trim_scale(pg_catalog.abs(num))::text END AS abs_decimal,
            pg_catalog.cardinality(path)>=64 OR (object_key IS NOT NULL AND pg_catalog.octet_length(object_key)<>pg_catalog.char_length(object_key)) OR
            CASE WHEN typ='number' THEN pg_catalog.abs(num)>9007199254740991::numeric OR num IS DISTINCT FROM ((num::double precision)::text)::numeric ELSE false END AS invalid
          FROM scalar
        ),
        scientific_parts AS (
         SELECT *,
          CASE WHEN typ='number' THEN pg_catalog.regexp_replace(pg_catalog.regexp_replace(abs_decimal,'[.]','','g'),'^0+|0+$','','g') END AS significant,
          CASE WHEN typ='number' AND num<>0 THEN
            CASE WHEN pg_catalog.abs(num)>=1 THEN pg_catalog.length(pg_catalog.split_part(abs_decimal,'.',1))-1
              ELSE -1-pg_catalog.length(pg_catalog.substring(pg_catalog.split_part(abs_decimal,'.',2),'^0*')) END
          END AS exponent
         FROM decimal_parts
        ),
        tokens AS (
         SELECT path||0::bigint AS sort_path,
          prefix||CASE typ
            WHEN 'object' THEN '{'
            WHEN 'array' THEN '['
            WHEN 'number' THEN CASE
              WHEN num=0 THEN '0'
              WHEN pg_catalog.abs(num)>=0.000001::numeric AND pg_catalog.abs(num)<1000000000000000000000::numeric THEN pg_catalog.trim_scale(num)::text
              ELSE (CASE WHEN num<0 THEN '-' ELSE '' END)||pg_catalog.left(significant,1)||
                (CASE WHEN pg_catalog.length(significant)>1 THEN '.'||pg_catalog.substr(significant,2) ELSE '' END)||
                'e'||(CASE WHEN exponent>=0 THEN '+' ELSE '' END)||exponent::text
            END
            ELSE value::text END AS token,
          invalid
         FROM scientific_parts
         UNION ALL
         SELECT path||9223372036854775807::bigint,
          CASE typ WHEN 'object' THEN '}' ELSE ']' END,false
         FROM scalar WHERE typ IN ('object','array')
        )
        SELECT pg_catalog.string_agg(token,'' ORDER BY sort_path) AS canonical,
               NOT pg_catalog.bool_or(invalid) AS valid
        INTO a_rendered,a_valid
        FROM tokens;
        if a_valid is distinct from true or a_rendered is distinct from (case when a_part='OUTER' then a_canonical else a_inner_canonical end) then
          raise exception 'Integrated canonical bytes mismatch or unsupported numeric/key representation';
        end if;
      end loop;
      v_kind := pg_catalog.split_part(v_id,':',2);
      foreach v_hash in array array[p_run->>'stateHash',p_run->>'contractHash',a_registry->>'sourceHash',a_registry->>'configHash',a_registry->>'codeHash',a_result->>'stateHash'] loop
        if v_hash is null or v_hash !~ '^sha256:[a-f0-9]{64}$' then raise exception 'Invalid integrated provenance hash'; end if;
      end loop;
      if a_registry->>'codeHash' is distinct from 'sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4' then
        raise exception 'Reviewed integrated allocation runtime required';
      end if;
      a_contract := pg_catalog.replace(case when v_kind='O1' then $o1${"book":"ALLOCATION_SHADOW","bookId":"integrated-allocation-shadow-2026-10-12-v1:O1","codeHash":"__CODE_HASH__","cost":"KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE_0.0015","demandPolicy":"PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS","fixedUsdKrw":"1339.2","initialCapitalKrw":"30000000","initialReference":{"fallback":false,"historicalResearchOnly":true,"positiveDemandCounts":{"E":3,"K":5,"U":14},"reportSha256":"dd338780b0507053640a941cebab72e2634711ce9473f85a65aceb5f7d83821b","sessionWindow":{"count":20,"first":"2026-08-14","last":"2026-09-11"},"targetAsOf":"2026-09-11","wasExecutedMonthlyReview":false},"initialTarget":{"C":0,"E":1,"K":1,"U":1,"denominator":3},"kind":"O1","pending":"KEEP_SIGNAL_BUDGET","reallocation":"O1_MONTH_END_IDLE_CASH_ONLY_NO_FORCED_SALES","researchEquivalence":"LIVE_DELIVERED_SIGNAL_CALENDAR_MONTH_O1_NOT_CM_RESEARCH","sizing":"CALENDAR_YEAR_PRIOR_COMPLETE_NAV_K30_U20_ETF_PRIOR_CLOSE_NAV_VOLATILITY","startDate":"2026-10-12","version":"integrated-allocation-shadow-2026-10-12-v1","zeroTarget":"CANCEL_UNFILLED_BUYS_RELEASE_RESERVATIONS_KEEP_HOLDINGS"}$o1$ else $s07${"book":"ALLOCATION_SHADOW","bookId":"integrated-allocation-shadow-2026-10-12-v1:S07","codeHash":"__CODE_HASH__","cost":"KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE_0.0015","demandPolicy":"PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS","fixedUsdKrw":"1339.2","initialCapitalKrw":"30000000","initialReference":null,"initialTarget":{"C":0,"E":1,"K":3,"U":1,"denominator":5},"kind":"S07","pending":"KEEP_SIGNAL_BUDGET","reallocation":"STATIC_NO_TRANSFERS","researchEquivalence":"LIVE_DELIVERED_SIGNAL_CALENDAR_MONTH_O1_NOT_CM_RESEARCH","sizing":"CALENDAR_YEAR_PRIOR_COMPLETE_NAV_K30_U20_ETF_PRIOR_CLOSE_NAV_VOLATILITY","startDate":"2026-10-12","version":"integrated-allocation-shadow-2026-10-12-v1","zeroTarget":"CANCEL_UNFILLED_BUYS_RELEASE_RESERVATIONS_KEEP_HOLDINGS"}$s07$ end,'__CODE_HASH__',a_registry->>'codeHash');
      if a_registry->>'sourceHash' is distinct from (case when v_kind='O1' then 'sha256:513fc0c6ce3f898f5a14d4778bf61b10cb93a39397b02e7ef9b2ead896a6b423' else 'sha256:577f0e885899808017f1b427e1bd437df2b381ab3d13257c3f42e796d7feaee5' end)
         or a_registry is distinct from pg_catalog.jsonb_build_object(
          'book','MODEL','bookId',v_id,'version','integrated-allocation-shadow-2026-10-12-v1',
          'accountingStartDate','2026-10-12','policy',pg_catalog.jsonb_build_object('kind',v_kind,'market','GLOBAL'),
          'contract',a_contract::jsonb,'contractHash',p_run->>'contractHash','configHash',p_run->>'contractHash',
          'codeHash',a_registry->>'codeHash','sourceHash',a_registry->>'sourceHash')
         or p_run->>'contractHash' is distinct from 'sha256:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a_contract,'UTF8')),'hex')
         or a_result->>'book' is distinct from 'ALLOCATION_SHADOW' or a_result->>'bookId' is distinct from v_id
         or a_result->'contract' is distinct from a_contract::jsonb
         or a_result->>'contractHash' is distinct from p_run->>'contractHash'
         or pg_catalog.jsonb_typeof(a_result->'receipts') is distinct from 'array'
         or pg_catalog.jsonb_typeof(a_result->'deliveredEntrySignals') is distinct from 'array'
         or pg_catalog.jsonb_array_length(a_result->'receipts')>5000
         or pg_catalog.jsonb_typeof(a_result->'markets') is distinct from 'object'
         or (select pg_catalog.jsonb_agg(key order by key) from pg_catalog.jsonb_object_keys(a_result->'markets') key) is distinct from '["E","K","U"]'::jsonb then
        raise exception 'Integrated frozen contract/inner book mismatch';
      end if;
      if a_initialize then
        if (p_run-array['book','bookId','contractHash','action','registry','result','stateHash','canonicalPayload','resultCanonicalPayload'])<>'{}'::jsonb
           or p_previous_date is not null or p_previous_hash is not null then raise exception 'Invalid integrated initialization envelope'; end if;
        a_initial:=pg_catalog.replace(pg_catalog.replace(case when v_kind='O1' then $initial_o1${"book":"ALLOCATION_SHADOW","bookId":"integrated-allocation-shadow-2026-10-12-v1:O1","centralCashKrw":"0","contract":{"book":"ALLOCATION_SHADOW","bookId":"integrated-allocation-shadow-2026-10-12-v1:O1","codeHash":"__CODE_HASH__","cost":"KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE_0.0015","demandPolicy":"PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS","fixedUsdKrw":"1339.2","initialCapitalKrw":"30000000","initialReference":{"fallback":false,"historicalResearchOnly":true,"positiveDemandCounts":{"E":3,"K":5,"U":14},"reportSha256":"dd338780b0507053640a941cebab72e2634711ce9473f85a65aceb5f7d83821b","sessionWindow":{"count":20,"first":"2026-08-14","last":"2026-09-11"},"targetAsOf":"2026-09-11","wasExecutedMonthlyReview":false},"initialTarget":{"C":0,"E":1,"K":1,"U":1,"denominator":3},"kind":"O1","pending":"KEEP_SIGNAL_BUDGET","reallocation":"O1_MONTH_END_IDLE_CASH_ONLY_NO_FORCED_SALES","researchEquivalence":"LIVE_DELIVERED_SIGNAL_CALENDAR_MONTH_O1_NOT_CM_RESEARCH","sizing":"CALENDAR_YEAR_PRIOR_COMPLETE_NAV_K30_U20_ETF_PRIOR_CLOSE_NAV_VOLATILITY","startDate":"2026-10-12","version":"integrated-allocation-shadow-2026-10-12-v1","zeroTarget":"CANCEL_UNFILLED_BUYS_RELEASE_RESERVATIONS_KEEP_HOLDINGS"},"contractHash":"__CONTRACT_HASH__","deliveredEntrySignals":[],"lastReviewMonth":null,"markets":{"E":{"cashKrw":"10000000","holdingWindows":[],"lastDecisionAt":null,"lastSessionDate":null,"navKrw":"10000000","observedOnsets":[],"pendingBuys":[],"pendingExits":[],"positions":[],"sessions":[],"signalObservations":[],"sizing":{"navDate":"2026-10-12","navKrw":"10000000","status":"READY","year":2026}},"K":{"cashKrw":"10000000","holdingWindows":[],"lastDecisionAt":null,"lastSessionDate":null,"navKrw":"10000000","observedOnsets":[],"pendingBuys":[],"pendingExits":[],"positions":[],"sessions":[],"signalObservations":[],"sizing":{"navDate":"2026-10-12","navKrw":"10000000","status":"READY","year":2026}},"U":{"cashKrw":"10000000","holdingWindows":[],"lastDecisionAt":null,"lastSessionDate":null,"navKrw":"10000000","observedOnsets":[],"pendingBuys":[],"pendingExits":[],"positions":[],"sessions":[],"signalObservations":[],"sizing":{"navDate":"2026-10-12","navKrw":"10000000","status":"READY","year":2026}}},"receipts":[],"target":{"C":0,"E":1,"K":1,"U":1,"denominator":3}}$initial_o1$ else $initial_s07${"book":"ALLOCATION_SHADOW","bookId":"integrated-allocation-shadow-2026-10-12-v1:S07","centralCashKrw":"0","contract":{"book":"ALLOCATION_SHADOW","bookId":"integrated-allocation-shadow-2026-10-12-v1:S07","codeHash":"__CODE_HASH__","cost":"KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE_0.0015","demandPolicy":"PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS","fixedUsdKrw":"1339.2","initialCapitalKrw":"30000000","initialReference":null,"initialTarget":{"C":0,"E":1,"K":3,"U":1,"denominator":5},"kind":"S07","pending":"KEEP_SIGNAL_BUDGET","reallocation":"STATIC_NO_TRANSFERS","researchEquivalence":"LIVE_DELIVERED_SIGNAL_CALENDAR_MONTH_O1_NOT_CM_RESEARCH","sizing":"CALENDAR_YEAR_PRIOR_COMPLETE_NAV_K30_U20_ETF_PRIOR_CLOSE_NAV_VOLATILITY","startDate":"2026-10-12","version":"integrated-allocation-shadow-2026-10-12-v1","zeroTarget":"CANCEL_UNFILLED_BUYS_RELEASE_RESERVATIONS_KEEP_HOLDINGS"},"contractHash":"__CONTRACT_HASH__","deliveredEntrySignals":[],"lastReviewMonth":null,"markets":{"E":{"cashKrw":"6000000","holdingWindows":[],"lastDecisionAt":null,"lastSessionDate":null,"navKrw":"6000000","observedOnsets":[],"pendingBuys":[],"pendingExits":[],"positions":[],"sessions":[],"signalObservations":[],"sizing":{"navDate":"2026-10-12","navKrw":"6000000","status":"READY","year":2026}},"K":{"cashKrw":"18000000","holdingWindows":[],"lastDecisionAt":null,"lastSessionDate":null,"navKrw":"18000000","observedOnsets":[],"pendingBuys":[],"pendingExits":[],"positions":[],"sessions":[],"signalObservations":[],"sizing":{"navDate":"2026-10-12","navKrw":"18000000","status":"READY","year":2026}},"U":{"cashKrw":"6000000","holdingWindows":[],"lastDecisionAt":null,"lastSessionDate":null,"navKrw":"6000000","observedOnsets":[],"pendingBuys":[],"pendingExits":[],"positions":[],"sessions":[],"signalObservations":[],"sizing":{"navDate":"2026-10-12","navKrw":"6000000","status":"READY","year":2026}}},"receipts":[],"target":{"C":0,"E":1,"K":3,"U":1,"denominator":5}}$initial_s07$ end,'__CODE_HASH__',a_registry->>'codeHash'),'__CONTRACT_HASH__',p_run->>'contractHash');
        if a_result is distinct from a_initial::jsonb||pg_catalog.jsonb_build_object('stateHash','sha256:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a_initial,'UTF8')),'hex')) then raise exception 'Exact fresh integrated initial state required'; end if;
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':MODEL:'||v_id,0));
        select * into v_series from public.ledger_model_series where user_id=v_user and series_id=v_id;
        if found then
          if v_series.payload is distinct from a_registry or v_series.strategy_id is distinct from v_kind
             or v_series.role is distinct from 'ALLOCATOR_SHADOW' or v_series.scheduled_start is distinct from date '2026-10-12'
             or v_series.config_hash is distinct from a_registry->>'configHash' then raise exception 'Immutable integrated owner registry mismatch'; end if;
          return pg_catalog.jsonb_build_object('initialized',true,'reused',true,'bookId',v_id,'contractHash',p_run->>'contractHash');
        end if;
        insert into public.ledger_model_series(user_id,series_id,strategy_id,role,scheduled_start,config_hash,payload)
          values(v_user,v_id,v_kind,'ALLOCATOR_SHADOW',date '2026-10-12',a_registry->>'configHash',a_registry);
        return pg_catalog.jsonb_build_object('initialized',true,'reused',false,'bookId',v_id,'contractHash',p_run->>'contractHash');
      end if;
      if p_run ? 'action' then raise exception 'Unknown integrated recording action'; end if;
      foreach v_hash in array array[p_run#>>'{receipt,sourceHash}',p_run#>>'{receipt,runHash}',p_run#>>'{publication,batchHash}'] loop
        if v_hash is null or v_hash !~ '^sha256:[a-f0-9]{64}$' then raise exception 'Invalid integrated publication hash'; end if;
      end loop;
      if p_run#>>'{publication,batchHash}' is distinct from p_run#>>'{receipt,sourceHash}' then raise exception 'Integrated daily input batch hash mismatch'; end if;
      if p_run#>>'{receipt,date}' is null or p_run#>>'{receipt,date}' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid integrated session date'; end if;
      v_date := (p_run#>>'{receipt,date}')::date;
      if v_date<date '2026-10-12' or v_date>date '2026-12-31' or v_date>(v_now at time zone 'America/New_York')::date
         or v_date=date '2026-11-19' then raise exception 'Integrated date is pre-start/future/outside reviewed calendar or pending special hours'; end if;
      if p_run->'calendar' is distinct from '{"version":"exchange-calendar-2026-q4-v1","sourceHash":"sha256:44af9615519b8808515ec4213d0ba7e4941ac2b6dfe315e1b16fcf6ef73eab7d","coverageStart":"2026-10-05","coverageEnd":"2026-12-31"}'::jsonb then
        raise exception 'Exact reviewed integrated calendar evidence required';
      end if;
      -- Dates are derived only from the above exact reviewed exchange calendar, never a caller holiday guess.
      if extract(isodow from v_date)<=5 and v_date not in (date '2026-12-25',date '2026-12-31') then a_due:=a_due||'["K","E"]'::jsonb; end if;
      if extract(isodow from v_date)<=5 and v_date not in (date '2026-11-26',date '2026-12-25') then a_due:=a_due||'["U"]'::jsonb; end if;
      if a_due='[]'::jsonb or p_run#>'{publication,markets}' is distinct from a_due
         or p_run#>>'{publication,version}' is distinct from 'integrated-allocation-publication-v1'
         or (p_run->'publication')-array['version','batchHash','markets','availableAt','decisionAt']<>'{}'::jsonb
         or p_run#>>'{publication,availableAt}' is null or p_run#>>'{publication,decisionAt}' is null
         or p_run#>>'{publication,availableAt}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
         or p_run#>>'{publication,decisionAt}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'Complete integrated daily publication required';
      end if;
      v_available:=(p_run#>>'{publication,availableAt}')::timestamptz;
      v_decision:=(p_run#>>'{publication,decisionAt}')::timestamptz;
      if v_available>v_decision or v_decision>v_now then raise exception 'Integrated publication is not yet available'; end if;
      a_receipt:=pg_catalog.jsonb_build_object('book','MODEL','bookId',v_id,'date',v_date::text,'contractHash',p_run->>'contractHash',
        'configHash',a_registry->>'configHash','codeHash',a_registry->>'codeHash','sourceHash',p_run#>>'{receipt,sourceHash}');
      select '{'||pg_catalog.string_agg(pg_catalog.to_json(key)::text||':'||value::text,',' order by key collate "C")||'}' into v_receipt_json from pg_catalog.jsonb_each(a_receipt);
      if (p_run->'receipt')-'runHash' is distinct from a_receipt
         or p_run#>>'{receipt,runHash}' is distinct from 'sha256:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_receipt_json,'UTF8')),'hex')
         or (p_previous_date is null)<>(p_previous_hash is null)
         or (p_previous_hash is not null and p_previous_hash !~ '^sha256:[a-f0-9]{64}$')
         or p_run->>'previousStateHash' is distinct from p_previous_hash then raise exception 'Integrated receipt/predecessor mismatch'; end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':MODEL:'||v_id,0));
      select * into v_series from public.ledger_model_series where user_id=v_user and series_id=v_id;
      if found and (v_series.payload is distinct from a_registry or v_series.strategy_id is distinct from v_kind
         or v_series.role is distinct from 'ALLOCATOR_SHADOW' or v_series.scheduled_start is distinct from date '2026-10-12'
         or v_series.config_hash is distinct from a_registry->>'configHash') then raise exception 'Immutable integrated owner registry mismatch'; end if;
      select * into v_existing from public.ledger_model_sessions where user_id=v_user and series_id=v_id and session_date=v_date;
      if found then
        if v_existing.payload is distinct from p_run or v_existing.previous_session_date is distinct from p_previous_date then raise exception 'Immutable integrated daily batch conflict'; end if;
        return pg_catalog.jsonb_build_object('reused',true,'stateHash',v_existing.state_hash);
      end if;
      select * into v_latest from public.ledger_model_sessions where user_id=v_user and series_id=v_id order by session_date desc limit 1;
      if found then
        if p_previous_date is distinct from v_latest.session_date or p_previous_hash is distinct from v_latest.state_hash then raise exception 'Integrated predecessor/head conflict'; end if;
        a_previous_receipts:=v_latest.payload#>'{result,receipts}';
        a_previous_signals:=v_latest.payload#>'{result,deliveredEntrySignals}';
        a_signal_prefix:=pg_catalog.jsonb_array_length(a_previous_signals);
        a_prefix_count:=pg_catalog.jsonb_array_length(a_previous_receipts);
      elsif p_previous_date is not null or p_previous_hash is not null then raise exception 'Unexpected initial integrated predecessor'; end if;
      select min(d) into a_expected_date from (select coalesce(p_previous_date+1,date '2026-10-12')+n d from pg_catalog.generate_series(0,370) n) dates
        where extract(isodow from d)<=5 and d<>date '2026-12-25';
      if v_date is distinct from a_expected_date then raise exception 'Integrated daily batch cannot skip a reviewed session'; end if;
      if pg_catalog.jsonb_array_length(a_result->'deliveredEntrySignals')<a_signal_prefix
         or (select coalesce(pg_catalog.jsonb_agg(value order by ordinal),'[]'::jsonb) from pg_catalog.jsonb_array_elements(a_result->'deliveredEntrySignals') with ordinality e(value,ordinal) where ordinal<=a_signal_prefix) is distinct from a_previous_signals then raise exception 'Integrated immutable delivered-signal prefix changed'; end if;
      if exists(select 1 from pg_catalog.jsonb_array_elements(a_result->'deliveredEntrySignals') e(value) group by value->>'market',value->>'symbol',value->>'originDate' having count(*)>1) then raise exception 'Duplicate integrated delivered entry origin'; end if;
      for a_entry in select value from pg_catalog.jsonb_array_elements(a_result->'deliveredEntrySignals') with ordinality e(value,ordinal) where ordinal>a_signal_prefix loop
        if pg_catalog.jsonb_typeof(a_entry) is distinct from 'object'
           or (a_entry-array['market','symbol','originDate','confirmationDate','deliveredAt','sourceHash','reason'])<>'{}'::jsonb
           or a_entry->>'market' is null or not (a_due ? (a_entry->>'market'))
           or pg_catalog.jsonb_typeof(a_entry->'symbol') is distinct from 'string' or a_entry->>'symbol'=''
           or pg_catalog.jsonb_typeof(a_entry->'reason') is distinct from 'string' or a_entry->>'reason'=''
           or a_entry->>'confirmationDate' is distinct from v_date::text
           or a_entry->>'originDate' is null or a_entry->>'originDate' !~ '^\d{4}-\d{2}-\d{2}$'
           or (a_entry->>'originDate')::date<date '2026-10-12' or (a_entry->>'originDate')::date>v_date
           or not ((a_result#>array['markets',a_entry->>'market','sessions']) ? (a_entry->>'originDate'))
           or a_entry->>'sourceHash' is null or a_entry->>'sourceHash' !~ '^sha256:[a-f0-9]{64}$'
           or a_entry->>'sourceHash' is distinct from (select value#>>'{record,sourceHash}' from pg_catalog.jsonb_array_elements(a_result->'receipts') e(value) where value->>'id'='session:'||(a_entry->>'market')||':'||v_date::text limit 1)
           or a_entry->>'deliveredAt' is null or a_entry->>'deliveredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
           or (a_entry->>'deliveredAt')::timestamptz>v_available
           or (a_entry->>'deliveredAt')::timestamptz<(case when a_entry->>'market'='U' then (v_date+(case when v_date in (date '2026-11-27',date '2026-12-24') then time '13:00' else time '16:00' end)) at time zone 'America/New_York' else (v_date+time '15:30') at time zone 'Asia/Seoul' end)
           or (a_entry->>'deliveredAt')::timestamptz>(a_result#>>array['markets',a_entry->>'market','lastDecisionAt'])::timestamptz
           or a_result#>>array['markets',a_entry->>'market','signalObservations','-1','status'] is distinct from 'COMPLETE' then raise exception 'Invalid integrated delivered entry evidence'; end if;
      end loop;
      a_count:=pg_catalog.jsonb_array_length(a_result->'receipts');
      if a_count<a_prefix_count or (select coalesce(pg_catalog.jsonb_agg(value order by ordinal),'[]'::jsonb) from pg_catalog.jsonb_array_elements(a_result->'receipts') with ordinality e(value,ordinal) where ordinal<=a_prefix_count) is distinct from a_previous_receipts then
        raise exception 'Integrated immutable event prefix changed';
      end if;
      select pg_catalog.jsonb_agg('session:'||value||':'||v_date::text order by value) into a_expected_ids from pg_catalog.jsonb_array_elements_text(a_due);
      select coalesce(pg_catalog.jsonb_agg(value->>'id' order by value->>'id'),'[]'::jsonb) into a_new_ids from pg_catalog.jsonb_array_elements(a_result->'receipts') with ordinality e(value,ordinal) where ordinal>a_prefix_count and value->>'id' not like 'month:%';
      if a_new_ids is distinct from a_expected_ids then raise exception 'Incomplete or duplicate integrated daily event set'; end if;
      select max(d) into a_month_end from (select date_trunc('month',v_date)::date+n d from pg_catalog.generate_series(0,30) n) dates
        where date_trunc('month',d)=date_trunc('month',v_date) and extract(isodow from d)<=5 and d<>date '2026-12-25';
      a_month_id:='month:'||pg_catalog.to_char(v_date,'YYYY-MM');
      if (v_kind='O1' and v_date=a_month_end and a_count<>a_prefix_count+pg_catalog.jsonb_array_length(a_due)+1)
         or (v_kind='S07' and a_count<>a_prefix_count+pg_catalog.jsonb_array_length(a_due)) then raise exception 'Integrated O1 month-end receipt required; S07 monthly receipt forbidden'; end if;
      for a_entry in select value from pg_catalog.jsonb_array_elements(a_result->'receipts') with ordinality e(value,ordinal) where ordinal>a_prefix_count loop
        if pg_catalog.jsonb_typeof(a_entry) is distinct from 'object' or (a_entry-array['id','inputHash','record'])<>'{}'::jsonb
           or pg_catalog.jsonb_typeof(a_entry->'id') is distinct from 'string'
           or a_entry->>'id' !~ '^(session:(K|E|U):[0-9]{4}-[0-9]{2}-[0-9]{2}|month:[0-9]{4}-[0-9]{2})$'
           or a_entry->>'inputHash' is null or a_entry->>'inputHash' !~ '^sha256:[a-f0-9]{64}$'
           or a_entry#>>'{record,id}' is distinct from a_entry->>'id'
           or a_entry#>>'{record,sourceHash}' is null or a_entry#>>'{record,sourceHash}' !~ '^sha256:[a-f0-9]{64}$' then raise exception 'Invalid integrated inner event receipt'; end if;
        if a_entry->>'id' like 'month:%' then
          if v_date<>a_month_end or a_entry->>'id'<>a_month_id or a_entry#>>'{record,type}' is distinct from 'MONTH_REVIEW'
             or a_entry#>>'{record,date}' is distinct from pg_catalog.to_char(v_date,'YYYY-MM')
             or a_result#>>'{receipts,-1,id}' is distinct from a_month_id
             or a_result->>'lastReviewMonth' is distinct from pg_catalog.to_char(v_date,'YYYY-MM') then raise exception 'Invalid integrated month-end event'; end if;
        elsif a_entry#>>'{record,type}' is distinct from 'SESSION' or a_entry#>>'{record,date}' is distinct from v_date::text then raise exception 'Invalid integrated session event'; end if;
      end loop;
      if a_count>a_prefix_count+pg_catalog.jsonb_array_length(a_due)+1
         or (a_count=a_prefix_count+pg_catalog.jsonb_array_length(a_due) and a_result->>'lastReviewMonth' is distinct from v_latest.payload#>>'{result,lastReviewMonth}') then raise exception 'Integrated review/event count mismatch'; end if;
      foreach a_market in array array['K','E','U'] loop
        if pg_catalog.jsonb_typeof(a_result#>array['markets',a_market,'sessions']) is distinct from 'array' then raise exception 'Integrated market session history missing'; end if;
        a_observations:=a_result#>array['markets',a_market,'signalObservations'];
        a_old_observations:=coalesce(v_latest.payload#>array['result','markets',a_market,'signalObservations'],'[]'::jsonb);
        if pg_catalog.jsonb_typeof(a_observations) is distinct from 'array' then raise exception 'Integrated market signal observations missing'; end if;
        if a_due ? a_market then
          a_observation:=a_observations->-1;
          if pg_catalog.jsonb_typeof(a_observation) is distinct from 'object'
             or a_observation->>'date' is distinct from v_date::text
             or a_observation->>'status' is null or a_observation->>'status' not in ('COMPLETE','MISSING')
             or (a_observation-array['date','status'])<>'{}'::jsonb
             or a_observations is distinct from a_old_observations||pg_catalog.jsonb_build_array(a_observation) then raise exception 'Integrated immutable signal-observation prefix changed'; end if;
        elsif a_observations is distinct from a_old_observations then raise exception 'Closed integrated signal observations changed'; end if;
        if a_due ? a_market then
          if a_result#>>array['markets',a_market,'lastSessionDate'] is distinct from v_date::text
             or a_result#>>array['markets',a_market,'lastDecisionAt'] is null then raise exception 'Incomplete integrated market snapshot'; end if;
          a_market_decision:=(a_result#>>array['markets',a_market,'lastDecisionAt'])::timestamptz;
          if a_market_decision>v_decision then raise exception 'Market decision is later than integrated publication'; end if;
          if a_market='U' then
            v_close:=case when v_date in (date '2026-11-27',date '2026-12-24') then time '13:00' else time '16:00' end;
            if a_market_decision<(v_date+v_close) at time zone 'America/New_York' then raise exception 'Integrated US session has not closed'; end if;
          else
            select min(d) into a_next_kr from (select v_date+n d from pg_catalog.generate_series(1,10) n) dates where extract(isodow from d)<=5 and d not in (date '2026-12-25',date '2026-12-31');
            if a_next_kr>date '2026-12-31' or a_next_kr=date '2026-11-19'
               or (a_market_decision at time zone 'Asia/Seoul')::date<>a_next_kr
               or a_market_decision>=(a_next_kr+time '09:00') at time zone 'Asia/Seoul'
               or a_market_decision<(v_date+time '15:30') at time zone 'Asia/Seoul' then raise exception 'Integrated KR next-session morning evidence required'; end if;
          end if;
          if a_result#>array['markets',a_market,'sessions'] is distinct from coalesce(v_latest.payload#>array['result','markets',a_market,'sessions'],'[]'::jsonb)||pg_catalog.jsonb_build_array(v_date::text) then raise exception 'Integrated market session prefix changed'; end if;
        elsif a_result#>array['markets',a_market,'sessions'] is distinct from coalesce(v_latest.payload#>array['result','markets',a_market,'sessions'],'[]'::jsonb)
           or a_result#>>array['markets',a_market,'lastSessionDate'] is distinct from v_latest.payload#>>array['result','markets',a_market,'lastSessionDate']
           or a_result#>>array['markets',a_market,'lastDecisionAt'] is distinct from v_latest.payload#>>array['result','markets',a_market,'lastDecisionAt'] then raise exception 'Closed integrated market was advanced'; end if;
      end loop;
      -- Initialization is atomic with the first fully verified daily batch; no pre-start session is invented.
      if v_series.user_id is null then
        insert into public.ledger_model_series(user_id,series_id,strategy_id,role,scheduled_start,config_hash,payload)
          values(v_user,v_id,v_kind,'ALLOCATOR_SHADOW',date '2026-10-12',a_registry->>'configHash',a_registry);
      end if;
      insert into public.ledger_model_sessions(user_id,series_id,session_date,previous_session_date,state_hash,payload)
        values(v_user,v_id,v_date,p_previous_date,p_run->>'stateHash',p_run);
      return pg_catalog.jsonb_build_object('reused',false,'stateHash',p_run->>'stateHash');
    end;
  end if;
  -- END BOUNDED INTEGRATED ALLOCATION BRANCH

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
commit;
