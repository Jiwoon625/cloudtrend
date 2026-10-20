-- The owner JWT may transition only its own proposal. Actual ledger writes
-- continue through ledger_write_website_document and its owner/CAS checks.
begin;

create function public.assistant_trade_claim(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_token uuid := pg_catalog.gen_random_uuid();
begin
  if auth.uid() is distinct from 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'::uuid then
    raise exception 'assistant trade owner required' using errcode = '42501';
  end if;
  update public.assistant_trade_proposals
     set status = 'PROCESSING', processing_token = v_token,
         processing_started_at = pg_catalog.now(), reviewed_at = pg_catalog.now()
   where id = p_id and user_id = auth.uid()
     and (status = 'PENDING' or
          (status = 'PROCESSING' and processing_started_at < pg_catalog.now() - interval '120 seconds'));
  if not found then return null; end if;
  return v_token;
end $$;

create function public.assistant_trade_reject(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is distinct from 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'::uuid then
    raise exception 'assistant trade owner required' using errcode = '42501';
  end if;
  update public.assistant_trade_proposals
     set status = 'REJECTED', reviewed_at = pg_catalog.now()
   where id = p_id and user_id = auth.uid() and status = 'PENDING';
  return found;
end $$;

create function public.assistant_trade_release(p_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is distinct from 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'::uuid then
    raise exception 'assistant trade owner required' using errcode = '42501';
  end if;
  update public.assistant_trade_proposals
     set status = 'PENDING', reviewed_at = null,
         processing_token = null, processing_started_at = null
   where id = p_id and user_id = auth.uid() and status = 'PROCESSING'
     and processing_token = p_token;
  return found;
end $$;

create function public.assistant_trade_record(p_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_execution_id text := 'new-actual:' || p_id::text;
begin
  if auth.uid() is distinct from 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'::uuid then
    raise exception 'assistant trade owner required' using errcode = '42501';
  end if;
  -- The canonical BUY and current document must agree with this very proposal.
  -- A caller cannot mark RECORDED merely by knowing a processing token.
  update public.assistant_trade_proposals p
     set status = 'RECORDED', ledger_execution_id = v_execution_id,
         processing_token = null, processing_started_at = null,
         reviewed_at = pg_catalog.now()
   where p.id = p_id and p.user_id = auth.uid()
     and p.status = 'PROCESSING' and p.processing_token = p_token
     and p.trade->>'sourcePageId' = p.source_page_id::text
     and exists (
       select 1 from public.ledger_event_sources s
       join public.ledger_event_versions ev
         on ev.user_id = s.user_id and ev.book = s.book and ev.book_id = s.book_id
        and ev.event_id = s.event_id and ev.source_system = s.source_system
        and ev.source_record_id = s.source_record_id
       where s.user_id = p.user_id and s.book = 'ACTUAL' and s.book_id = 'ACTUAL'
         and s.source_system = 'portfolio_ledgers' and s.source_record_id = v_execution_id
         and ev.event_kind = 'BUY'
     )
     and exists (
       select 1 from public.portfolio_ledgers d,
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
     );
  return found;
end $$;

revoke all on function public.assistant_trade_claim(uuid) from public, anon;
revoke all on function public.assistant_trade_reject(uuid) from public, anon;
revoke all on function public.assistant_trade_release(uuid,uuid) from public, anon;
revoke all on function public.assistant_trade_record(uuid,uuid) from public, anon;
grant execute on function public.assistant_trade_claim(uuid) to authenticated;
grant execute on function public.assistant_trade_reject(uuid) to authenticated;
grant execute on function public.assistant_trade_release(uuid,uuid) to authenticated;
grant execute on function public.assistant_trade_record(uuid,uuid) to authenticated;
commit;
