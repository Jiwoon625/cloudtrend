-- Align only new replay fill validation with the approved operating A0 cost cutover.
-- The execution date controls the boundary, including carried/partial orders.
-- Historical A0 fills and every A2/B3 fill retain 0.25%; A0 from 2026-10-08 uses 0.15%.
-- CREATE OR REPLACE retains the existing service-only ACL, SECURITY INVOKER,
-- signature and pinned search_path/TimeZone/DateStyle. No data or grants change.
-- Already-applied immutable plans still take the unchanged receipt verification path.
create or replace function public.apply_us_operating_replay(p_user_id uuid, p_plan jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
declare
  ids constant text[] := array['A0_QUARTER_PRIMARY','A2_QUARTER_SHADOW','B3_BETA_SHADOW','SPY_BENCHMARK'];
  snapshot_keys constant text[] := array['strategy_id','date','rule_version','nav_usd','cash_usd','benchmark_nav','daily_return','cumulative_return','turnover','fees_usd','positions_count','state'];
  registry_keys constant text[] := array['strategy_id','label','role','rule_version','config','active'];
  trade_keys constant text[] := array['trade_key','strategy_id','signal_date','execution_date','symbol','name','sector','side','reason','status','model_price','model_shares','model_notional','fee_usd','core_rank','detail'];
  payload jsonb; item jsonb; expected jsonb; actual jsonb; entry jsonb; previous jsonb;
  saved public.us_operating_replays; receipt jsonb;
  snapshot_row public.us_portfolio_snapshots;
  registry_row public.us_strategy_registry;
  trade_row public.us_portfolio_trades;
  base_day date; through_day date; current_day date; previous_day date;
  seen_ids text[]; session_days date[] := array[]::date[];
  strategy text; hash text; key text; canonical text;
  n integer; count_rows integer; cash_delta numeric; day_fees numeric; holding_value numeric;
  expected_cash numeric; previous_nav numeric; expected_shares numeric; actual_shares numeric; tolerance constant numeric := 0.000001;
begin
  if current_user <> 'service_role' then raise exception 'US operating replay requires service_role'; end if;
  if p_apply is null then raise exception 'US replay apply flag cannot be null'; end if;
  if p_user_id is null or jsonb_typeof(p_plan) is distinct from 'object' then
    raise exception 'Invalid US replay request'; end if;
  if p_plan - array['version','baseDate','throughDate','ruleVersion','dates','expectedRegistries','expectedSnapshots','expectedPendingTrades','snapshots','trades','pendingResolutions','planHash','canonicalPayload'] <> '{}'::jsonb
     or not p_plan ?& array['version','baseDate','throughDate','ruleVersion','dates','expectedRegistries','expectedSnapshots','expectedPendingTrades','snapshots','trades','pendingResolutions','planHash','canonicalPayload'] then
    raise exception 'Invalid US replay plan shape'; end if;
  payload := p_plan - array['planHash','canonicalPayload'];
  hash := p_plan->>'planHash'; canonical := p_plan->>'canonicalPayload';
  if hash is null or hash !~ '^sha256:[a-f0-9]{64}$' or canonical is null
     or octet_length(canonical) > 20000000
     or hash <> 'sha256:' || encode(sha256(convert_to(canonical,'UTF8')),'hex')
     or canonical::jsonb is distinct from payload then raise exception 'US replay plan hash mismatch'; end if;
  if p_plan->>'version' is distinct from 'us-operating-replay-v1'
     or p_plan->>'ruleVersion' is distinct from 'us-prospective-1.1.0-a0-anchor' then
    raise exception 'Unsupported US replay version'; end if;
  base_day := (p_plan->>'baseDate')::date; through_day := (p_plan->>'throughDate')::date;
  if base_day is null or through_day is null or through_day <= base_day then raise exception 'Invalid US replay dates'; end if;
  foreach key in array array['dates','expectedRegistries','expectedSnapshots','expectedPendingTrades','snapshots','trades','pendingResolutions'] loop
    if jsonb_typeof(p_plan->key) is distinct from 'array' then raise exception 'Invalid US replay array: %',key; end if;
  end loop;
  n := jsonb_array_length(p_plan->'dates');
  if n < 1 or n > 252 or jsonb_array_length(p_plan->'snapshots') <> 4*n
     or jsonb_array_length(p_plan->'expectedSnapshots') <> 4
     or jsonb_array_length(p_plan->'expectedRegistries') <> 4 then raise exception 'Incomplete four-book US replay'; end if;
  previous_day := base_day;
  for item in select value from jsonb_array_elements(p_plan->'dates') loop
    current_day := (item->>'date')::date;
    if item - array['date','previousSessionDate','sourceHash'] <> '{}'::jsonb
       or not item ?& array['date','previousSessionDate','sourceHash']
       or current_day is null or current_day <= previous_day
       or extract(isodow from current_day) > 5
       or (item->>'previousSessionDate')::date is distinct from previous_day
       or coalesce(item->>'sourceHash','') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception 'US replay session chain mismatch'; end if;
    session_days := array_append(session_days,current_day); previous_day := current_day;
  end loop;
  if previous_day <> through_day then raise exception 'US replay through date mismatch'; end if;

  perform pg_advisory_xact_lock(hashtextextended('us-operating-replay:' || p_user_id::text,0));
  -- Also serialize legacy writers that do not yet take the advisory lock. This
  -- short maintenance transaction must not race a snapshot/registry/PENDING edit.
  lock table public.us_portfolio_snapshots, public.us_strategy_registry, public.us_portfolio_trades in share row exclusive mode;
  select * into saved from public.us_operating_replays where user_id=p_user_id and plan_hash=hash;
  if found then
    if saved.plan is distinct from p_plan then raise exception 'US replay identity conflict'; end if;
    for expected in select value from jsonb_array_elements(p_plan->'snapshots') loop
      select * into snapshot_row from public.us_portfolio_snapshots
        where user_id=p_user_id and strategy_id=expected->>'strategy_id' and date=(expected->>'date')::date;
      if not found then raise exception 'Committed US replay snapshot missing'; end if;
      select jsonb_object_agg(k,to_jsonb(snapshot_row)->k) into actual from unnest(snapshot_keys) k;
      if actual is distinct from expected then raise exception 'Committed US replay snapshot changed'; end if;
    end loop;
    -- A receipt attests the model ledger as well as snapshots. Owner-entered
    -- actual_* annotations are intentionally outside this comparison.
    for expected in select value from jsonb_array_elements(p_plan->'trades') loop
      select * into trade_row from public.us_portfolio_trades
        where user_id=p_user_id and trade_key=expected->>'trade_key';
      if not found then raise exception 'Committed US replay trade missing'; end if;
      select jsonb_object_agg(k,to_jsonb(trade_row)->k) into actual from unnest(trade_keys) k;
      if actual is not distinct from expected then continue; end if;
      if expected->>'status' is distinct from 'PENDING'
         or actual->>'status' is distinct from 'CANCELLED'
         or actual - array['status','detail'] is distinct from expected - array['status','detail']
         or actual->'detail'->>'resolution' is distinct from 'ROLLED_FORWARD_OR_RESOLVED'
         or coalesce(actual->'detail'->>'resolved_on','') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Committed US replay trade changed'; end if;
      current_day:=(actual->'detail'->>'resolved_on')::date;
      entry:=jsonb_build_object('resolution','ROLLED_FORWARD_OR_RESOLVED','resolved_on',current_day::text);
      -- A later ordinary writer used bare resolution metadata; this RPC merges
      -- the original detail. Neither convention may change any other model field.
      if current_day<=through_day
         or (actual->'detail' is distinct from entry and actual->'detail' is distinct from (expected->'detail')||entry)
         or not exists (
           select 1 from public.us_portfolio_snapshots s where s.user_id=p_user_id
             and s.strategy_id=expected->>'strategy_id' and s.date=current_day
             and not exists (
               select 1 from (
                 select value from jsonb_each(coalesce(s.state->'pendingTargets','{}'::jsonb))
                 union all
                 select value from jsonb_each(coalesce(s.state->'pendingExits','{}'::jsonb))
               ) pending
               where pending.value->>'symbol'=expected->>'symbol'
                 and pending.value->>'signalDate'=expected->>'signal_date'
                 and pending.value->>'reason'=expected->>'reason'
             )
         ) then raise exception 'Committed US replay pending resolution is not a verified future session'; end if;
    end loop;
    for item in select value from jsonb_array_elements(p_plan->'pendingResolutions') loop
      expected:=(item->'expected')||jsonb_build_object('status','CANCELLED','detail',
        (item->'expected'->'detail')||jsonb_build_object('resolution','ROLLED_FORWARD_OR_RESOLVED','resolved_on',item->>'resolved_on'));
      select * into trade_row from public.us_portfolio_trades
        where user_id=p_user_id and trade_key=item->>'trade_key';
      if not found then raise exception 'Committed US replay prior pending resolution missing'; end if;
      select jsonb_object_agg(k,to_jsonb(trade_row)->k) into actual from unnest(trade_keys) k;
      if actual is distinct from expected then raise exception 'Committed US replay prior pending resolution changed'; end if;
    end loop;
    return case when p_apply then saved.receipt else saved.receipt||jsonb_build_object('validated',true,'alreadyApplied',true) end;
  end if;

  seen_ids := array[]::text[];
  for expected in select value from jsonb_array_elements(p_plan->'expectedRegistries') loop
    strategy := expected->>'strategy_id';
    if strategy is null or not strategy=any(ids) or strategy=any(seen_ids)
       or expected - registry_keys <> '{}'::jsonb or not expected ?& registry_keys
       or expected->>'rule_version' is distinct from p_plan->>'ruleVersion'
       or expected->'active' is distinct from 'true'::jsonb then raise exception 'Invalid frozen US registry'; end if;
    seen_ids := array_append(seen_ids,strategy);
    select * into registry_row from public.us_strategy_registry where user_id=p_user_id and strategy_id=strategy;
    if not found then raise exception 'Frozen US registry missing'; end if;
    select jsonb_object_agg(k,to_jsonb(registry_row)->k) into actual from unnest(registry_keys) k;
    if actual is distinct from expected then raise exception 'Frozen US registry changed'; end if;
  end loop;
  seen_ids := array[]::text[];
  for expected in select value from jsonb_array_elements(p_plan->'expectedSnapshots') loop
    strategy := expected->>'strategy_id';
    if strategy is null or not strategy=any(ids) or strategy=any(seen_ids)
       or expected - snapshot_keys <> '{}'::jsonb or not expected ?& snapshot_keys
       or (expected->>'date')::date is distinct from base_day
       or expected->>'rule_version' is distinct from p_plan->>'ruleVersion' then raise exception 'Invalid US predecessor'; end if;
    seen_ids := array_append(seen_ids,strategy);
    select * into snapshot_row from public.us_portfolio_snapshots
      where user_id=p_user_id and strategy_id=strategy order by date desc limit 1;
    if not found then raise exception 'US predecessor missing'; end if;
    select jsonb_object_agg(k,to_jsonb(snapshot_row)->k) into actual from unnest(snapshot_keys) k;
    if actual is distinct from expected then raise exception 'US predecessor changed or newer snapshot exists'; end if;
  end loop;

  select coalesce(jsonb_agg(projected order by projected->>'trade_key'),'[]'::jsonb) into actual
  from (select (select jsonb_object_agg(k,to_jsonb(t)->k) from unnest(trade_keys) k) projected
    from public.us_portfolio_trades t where user_id=p_user_id and strategy_id=any(ids) and status='PENDING') q;
  select coalesce(jsonb_agg(value order by value->>'trade_key'),'[]'::jsonb) into expected
    from jsonb_array_elements(p_plan->'expectedPendingTrades');
  if actual is distinct from expected then raise exception 'US pending predecessor changed'; end if;
  if exists (select 1 from jsonb_array_elements(expected) t where t->>'strategy_id'='SPY_BENCHMARK'
      or (t->>'signal_date')::date > base_day or t->'execution_date' <> 'null'::jsonb) then
    raise exception 'Invalid US pending predecessor'; end if;

  -- Validate every model trade before writing anything. Never accept actual_*
  -- columns, owner changes, timestamps, or a collision with an existing row.
  if (select count(*) <> count(distinct value->>'trade_key') from jsonb_array_elements(p_plan->'trades')) then
    raise exception 'Duplicate US replay trade'; end if;
  for item in select value from jsonb_array_elements(p_plan->'trades') loop
    if item - trade_keys <> '{}'::jsonb or not item ?& trade_keys
       or not coalesce(item->>'strategy_id','')=any(ids[1:3])
       or coalesce(item->>'trade_key','')='' or coalesce(item->>'symbol','')=''
       or (item->>'signal_date')::date > through_day
       or (item->>'signal_date')::date is null
       or coalesce(item->>'status','') not in ('PENDING','EXECUTED','PARTIAL','CANCELLED')
       or coalesce(item->>'side','') not in ('BUY','SELL','REBALANCE_BUY','REBALANCE_SELL')
       or item->>'reason' is null
       or jsonb_typeof(item->'detail') is distinct from 'object'
       or (item->>'fee_usd')::numeric < 0 then raise exception 'Invalid US model trade'; end if;
    -- Exercise PostgreSQL target column casts during validation, including int4
    -- limits, rather than discovering an insert-time type error after preflight.
    select * into trade_row from jsonb_populate_record(null::public.us_portfolio_trades,item);
    if trade_row.model_shares < 0 then raise exception 'Invalid US trade shares'; end if;
    if jsonb_typeof(item->'fee_usd') is distinct from 'number' then raise exception 'Invalid US trade fee'; end if;
    if item->>'status' in ('EXECUTED','PARTIAL') then
      foreach key in array array['model_price','model_shares','model_notional'] loop
        if jsonb_typeof(item->key) is distinct from 'number' then raise exception 'Invalid US model fill number'; end if;
      end loop;
      if not coalesce((item->>'execution_date')::date,'0001-01-01'::date)=any(session_days)
         or (item->>'signal_date')::date >= (item->>'execution_date')::date
         or coalesce((item->>'model_price')::numeric,0) <= 0
         or coalesce((item->>'model_shares')::numeric,0) <= 0
         or (item->>'model_shares')::numeric <> trunc((item->>'model_shares')::numeric)
         or abs((item->>'model_notional')::numeric-(item->>'model_price')::numeric*(item->>'model_shares')::numeric)>tolerance
         or abs((item->>'fee_usd')::numeric-(item->>'model_notional')::numeric*
           case when item->>'strategy_id'='A0_QUARTER_PRIMARY'
                     and (item->>'execution_date')::date >= date '2026-10-08'
                then 0.0015 else 0.0025 end)>tolerance then
        raise exception 'Invalid US model fill accounting'; end if;
    elsif item->'execution_date' is distinct from 'null'::jsonb or item->'model_price' is distinct from 'null'::jsonb
          or (item->>'fee_usd')::numeric is distinct from 0::numeric then raise exception 'Invalid unexecuted US model trade'; end if;
    if exists(select 1 from public.us_portfolio_trades where user_id=p_user_id and trade_key=item->>'trade_key') then
      raise exception 'Conflicting existing US trade'; end if;
  end loop;

  previous_day:=base_day;
  foreach current_day in array session_days loop
    seen_ids := array[]::text[];
    for item in select value from jsonb_array_elements(p_plan->'snapshots') where (value->>'date')::date=current_day loop
      strategy:=item->>'strategy_id';
      if strategy is null or not strategy=any(ids) or strategy=any(seen_ids)
         or item - snapshot_keys <> '{}'::jsonb or not item ?& snapshot_keys
         or item->>'rule_version' is distinct from p_plan->>'ruleVersion'
         or jsonb_typeof(item->'state') is distinct from 'object'
         or coalesce((item->>'nav_usd')::numeric,-1)<0 or coalesce((item->>'cash_usd')::numeric,-1)<0
         or coalesce((item->>'fees_usd')::numeric,-1)<0 or coalesce((item->>'turnover')::numeric,-1)<0 then
        raise exception 'Invalid US replay snapshot'; end if;
      seen_ids:=array_append(seen_ids,strategy);
      select * into snapshot_row from jsonb_populate_record(null::public.us_portfolio_snapshots,item);
      if snapshot_row.positions_count < 0 then raise exception 'Invalid US snapshot count'; end if;
      foreach key in array array['benchmark_nav','daily_return','cumulative_return'] loop
        if jsonb_typeof(item->key) not in ('number','null') then raise exception 'Invalid nullable US snapshot number'; end if;
      end loop;
      foreach key in array array['nav_usd','cash_usd','fees_usd','turnover','positions_count'] loop
        if jsonb_typeof(item->key) is distinct from 'number' then raise exception 'Invalid US snapshot number'; end if;
      end loop;
      select value into previous from jsonb_array_elements((p_plan->'expectedSnapshots')||(p_plan->'snapshots'))
        where value->>'strategy_id'=strategy and (value->>'date')::date=previous_day;
      if previous is null then raise exception 'Planned US predecessor missing'; end if;
      previous_nav:=(previous->>'nav_usd')::numeric;
      if strategy='SPY_BENCHMARK' then
        if jsonb_typeof(item->'state'->'basePrice') is distinct from 'number'
           or jsonb_typeof(item->'state'->'currentPrice') is distinct from 'number'
           or (item->>'positions_count')::integer<>1 or (item->>'fees_usd')::numeric<>0
           or (item->>'turnover')::numeric<>0
           or (item->>'benchmark_nav')::numeric is distinct from (item->>'nav_usd')::numeric
           or item->'state'->>'symbol' is distinct from 'SPY'
           or (item->'state'->>'basePrice')::numeric is distinct from (previous->'state'->>'basePrice')::numeric
           or coalesce((item->'state'->>'currentPrice')::numeric,0)<=0
           or abs((item->>'nav_usd')::numeric-100000*(item->'state'->>'currentPrice')::numeric/(item->'state'->>'basePrice')::numeric)>tolerance
           or (item->>'cash_usd')::numeric<>0 then raise exception 'Invalid SPY replay accounting'; end if;
      else
        foreach key in array array['cash','totalFees','initialCapital'] loop
          if jsonb_typeof(item->'state'->key) is distinct from 'number' then raise exception 'Invalid operating state number'; end if;
        end loop;
        if item->'state' ? 'executionPolicy' or item->'state'->>'lastDate' is distinct from current_day::text
           or jsonb_typeof(item->'state'->'positions') is distinct from 'object'
           or (item->'state'->>'initialCapital')::numeric is distinct from (previous->'state'->>'initialCapital')::numeric
           or item->'state'->>'initializedDate' is distinct from previous->'state'->>'initializedDate' then
          raise exception 'Invalid operating replay state'; end if;
        select coalesce(sum(case when t->>'side' in ('BUY','REBALANCE_BUY') then -(t->>'model_notional')::numeric else (t->>'model_notional')::numeric end-(t->>'fee_usd')::numeric),0),
          coalesce(sum((t->>'fee_usd')::numeric),0) into cash_delta,day_fees
          from jsonb_array_elements(p_plan->'trades') t where t->>'strategy_id'=strategy and (t->>'execution_date')::date=current_day;
        expected_cash:=(previous->>'cash_usd')::numeric+cash_delta;
        holding_value:=0; count_rows:=0;
        for key,entry in select * from jsonb_each(item->'state'->'positions') loop
          if jsonb_typeof(entry->'shares') is distinct from 'number' or jsonb_typeof(entry->'lastPrice') is distinct from 'number'
             or entry->>'symbol' is distinct from key or coalesce((entry->>'shares')::numeric,0)<=0
             or (entry->>'shares')::numeric<>trunc((entry->>'shares')::numeric)
             or coalesce((entry->>'lastPrice')::numeric,0)<=0 then raise exception 'Invalid US replay holding'; end if;
          holding_value:=holding_value+(entry->>'shares')::numeric*(entry->>'lastPrice')::numeric;
          count_rows:=count_rows+1;
        end loop;
        for key in
          select jsonb_object_keys(previous->'state'->'positions')
          union select jsonb_object_keys(item->'state'->'positions')
          union select t->>'symbol' from jsonb_array_elements(p_plan->'trades') t
            where t->>'strategy_id'=strategy and (t->>'execution_date')::date=current_day
        loop
          select coalesce(sum(case when t->>'side' in ('BUY','REBALANCE_BUY') then (t->>'model_shares')::numeric else -(t->>'model_shares')::numeric end),0)
            into expected_shares from jsonb_array_elements(p_plan->'trades') t
            where t->>'strategy_id'=strategy and (t->>'execution_date')::date=current_day and t->>'symbol'=key;
          expected_shares:=expected_shares+coalesce((previous->'state'->'positions'->key->>'shares')::numeric,0);
          actual_shares:=coalesce((item->'state'->'positions'->key->>'shares')::numeric,0);
          if expected_shares<0 or actual_shares<>expected_shares then raise exception 'US replay position/trade reconciliation failed'; end if;
        end loop;
        if abs((item->>'cash_usd')::numeric-expected_cash)>tolerance
           or abs((item->'state'->>'cash')::numeric-expected_cash)>tolerance
           or abs((item->>'nav_usd')::numeric-expected_cash-holding_value)>tolerance
           or abs((item->>'fees_usd')::numeric-day_fees)>tolerance
           or abs((item->'state'->>'totalFees')::numeric-(previous->'state'->>'totalFees')::numeric-day_fees)>tolerance
           or (item->>'positions_count')::integer<>count_rows then raise exception 'US replay cash/NAV/fees reconciliation failed'; end if;
      end if;

    end loop;
    if cardinality(seen_ids)<>4 then raise exception 'Incomplete US replay session'; end if;
    previous_day:=current_day;
  end loop;
  if (select count(*)<>count(distinct value->>'trade_key') from jsonb_array_elements(p_plan->'pendingResolutions')) then
    raise exception 'Duplicate US pending resolution'; end if;
  for item in select value from jsonb_array_elements(p_plan->'pendingResolutions') loop
    expected:=item->'expected';
    if item - array['trade_key','expected','resolved_on'] <> '{}'::jsonb
       or item->>'trade_key' is distinct from expected->>'trade_key'
       or not coalesce((item->>'resolved_on')::date,'0001-01-01'::date)=any(session_days)
       or not (p_plan->'expectedPendingTrades') @> jsonb_build_array(expected) then raise exception 'Invalid US pending resolution'; end if;
  end loop;
  if not p_apply then
    return jsonb_build_object('version','us-operating-replay-v1','planHash',hash,'baseDate',base_day,'throughDate',through_day,
      'validated',true,'alreadyApplied',false,'snapshotsPlanned',jsonb_array_length(p_plan->'snapshots'),
      'tradesPlanned',jsonb_array_length(p_plan->'trades'),'pendingResolutionsPlanned',jsonb_array_length(p_plan->'pendingResolutions'));
  end if;
  -- All guards have passed. Mutation begins only here, still in this transaction.
  for item in select value from jsonb_array_elements(p_plan->'snapshots') order by value->>'date',value->>'strategy_id' loop
    strategy:=item->>'strategy_id'; current_day:=(item->>'date')::date;
      insert into public.us_portfolio_snapshots(user_id,strategy_id,date,rule_version,nav_usd,cash_usd,benchmark_nav,daily_return,cumulative_return,turnover,fees_usd,positions_count,state)
      values(p_user_id,strategy,current_day,item->>'rule_version',(item->>'nav_usd')::numeric,(item->>'cash_usd')::numeric,
        (item->>'benchmark_nav')::numeric,(item->>'daily_return')::numeric,(item->>'cumulative_return')::numeric,
        (item->>'turnover')::numeric,(item->>'fees_usd')::numeric,(item->>'positions_count')::integer,item->'state');
      get diagnostics count_rows=row_count;
      if count_rows<>1 then raise exception 'US replay snapshot insert suppressed'; end if;
  end loop;
  for item in select value from jsonb_array_elements(p_plan->'pendingResolutions') loop
    select * into trade_row from public.us_portfolio_trades
      where user_id=p_user_id and trade_key=item->>'trade_key';
    previous:=to_jsonb(trade_row);
    update public.us_portfolio_trades set status='CANCELLED',
      detail=detail||jsonb_build_object('resolution','ROLLED_FORWARD_OR_RESOLVED','resolved_on',item->>'resolved_on'),updated_at=now()
      where user_id=p_user_id and trade_key=item->>'trade_key' and status='PENDING';
    get diagnostics count_rows=row_count;
    if count_rows<>1 then raise exception 'US pending resolution lost predecessor'; end if;
    select to_jsonb(t) into actual from public.us_portfolio_trades t
      where user_id=p_user_id and trade_key=item->>'trade_key';
    if actual - array['status','detail','updated_at'] is distinct from previous - array['status','detail','updated_at']
       or actual->>'status' is distinct from 'CANCELLED'
       or actual->'detail' is distinct from previous->'detail'||jsonb_build_object('resolution','ROLLED_FORWARD_OR_RESOLVED','resolved_on',item->>'resolved_on') then
      raise exception 'US pending resolution changed protected fields'; end if;
  end loop;
  for item in select value from jsonb_array_elements(p_plan->'trades') loop
    insert into public.us_portfolio_trades(user_id,trade_key,strategy_id,signal_date,execution_date,symbol,name,sector,side,reason,status,model_price,model_shares,model_notional,fee_usd,core_rank,detail)
    values(p_user_id,item->>'trade_key',item->>'strategy_id',(item->>'signal_date')::date,(item->>'execution_date')::date,
      item->>'symbol',item->>'name',item->>'sector',item->>'side',item->>'reason',item->>'status',(item->>'model_price')::numeric,
      (item->>'model_shares')::integer,(item->>'model_notional')::numeric,(item->>'fee_usd')::numeric,(item->>'core_rank')::numeric,item->'detail');
    get diagnostics count_rows=row_count;
    if count_rows<>1 then raise exception 'US replay trade insert suppressed'; end if;
  end loop;
  -- Verify the exact persisted model projections too, including trigger behavior.
  for expected in select value from jsonb_array_elements(p_plan->'snapshots') loop
    select * into snapshot_row from public.us_portfolio_snapshots
      where user_id=p_user_id and strategy_id=expected->>'strategy_id' and date=(expected->>'date')::date;
    select jsonb_object_agg(k,to_jsonb(snapshot_row)->k) into actual from unnest(snapshot_keys) k;
    if actual is distinct from expected then raise exception 'Persisted US replay snapshot differs'; end if;
  end loop;
  for expected in select value from jsonb_array_elements(p_plan->'trades') loop
    select * into trade_row from public.us_portfolio_trades
      where user_id=p_user_id and trade_key=expected->>'trade_key';
    select jsonb_object_agg(k,to_jsonb(trade_row)->k) into actual from unnest(trade_keys) k;
    if actual is distinct from expected or trade_row.actual_price is not null
       or trade_row.actual_shares is not null or trade_row.actual_fee_usd is not null then
      raise exception 'Persisted US replay trade differs or has actual execution'; end if;
  end loop;
  receipt:=jsonb_build_object('version','us-operating-replay-v1','planHash',hash,'baseDate',base_day,'throughDate',through_day,
    'snapshotsInserted',jsonb_array_length(p_plan->'snapshots'),'tradesInserted',jsonb_array_length(p_plan->'trades'),
    'pendingResolved',jsonb_array_length(p_plan->'pendingResolutions'),'committedAt',now());
  insert into public.us_operating_replays(user_id,plan_hash,base_date,through_date,plan,receipt)
    values(p_user_id,hash,base_day,through_day,p_plan,receipt);
  get diagnostics count_rows=row_count;
  if count_rows<>1 then raise exception 'US replay audit insert suppressed'; end if;
  return receipt;
end;
$$;
