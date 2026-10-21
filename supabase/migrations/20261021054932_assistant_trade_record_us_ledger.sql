-- Extend proposal recording to validate the ledger selected by the proposal market.
-- The website writes US fills to us_actual_portfolio_ledgers; KR fills remain
-- in portfolio_ledgers. Keep the source registry and execution checks aligned.
begin;

create or replace function public.assistant_trade_record(p_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_execution_id text := 'new-actual:' || p_id::text;
begin
  if auth.uid() is distinct from 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'::uuid then
    raise exception 'assistant trade owner required' using errcode = '42501';
  end if;

  update public.assistant_trade_proposals p
     set status = 'RECORDED', ledger_execution_id = v_execution_id,
         processing_token = null, processing_started_at = null,
         reviewed_at = pg_catalog.now()
   where p.id = p_id and p.user_id = auth.uid()
     and p.status = 'PROCESSING' and p.processing_token = p_token
     and p.trade->>'sourcePageId' = p.source_page_id::text
     and p.trade->>'market' in ('KOSPI', 'KOSDAQ', 'US')
     and exists (
       select 1
       from public.ledger_event_sources s
       join public.ledger_event_versions ev
         on ev.user_id = s.user_id and ev.book = s.book and ev.book_id = s.book_id
        and ev.event_id = s.event_id and ev.source_system = s.source_system
        and ev.source_record_id = s.source_record_id
       where s.user_id = p.user_id and s.book = 'ACTUAL' and s.book_id = 'ACTUAL'
         and s.source_system = case
           when p.trade->>'market' = 'US' then 'us_actual_portfolio_ledgers'
           else 'portfolio_ledgers'
         end
         and s.source_record_id = v_execution_id
         and ev.event_kind = 'BUY'
     )
     and (
       (
         p.trade->>'market' = 'US'
         and exists (
           select 1
           from public.us_actual_portfolio_ledgers d,
                pg_catalog.jsonb_array_elements(d.payload->'executions') e
           where d.user_id = p.user_id and e->>'id' = v_execution_id
             and e->>'side' = 'BUY'
             and e->'date' = p.trade->'date' and e->'name' = p.trade->'name'
             and e->'market' = p.trade->'market' and e->'symbol' = p.trade->'symbol'
             and e->'shares' = p.trade->'shares' and e->'price' = p.trade->'price'
             and e->'fee' = p.trade->'fee'
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->'quantity' = p.trade->'shares'
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->'gross' =
               pg_catalog.to_jsonb(((p.trade->>'shares')::numeric * (p.trade->>'price')::numeric))
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->'fee' = p.trade->'fee'
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->>'brokerReference' =
               'notion:' || p.source_page_id::text
         )
       )
       or
       (
         p.trade->>'market' in ('KOSPI', 'KOSDAQ')
         and exists (
           select 1
           from public.portfolio_ledgers d,
                pg_catalog.jsonb_array_elements(d.payload->'executions') e
           where d.user_id = p.user_id and e->>'id' = v_execution_id
             and e->>'side' = 'BUY'
             and e->'date' = p.trade->'date' and e->'name' = p.trade->'name'
             and e->'market' = p.trade->'market' and e->'symbol' = p.trade->'symbol'
             and e->'shares' = p.trade->'shares' and e->'price' = p.trade->'price'
             and e->'fee' = p.trade->'fee'
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->'quantity' = p.trade->'shares'
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->'gross' =
               pg_catalog.to_jsonb(((p.trade->>'shares')::numeric * (p.trade->>'price')::numeric))
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->'fee' = p.trade->'fee'
             and d.payload->'newActualPortfolio'->'assignments'->v_execution_id->>'brokerReference' =
               'notion:' || p.source_page_id::text
         )
       )
     );

  return found;
end $$;

commit;
