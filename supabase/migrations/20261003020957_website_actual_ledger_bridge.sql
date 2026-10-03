-- Generated with Supabase CLI 2.119.0. Website source-only ACTUAL bridge.
-- Activation is fail-closed: existing legacy documents must be fully reconciled.
-- No existing source/canonical execution is imported or corrected by activation.
begin;
set local lock_timeout = '5s';

create schema cloudtrend_ledger_private;
revoke all on schema cloudtrend_ledger_private from public, anon, authenticated, service_role;

create table cloudtrend_ledger_private.bridge_documents (
  user_id uuid not null,
  source_system text not null check (source_system in ('portfolio_ledgers','us_actual_portfolio_ledgers')),
  document_revision integer not null check (document_revision > 0),
  document_hash text not null,
  ledger_hash text not null,
  primary key (user_id, source_system)
);
alter table cloudtrend_ledger_private.bridge_documents enable row level security;
revoke all on cloudtrend_ledger_private.bridge_documents from public, anon, authenticated, service_role;

create function cloudtrend_ledger_private.json_hash(p_value jsonb) returns text
language sql immutable strict security invoker set search_path = '' as $$
  select 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_value::text, 'UTF8')), 'hex')
$$;

-- Exactly the nonnegative Number.toFixed(8) algorithm, including binary halfway
-- rounding. Decode float8 bits, scale the exact rational, then round to nearest
-- integer with ties upward. Decimal string is normalized as the TypeScript ledger.
create function cloudtrend_ledger_private.js_fixed8(p_value double precision) returns text
language plpgsql immutable strict security invoker set search_path = '' as $$
declare
  b bytea := pg_catalog.float8send(p_value);
  exponent integer;
  mantissa numeric;
  numerator numeric;
  denominator numeric;
  rounded numeric;
  i integer;
begin
  if p_value < 0 or p_value > 9007199254740991 or p_value = 'NaN'::double precision then
    raise exception 'Website number is outside the safe numeric range';
  end if;
  exponent := ((pg_catalog.get_byte(b,0) & 127) << 4) + (pg_catalog.get_byte(b,1) >> 4);
  mantissa := pg_catalog.get_byte(b,1) & 15;
  for i in 2..7 loop mantissa := mantissa * 256 + pg_catalog.get_byte(b,i); end loop;
  if exponent = 0 then
    exponent := -1074;
  else
    mantissa := mantissa + 4503599627370496;
    exponent := exponent - 1023 - 52;
  end if;
  numerator := mantissa * 100000000 * pg_catalog.power(2::numeric, greatest(exponent,0));
  denominator := pg_catalog.power(2::numeric, greatest(-exponent,0));
  rounded := pg_catalog.div(numerator,denominator);
  if pg_catalog.mod(numerator,denominator)*2 >= denominator then rounded := rounded+1; end if;
  return pg_catalog.trim_scale(rounded / 100000000)::text;
end;
$$;

-- Only inert provenance references are accepted; no URL is fetched or trusted as evidence.
create function cloudtrend_ledger_private.validate_source_links(p_links jsonb) returns void
language plpgsql immutable security invoker set search_path = '' as $$
declare link jsonb;
begin
  if p_links is null then return; end if;
  if pg_catalog.jsonb_typeof(p_links) is distinct from 'array' or pg_catalog.jsonb_array_length(p_links)>50 then
    raise exception 'Invalid execution source links';
  end if;
  for link in select value from pg_catalog.jsonb_array_elements(p_links) loop
    if pg_catalog.jsonb_typeof(link) is distinct from 'object' or
       not (link ?& array['system','url']) or
       (link - array['system','url','label']) <> '{}'::jsonb or
       link->>'system' is distinct from 'notion' or
       pg_catalog.jsonb_typeof(link->'url') is distinct from 'string' or
       pg_catalog.length(link->>'url') not between 1 and 2048 or
       link->>'url' !~* '^((https://)?([a-z0-9-]+\.)*notion\.(so|site|com)\.?(:443)?|http://([a-z0-9-]+\.)*notion\.(so|site|com)\.?(:80)?)([/?#][^[:space:]<>"'']*)?$' or
       (link ? 'label' and (pg_catalog.jsonb_typeof(link->'label') is distinct from 'string' or pg_catalog.length(link->>'label')>300)) then
      raise exception 'Invalid execution source link';
    end if;
  end loop;
end;
$$;

-- Pin shortest float rendering locally; caller output settings must not reject lossless source prices.
create function cloudtrend_ledger_private.validate_document(p_document jsonb, p_system text) returns void
language plpgsql immutable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare e jsonb; n text; v numeric; d date; refs jsonb;
begin
  if p_system not in ('portfolio_ledgers','us_actual_portfolio_ledgers') or
     pg_catalog.jsonb_typeof(p_document) is distinct from 'object' or
     pg_catalog.jsonb_typeof(p_document->'executions') is distinct from 'array' or
     pg_catalog.jsonb_array_length(p_document->'executions') > 100000 then
    raise exception 'Invalid website document/executions';
  end if;
  if p_document ? 'excludedSourceLinks' then
    if pg_catalog.jsonb_typeof(p_document->'excludedSourceLinks') is distinct from 'object' then raise exception 'Invalid exclusion source links'; end if;
    for refs in select value from pg_catalog.jsonb_each(p_document->'excludedSourceLinks') loop
      perform cloudtrend_ledger_private.validate_source_links(refs);
    end loop;
  end if;
  for e in select value from pg_catalog.jsonb_array_elements(p_document->'executions') loop
    perform cloudtrend_ledger_private.validate_source_links(e->'sourceLinks');
    if pg_catalog.jsonb_typeof(e) is distinct from 'object' or
       not (e ?& array['id','symbol','name','market','signalKey','side','date','price','shares','fee','note','order']) then
      raise exception 'Execution must contain every source field';
    end if;
    foreach n in array array['id','symbol','name','market','side','date','note'] loop
      if pg_catalog.jsonb_typeof(e->n) is distinct from 'string' then raise exception 'Invalid execution text field'; end if;
    end loop;
    if pg_catalog.length(e->>'id') not between 1 and 512 or
       pg_catalog.length(e->>'symbol') not between 1 and 64 or
       pg_catalog.length(e->>'name') not between 1 and 512 or
       pg_catalog.length(e->>'note') > 10000 or
       (pg_catalog.jsonb_typeof(e->'signalKey') not in ('string','null')) or
       pg_catalog.length(coalesce(e->>'signalKey','')) > 1024 or
       (e->>'side') not in ('BUY','SELL') or
       (p_system='portfolio_ledgers' and (e->>'market' not in ('KOSPI','KOSDAQ','ETF') or e->>'symbol' !~ '^[A-Z0-9]{6}$')) or
       (p_system='us_actual_portfolio_ledgers' and (e->>'market'<>'US' or e->>'symbol' !~ '^[A-Z0-9][A-Z0-9.^/-]{0,63}$')) then
      raise exception 'Invalid execution identity, market, or source field';
    end if;
    if e->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid execution date'; end if;
    begin d := (e->>'date')::date;
    exception when others then raise exception 'Invalid execution date'; end;
    if pg_catalog.to_char(d,'YYYY-MM-DD') <> e->>'date' then raise exception 'Invalid execution date'; end if;
    foreach n in array array['shares','price','fee','order'] loop
      if pg_catalog.jsonb_typeof(e->n) is distinct from 'number' then raise exception 'Invalid execution numeric field'; end if;
      v := (e->>n)::numeric;
      if v < 0 or v > 9007199254740991 or
         (n in ('shares','price') and v <= 0) or
         (n in ('shares','order') and v <> pg_catalog.trunc(v)) or
         (n='fee' and cloudtrend_ledger_private.js_fixed8(v::double precision)::double precision <> v::double precision) or
         (n in ('price','fee') and (v::double precision)::text::numeric <> v) then
        raise exception 'Execution number is not safely representable';
      end if;
    end loop;
    if ((e->>'price')::double precision * (e->>'shares')::double precision) > 9007199254740991 or
       cloudtrend_ledger_private.js_fixed8((e->>'price')::double precision)::numeric <= 0 then
      raise exception 'Execution gross/price is outside the safe numeric range';
    end if;
  end loop;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_document->'executions') a
             group by a.value->>'id' having count(*) > 1) then raise exception 'Duplicate source execution identity'; end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_document->'executions') a
             group by a.value->>'symbol' having count(distinct a.value->>'market') > 1) then
    raise exception 'One source symbol cannot have conflicting markets';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_document->'executions') a
             group by a.value->>'symbol',a.value->>'date',(a.value->>'order')::numeric having count(*)>1) then
    raise exception 'Source execution ordering is ambiguous';
  end if;
  if exists (
    select 1 from (
      select sum((case when a.value->>'side'='BUY' then 1 else -1 end) * (a.value->>'shares')::numeric)
        over (partition by a.value->>'symbol' order by a.value->>'date', (a.value->>'order')::numeric,
              (a.value->>'id') collate "C" rows between unbounded preceding and current row) as holding
      from pg_catalog.jsonb_array_elements(p_document->'executions') a
    ) q where q.holding < 0
  ) then raise exception 'Execution would oversell source holdings'; end if;
end;
$$;

-- Include all source identities and every immutable revision in the checkpoint.
-- This also catches a service append that leaves its appExecution unchanged.
create function cloudtrend_ledger_private.source_hash(p_user_id uuid, p_system text) returns text
language sql stable security invoker set search_path = '' as $$
  select cloudtrend_ledger_private.json_hash(pg_catalog.jsonb_build_object(
    'sources',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) order by s.source_record_id collate "C")
      from public.ledger_event_sources s where s.user_id=p_user_id and s.book='ACTUAL' and s.book_id='ACTUAL' and s.source_system=p_system),'[]'::jsonb),
    'events',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.event_id collate "C",e.revision)
      from public.ledger_event_versions e where e.user_id=p_user_id and e.book='ACTUAL' and e.book_id='ACTUAL' and e.source_system=p_system),'[]'::jsonb)
  ))
$$;

create function cloudtrend_ledger_private.assert_reconciled(p_user_id uuid, p_system text, p_document jsonb) returns void
language plpgsql stable security invoker set search_path = '' as $$
declare r public.ledger_event_versions%rowtype; first_event jsonb; e jsonb; s public.ledger_security_versions%rowtype;
  heads integer := 0; total integer; account_id text;
begin
  perform cloudtrend_ledger_private.validate_document(p_document,p_system);
  -- Every permanent source identity must have a complete canonical chain.
  if exists (select 1 from public.ledger_event_sources src where src.user_id=p_user_id and src.book='ACTUAL' and src.book_id='ACTUAL'
       and src.source_system=p_system and not exists (select 1 from public.ledger_event_versions ev where
       ev.user_id=src.user_id and ev.book=src.book and ev.book_id=src.book_id and ev.event_id=src.event_id)) then
    raise exception 'Unreconciled source identity without canonical event';
  end if;
  for r in select distinct on (ev.event_id) ev.* from public.ledger_event_versions ev
    where ev.user_id=p_user_id and ev.book='ACTUAL' and ev.book_id='ACTUAL' and ev.source_system=p_system
    order by ev.event_id, ev.revision desc
  loop
    select count(*), (pg_catalog.jsonb_agg(ev.payload order by ev.revision))->0 into total,first_event
      from public.ledger_event_versions ev where ev.user_id=p_user_id and ev.book='ACTUAL' and ev.book_id='ACTUAL' and ev.event_id=r.event_id;
    if total <> r.revision or exists (
      select 1 from public.ledger_event_versions ev where ev.user_id=p_user_id and ev.book='ACTUAL' and ev.book_id='ACTUAL' and ev.event_id=r.event_id
        and (ev.source_system is distinct from p_system or ev.source_record_id is distinct from r.source_record_id or
          ev.payload->'legacyExecution' is distinct from first_event->'legacyExecution' or
          ev.payload->>'id' is distinct from ev.event_id or ev.payload->>'book' is distinct from ev.book or
          ev.payload->>'bookId' is distinct from ev.book_id or (ev.payload->>'revision')::integer is distinct from ev.revision or
          (ev.payload->>'previousRevision')::integer is distinct from ev.previous_revision or
          ev.payload->>'correctionReason' is distinct from ev.correction_reason or
          ev.payload->>'effectiveDate' is distinct from ev.effective_date::text or
          ev.payload->>'kind' is distinct from ev.event_kind or
          ev.payload#>>'{source,system}' is distinct from ev.source_system or
          ev.payload#>>'{source,recordId}' is distinct from ev.source_record_id or
          ev.payload#>>'{source,revision}' is distinct from ev.source_revision or
          ev.payload#>>'{source,contentHash}' is distinct from ev.content_hash or
          pg_catalog.jsonb_typeof(ev.payload->'voided') is distinct from 'boolean')
    ) then raise exception 'Unreconciled canonical revision chain'; end if;
    select value into e from pg_catalog.jsonb_array_elements(p_document->'executions') where value->>'id'=r.source_record_id;
    if r.payload->'voided' = 'true'::jsonb then
      if e is not null then raise exception 'Voided source execution cannot be reused'; end if;
      e := coalesce(r.payload->'appExecution',r.payload->'legacyExecution');
      if e is null or e='null'::jsonb then raise exception 'Voided source execution lost its audit snapshot'; end if;
    else
      heads := heads+1;
      if e is null or coalesce(r.payload->'appExecution',r.payload->'legacyExecution') is distinct from e then
        raise exception 'Legacy document is not fully reconciled to canonical source executions';
      end if;
    end if;
    select * into s from public.ledger_security_versions where user_id=p_user_id and security_id=r.payload->>'securityId' order by revision desc limit 1;
    if not found or s.payload->>'id' is distinct from s.security_id or s.payload->>'symbol' is distinct from s.symbol or
       s.payload->>'market' is distinct from s.market or s.payload->>'currency' is distinct from s.currency or
       s.symbol is distinct from e->>'symbol' or
       (e->>'market'='ETF' and (s.market='US' or s.payload->>'assetType' is distinct from 'ETF')) or
       (e->>'market'<>'ETF' and s.market is distinct from e->>'market') or
       r.payload->>'currency' is distinct from s.currency then
      raise exception 'Canonical security does not match source execution';
    end if;
    account_id := r.payload#>>'{cashLegs,0,accountId}';
    if r.event_kind is distinct from e->>'side' or r.effective_date::text is distinct from e->>'date' or
       (r.payload->>'effectiveSequence')::numeric is distinct from (e->>'order')::numeric or
       r.payload->>'quantity' is distinct from cloudtrend_ledger_private.js_fixed8((e->>'shares')::double precision) or
       r.payload->>'price' is distinct from cloudtrend_ledger_private.js_fixed8((e->>'price')::double precision) or
       r.payload->>'gross' is distinct from cloudtrend_ledger_private.js_fixed8((e->>'price')::double precision*(e->>'shares')::double precision) or
       r.payload->>'fee' is distinct from cloudtrend_ledger_private.js_fixed8((e->>'fee')::double precision) or
       r.payload->'signalId' is distinct from e->'signalKey' or
       pg_catalog.jsonb_array_length(r.payload->'cashLegs') is distinct from 1 or
       pg_catalog.jsonb_array_length(r.payload->'positionLegs') is distinct from 1 or
       coalesce(account_id,'')='' or
       r.payload#>>'{cashLegs,0,currency}' is distinct from s.currency or
       r.payload#>>'{positionLegs,0,accountId}' is distinct from account_id or
       r.payload#>>'{positionLegs,0,securityId}' is distinct from s.security_id or
       (r.payload#>>'{positionLegs,0,quantity}')::numeric is distinct from
           (case when e->>'side'='BUY' then 1 else -1 end)*(e->>'shares')::numeric or
       (account_id like 'UNASSIGNED:%' and not (r.payload->'issues' ? 'account_mapping_unverified')) then
      raise exception 'Canonical economics do not match source execution';
    end if;
  end loop;
  if heads <> pg_catalog.jsonb_array_length(p_document->'executions') then
    raise exception 'Legacy document has missing or duplicate canonical source coverage';
  end if;
end;
$$;

-- Trigger-only lock, shared with service INSERTs. It does not grant insertion.
-- Role authorization remains the existing table grants/RLS and reviewed RPC.
create function cloudtrend_ledger_private.lock_website_source() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_schema <> 'public' or tg_table_name not in ('ledger_event_sources','ledger_event_versions') or tg_op <> 'INSERT' then
    raise exception 'Invalid website source lock trigger target';
  end if;
  if new.book='ACTUAL' and new.book_id='ACTUAL' and new.source_system in ('portfolio_ledgers','us_actual_portfolio_ledgers') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('website-actual:'||new.user_id::text||':'||new.source_system,0));
  end if;
  return new;
end;
$$;

create function cloudtrend_ledger_private.sync_website_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  bridge cloudtrend_ledger_private.bridge_documents%rowtype;
  system_name text := tg_table_name;
  actor text;
  e jsonb; old_e jsonb; p jsonb; s public.ledger_security_versions%rowtype;
  prior public.ledger_event_versions%rowtype;
  event_id text; v_security_id text; market text; currency text; account_id text;
  event_revision integer; event_hash text;
begin
  if tg_table_schema <> 'public' or system_name not in ('portfolio_ledgers','us_actual_portfolio_ledgers') or tg_op not in ('INSERT','UPDATE','DELETE') then
    raise exception 'Invalid website bridge trigger target';
  end if;
  if tg_op='DELETE' then raise exception 'Website source document deletion is not supported; void executions instead'; end if;
  -- current_setting(role) is the trusted SQL role selected by PostgREST, not a
  -- JWT metadata claim. SECURITY DEFINER does not change this role setting.
  if pg_catalog.current_setting('role',true) = 'service_role' then actor := 'website:service_role';
  elsif auth.uid() is not null and auth.uid()=new.user_id and pg_catalog.current_setting('role',true)='authenticated' then
    actor := 'website:'||auth.uid()::text;
  else raise exception 'Website owner authentication required' using errcode='42501'; end if;
  if tg_op='UPDATE' and new.user_id is distinct from old.user_id then raise exception 'Website owner cannot change'; end if;
  if (tg_op='INSERT' and new.revision is distinct from 1) or
     (tg_op='UPDATE' and (old.revision=2147483647 or new.revision is distinct from old.revision+1)) then
    raise exception 'Website revision must advance exactly once';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('website-actual:'||new.user_id::text||':'||system_name,0));
  perform cloudtrend_ledger_private.validate_document(new.payload,system_name);
  select * into bridge from cloudtrend_ledger_private.bridge_documents where user_id=new.user_id and source_system=system_name for update;
  if tg_op='INSERT' then
    if found then raise exception 'Website document already exists' using errcode='23505'; end if;
    if exists (select 1 from public.ledger_event_sources where user_id=new.user_id and book='ACTUAL' and book_id='ACTUAL' and source_system=system_name) then
      raise exception 'Existing canonical source requires explicit reconciliation before document creation';
    end if;
  else
    if not found or bridge.document_revision is distinct from old.revision or
       bridge.document_hash is distinct from cloudtrend_ledger_private.json_hash(old.payload) or
       bridge.ledger_hash is distinct from cloudtrend_ledger_private.source_hash(new.user_id,system_name) then
      raise exception 'Website document and canonical ledger heads diverged; reconciliation required';
    end if;
    perform cloudtrend_ledger_private.assert_reconciled(new.user_id,system_name,old.payload);
  end if;

  for e in select value from pg_catalog.jsonb_array_elements(new.payload->'executions') loop
    old_e := null;
    if tg_op='UPDATE' then
      select value into old_e from pg_catalog.jsonb_array_elements(old.payload->'executions') where value->>'id'=e->>'id';
    end if;
    if old_e is not distinct from e then continue; end if;
    select * into prior from public.ledger_event_versions where user_id=new.user_id and book='ACTUAL' and book_id='ACTUAL'
      and source_system=system_name and source_record_id=e->>'id' order by revision desc limit 1;
    if old_e is null and found then raise exception 'Source execution identity cannot be reused'; end if;
    if old_e is not null and not found then raise exception 'Source execution has no canonical predecessor'; end if;
    if old_e is not null and (e->>'symbol' is distinct from old_e->>'symbol' or e->>'market' is distinct from old_e->>'market') then
      raise exception 'Correction must preserve source security identity';
    end if;
    v_security_id := coalesce(prior.payload->>'securityId',(case when e->>'market'='US' then 'US:' else 'KR:' end)|| (e->>'symbol'));
    select * into s from public.ledger_security_versions where user_id=new.user_id and ledger_security_versions.security_id=v_security_id order by revision desc limit 1;
    if not found then
      market := case when e->>'market'='ETF' then 'KOSPI' else e->>'market' end;
      currency := case when market='US' then 'USD' else 'KRW' end;
      p := pg_catalog.jsonb_build_object('id',v_security_id,'symbol',e->>'symbol','name',e->>'name','market',market,
        'assetType',case when e->>'market'='ETF' then 'ETF' else 'UNKNOWN' end,'currency',currency,'notionPageId',null);
      insert into public.ledger_security_versions(user_id,security_id,revision,symbol,market,currency,payload)
        values(new.user_id,v_security_id,1,e->>'symbol',market,currency,p);
      select * into strict s from public.ledger_security_versions where user_id=new.user_id and ledger_security_versions.security_id=v_security_id and revision=1;
    end if;
    if s.symbol is distinct from e->>'symbol' or
       (e->>'market'='ETF' and (s.market='US' or s.payload->>'assetType' is distinct from 'ETF')) or
       (e->>'market'<>'ETF' and s.market is distinct from e->>'market') then raise exception 'Source security market conflict'; end if;
    event_id := coalesce(prior.event_id,system_name||':'||(e->>'id'));
    event_revision := coalesce(prior.revision,0)+1;
    if old_e is null then
      account_id := 'UNASSIGNED:'||system_name;
      p := pg_catalog.jsonb_build_object(
        'id',event_id,'book','ACTUAL','bookId','ACTUAL','legacyExecution',null,
        'settlementDate',null,'tax',null,'cashLegs',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('accountId',account_id,'currency',s.currency,'amount',null)),
        'positionLegs',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('accountId',account_id,'securityId',s.security_id,'quantity','0','basisAdjustment',null)),
        'evidence','[]'::jsonb,'brokerEventId',null,'strategyId',null,'orderId',null,
        'issues',pg_catalog.jsonb_build_array('account_mapping_unverified','legacy_settlement_unknown','legacy_tax_unverified','broker_net_cash_unverified','opening_balance_unverified'),
        'source',pg_catalog.jsonb_build_object('system',system_name,'recordId',e->>'id')) - 'legacyExecution';
    else
      p := prior.payload;
      -- A website fill cannot revise already verified broker settlement or cost
      -- basis. Those enriched events need the reviewed correction workflow.
      if (p#>'{cashLegs,0,amount}') is distinct from 'null'::jsonb or p->'tax' is distinct from 'null'::jsonb or
         p->'settlementDate' is distinct from 'null'::jsonb or p#>'{positionLegs,0,basisAdjustment}' is distinct from 'null'::jsonb then
        raise exception 'Broker-enriched execution requires a reviewed correction';
      end if;
    end if;
    -- Preserve prior source references even when an older client omits the optional field.
    -- Original legacyExecution and every previous event payload remain untouched.
    if p ? 'sourceLinks' or e ? 'sourceLinks' then
      p := p || pg_catalog.jsonb_build_object('sourceLinks', (
        select coalesce(pg_catalog.jsonb_agg(value order by first_seen),'[]'::jsonb)
        from (select value,min(ordinality) as first_seen
          from pg_catalog.jsonb_array_elements(coalesce(p->'sourceLinks','[]'::jsonb) || coalesce(e->'sourceLinks','[]'::jsonb)) with ordinality
          group by value) links
      ));
      perform cloudtrend_ledger_private.validate_source_links(p->'sourceLinks');
    end if;
    event_hash := cloudtrend_ledger_private.json_hash(pg_catalog.jsonb_build_object('sourceSystem',system_name,'documentRevision',new.revision,'execution',e));
    p := p || pg_catalog.jsonb_build_object('appExecution',e,'revision',event_revision,'previousRevision',prior.revision,
      'correctionReason',case when prior.revision is null then null else 'Website execution correction at document revision '||new.revision::text end,
      'recordedAt',pg_catalog.to_char(pg_catalog.statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recordedBy',actor,
      'effectiveDate',e->>'date','effectiveSequence',(e->>'order')::numeric,'kind',e->>'side','voided',false,
      'securityId',s.security_id,'currency',s.currency,'quantity',cloudtrend_ledger_private.js_fixed8((e->>'shares')::double precision),
      'price',cloudtrend_ledger_private.js_fixed8((e->>'price')::double precision),
      'gross',cloudtrend_ledger_private.js_fixed8((e->>'price')::double precision*(e->>'shares')::double precision),
      'fee',cloudtrend_ledger_private.js_fixed8((e->>'fee')::double precision),'signalId',e->'signalKey',
      'source',(p->'source')||pg_catalog.jsonb_build_object('revision',new.revision::text,'contentHash',event_hash));
    p := pg_catalog.jsonb_set(p,'{positionLegs,0,quantity}',pg_catalog.to_jsonb((case when e->>'side'='SELL' then '-' else '' end)||cloudtrend_ledger_private.js_fixed8((e->>'shares')::double precision)));
    if prior.revision is null then
      insert into public.ledger_event_sources(user_id,book,book_id,source_system,source_record_id,event_id)
        values(new.user_id,'ACTUAL','ACTUAL',system_name,e->>'id',event_id);
    end if;
    insert into public.ledger_event_versions(user_id,book,book_id,event_id,revision,previous_revision,correction_reason,effective_date,event_kind,source_system,source_record_id,source_revision,content_hash,payload,recorded_at)
      values(new.user_id,'ACTUAL','ACTUAL',event_id,event_revision,prior.revision,p->>'correctionReason',(e->>'date')::date,e->>'side',system_name,e->>'id',new.revision::text,event_hash,p,(p->>'recordedAt')::timestamptz);
  end loop;

  if tg_op='UPDATE' then
    for old_e in select value from pg_catalog.jsonb_array_elements(old.payload->'executions') a
      where not exists (select 1 from pg_catalog.jsonb_array_elements(new.payload->'executions') b where b.value->>'id'=a.value->>'id')
    loop
      select * into strict prior from public.ledger_event_versions where user_id=new.user_id and book='ACTUAL' and book_id='ACTUAL'
        and source_system=system_name and source_record_id=old_e->>'id' order by revision desc limit 1;
      event_hash := cloudtrend_ledger_private.json_hash(pg_catalog.jsonb_build_object('sourceSystem',system_name,'documentRevision',new.revision,'voidedExecution',old_e));
      p := prior.payload || pg_catalog.jsonb_build_object('revision',prior.revision+1,'previousRevision',prior.revision,
        'correctionReason','Website execution removed at document revision '||new.revision::text,'voided',true,
        'recordedAt',pg_catalog.to_char(pg_catalog.statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recordedBy',actor,
        'source',(prior.payload->'source')||pg_catalog.jsonb_build_object('revision',new.revision::text,'contentHash',event_hash));
      insert into public.ledger_event_versions(user_id,book,book_id,event_id,revision,previous_revision,correction_reason,effective_date,event_kind,source_system,source_record_id,source_revision,content_hash,payload,recorded_at)
        values(new.user_id,'ACTUAL','ACTUAL',prior.event_id,prior.revision+1,prior.revision,p->>'correctionReason',prior.effective_date,prior.event_kind,system_name,prior.source_record_id,new.revision::text,event_hash,p,(p->>'recordedAt')::timestamptz);
    end loop;
  end if;
  perform cloudtrend_ledger_private.assert_reconciled(new.user_id,system_name,new.payload);
  insert into cloudtrend_ledger_private.bridge_documents(user_id,source_system,document_revision,document_hash,ledger_hash)
    values(new.user_id,system_name,new.revision,cloudtrend_ledger_private.json_hash(new.payload),cloudtrend_ledger_private.source_hash(new.user_id,system_name))
    on conflict (user_id,source_system) do update set document_revision=excluded.document_revision,document_hash=excluded.document_hash,ledger_hash=excluded.ledger_hash;
  return new;
end;
$$;

-- Single SQL statement => one MVCC snapshot for document, all revisions and
-- relevant latest security identities. Invoker + existing owner SELECT RLS.
create function public.ledger_read_website_document(p_user_id uuid,p_source_system text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with document as (
    select revision,payload from public.portfolio_ledgers where user_id=p_user_id and p_source_system='portfolio_ledgers'
    union all
    select revision,payload from public.us_actual_portfolio_ledgers where user_id=p_user_id and p_source_system='us_actual_portfolio_ledgers'
  ), source_identities as (
    select source_record_id,event_id from public.ledger_event_sources where user_id=p_user_id and book='ACTUAL' and book_id='ACTUAL' and source_system=p_source_system
  ), events as materialized (
    select ev.* from public.ledger_event_versions ev where user_id=p_user_id and book='ACTUAL' and book_id='ACTUAL' and source_system=p_source_system
  ), securities as (
    select distinct on (s.security_id) s.* from public.ledger_security_versions s
    where s.user_id=p_user_id and exists (select 1 from events e where e.payload->>'securityId'=s.security_id)
    order by s.security_id,s.revision desc
  )
  select case when d.revision is null and not exists(select 1 from source_identities) and not exists(select 1 from events) then null
  else pg_catalog.jsonb_build_object('revision',d.revision,'payload',d.payload,
    'integrityValid',d.revision is not null and not exists (
      select 1 from events ev where
        ev.payload->>'id' is distinct from ev.event_id or ev.payload->>'book' is distinct from ev.book or
        ev.payload->>'bookId' is distinct from ev.book_id or (ev.payload->>'revision')::integer is distinct from ev.revision or
        (ev.payload->>'previousRevision')::integer is distinct from ev.previous_revision or
        ev.payload->>'correctionReason' is distinct from ev.correction_reason or
        ev.payload->>'effectiveDate' is distinct from ev.effective_date::text or
        ev.payload->>'kind' is distinct from ev.event_kind or
        ev.payload#>>'{source,system}' is distinct from ev.source_system or
        ev.payload#>>'{source,recordId}' is distinct from ev.source_record_id or
        ev.payload#>>'{source,revision}' is distinct from ev.source_revision or
        ev.payload#>>'{source,contentHash}' is distinct from ev.content_hash or
        (ev.payload->>'recordedAt')::timestamptz is distinct from ev.recorded_at
    ) and not exists (
      select 1 from securities s where s.payload->>'id' is distinct from s.security_id or
        s.payload->>'symbol' is distinct from s.symbol or s.payload->>'market' is distinct from s.market or
        s.payload->>'currency' is distinct from s.currency
    ),
    'sourceIdentities',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('sourceRecordId',s.source_record_id,'eventId',s.event_id) order by s.source_record_id) from source_identities s),'[]'::jsonb),
    'events',coalesce((select pg_catalog.jsonb_agg(e.payload order by e.event_id,e.revision) from events e),'[]'::jsonb),
    'securities',coalesce((select pg_catalog.jsonb_agg(s.payload order by s.security_id) from securities s),'[]'::jsonb)) end from (select 1) anchor left join document d on true
$$;
revoke all on function public.ledger_read_website_document(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.ledger_read_website_document(uuid,text) to authenticated,service_role;

-- Nothing in this private namespace can be called directly by API roles.
revoke all on all functions in schema cloudtrend_ledger_private from public,anon,authenticated,service_role;

-- Lock sources and canonical append tables for the short activation transaction.
-- Any unreconciled preexisting state aborts every DDL change above.
lock table public.portfolio_ledgers,public.us_actual_portfolio_ledgers in share row exclusive mode;
lock table public.ledger_event_sources,public.ledger_event_versions,public.ledger_security_versions in share row exclusive mode;
do $$
declare r record;
begin
  if exists (
    select 1 from public.ledger_event_sources s where s.book='ACTUAL' and s.book_id='ACTUAL' and
      ((s.source_system='portfolio_ledgers' and not exists (select 1 from public.portfolio_ledgers d where d.user_id=s.user_id)) or
       (s.source_system='us_actual_portfolio_ledgers' and not exists (select 1 from public.us_actual_portfolio_ledgers d where d.user_id=s.user_id)))
  ) then raise exception 'Canonical website source has no matching legacy document'; end if;
  for r in select user_id,revision,payload,'portfolio_ledgers'::text as system_name from public.portfolio_ledgers
    union all select user_id,revision,payload,'us_actual_portfolio_ledgers' from public.us_actual_portfolio_ledgers
  loop
    perform cloudtrend_ledger_private.assert_reconciled(r.user_id,r.system_name,r.payload);
    insert into cloudtrend_ledger_private.bridge_documents values(r.user_id,r.system_name,r.revision,
      cloudtrend_ledger_private.json_hash(r.payload),cloudtrend_ledger_private.source_hash(r.user_id,r.system_name));
  end loop;
end;
$$;
create trigger serialize_website_source before insert on public.ledger_event_sources for each row execute function cloudtrend_ledger_private.lock_website_source();
create trigger serialize_website_source before insert on public.ledger_event_versions for each row execute function cloudtrend_ledger_private.lock_website_source();
create trigger reject_website_truncate before truncate on public.portfolio_ledgers for each statement execute function cloudtrend_ledger_private.sync_website_document();
create trigger reject_website_truncate before truncate on public.us_actual_portfolio_ledgers for each statement execute function cloudtrend_ledger_private.sync_website_document();
create trigger sync_unified_actual after insert or update or delete on public.portfolio_ledgers for each row execute function cloudtrend_ledger_private.sync_website_document();
create trigger sync_unified_actual after insert or update or delete on public.us_actual_portfolio_ledgers for each row execute function cloudtrend_ledger_private.sync_website_document();
commit;
