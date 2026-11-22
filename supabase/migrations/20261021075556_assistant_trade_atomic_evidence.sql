begin;

-- Evidence is shared across currency books, including direct/imported executions.
create function cloudtrend_ledger_private.notion_evidence(p_payload jsonb)
returns table(execution_id text, evidence text)
language sql immutable set search_path = '' as $$
  select distinct e->>'id', r[1]
  from pg_catalog.jsonb_array_elements(coalesce(p_payload->'executions','[]'::jsonb)) e
  cross join lateral (
    select p_payload->'newActualPortfolio'->'assignments'->(e->>'id')->>'brokerReference' as ref
    union all
    select link->>'url' from pg_catalog.jsonb_array_elements(coalesce(e->'sourceLinks','[]'::jsonb)) link
  ) refs
  cross join lateral pg_catalog.regexp_matches(pg_catalog.replace(pg_catalog.lower(refs.ref),'-',''), '[0-9a-f]{32}', 'g') r
$$;
revoke all on function cloudtrend_ledger_private.notion_evidence(jsonb) from public;

create function cloudtrend_ledger_private.guard_cross_book_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare other_payload jsonb;
begin
  -- All website writers share this lock, so simultaneous KR/US approvals cannot
  -- each observe the other currency's old document and both commit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('actual-evidence:'||new.user_id::text,0));
  if tg_table_name = 'portfolio_ledgers' then
    select payload into other_payload from public.us_actual_portfolio_ledgers where user_id=new.user_id;
  else
    select payload into other_payload from public.portfolio_ledgers where user_id=new.user_id;
  end if;
  if exists (
    select 1 from cloudtrend_ledger_private.notion_evidence(new.payload) n
    join cloudtrend_ledger_private.notion_evidence(other_payload) o using(evidence)
  ) or exists (
    select evidence from cloudtrend_ledger_private.notion_evidence(new.payload)
    group by evidence having count(distinct execution_id)>1
  ) then
    raise exception 'Notion evidence already belongs to an execution' using errcode='23505';
  end if;
  return new;
end $$;
revoke all on function cloudtrend_ledger_private.guard_cross_book_evidence() from public;
create trigger guard_cross_book_evidence before insert or update on public.portfolio_ledgers
for each row execute function cloudtrend_ledger_private.guard_cross_book_evidence();
create trigger guard_cross_book_evidence before insert or update on public.us_actual_portfolio_ledgers
for each row execute function cloudtrend_ledger_private.guard_cross_book_evidence();

-- This invoker RPC uses the same owner JWT, RLS, CAS and canonical bridge.
-- A failed state transition rolls back the document AND canonical journal write.
create function public.assistant_trade_commit(p_id uuid,p_token uuid,p_source text,p_revision integer,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare p public.assistant_trade_proposals%rowtype; v_revision integer;
begin
  if auth.uid() is distinct from 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'::uuid then
    raise exception 'assistant trade owner required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('actual-evidence:'||auth.uid()::text,0));
  select * into p from public.assistant_trade_proposals where id=p_id and user_id=auth.uid();
  if p.status is distinct from 'PROCESSING' or p.processing_token is distinct from p_token or
     p_source is distinct from (case when p.trade->>'market'='US' then 'us_actual_portfolio_ledgers' else 'portfolio_ledgers' end) then
    raise exception 'Approval claim or market changed';
  end if;
  if p_source='us_actual_portfolio_ledgers' then
    update public.us_actual_portfolio_ledgers set payload=p_payload,revision=revision+1,updated_at=pg_catalog.now()
    where user_id=auth.uid() and revision=p_revision returning revision into v_revision;
  else
    update public.portfolio_ledgers set payload=p_payload,revision=revision+1,updated_at=pg_catalog.now()
    where user_id=auth.uid() and revision=p_revision returning revision into v_revision;
  end if;
  if v_revision is null then raise exception 'Ledger revision changed' using errcode='40001'; end if;
  if not public.assistant_trade_record(p_id,p_token) then raise exception 'Approval does not match canonical execution'; end if;
  return pg_catalog.jsonb_build_object('revision',v_revision);
end $$;
revoke all on function public.assistant_trade_commit(uuid,uuid,text,integer,jsonb) from public,anon;
grant execute on function public.assistant_trade_commit(uuid,uuid,text,integer,jsonb) to authenticated;
commit;
