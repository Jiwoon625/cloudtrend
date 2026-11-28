-- Additive owner-private master snapshot. Does not touch legacy or screening tables.
create table public.manual_security_master (
  user_id uuid primary key references auth.users(id),
  revision integer not null check (revision > 0),
  as_of date not null,
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 1 and 2000 and octet_length(rows::text) <= 4000000),
  review_status text not null default 'pending' check (review_status in ('pending','confirmed')),
  saved_at timestamptz not null default now()
);
alter table public.manual_security_master enable row level security;
revoke all on public.manual_security_master from public, anon, authenticated;
grant select, insert on public.manual_security_master to authenticated;
grant update (revision, as_of, rows, review_status, saved_at) on public.manual_security_master to authenticated;
create policy master_read on public.manual_security_master for select to authenticated using ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false));
create policy master_insert on public.manual_security_master for insert to authenticated with check ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false));
create policy master_update on public.manual_security_master for update to authenticated using ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false)) with check ((select auth.uid()) = user_id and not coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false));

-- Guard writes at the database boundary as well as in the UI/server.
create function public.manual_security_master_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
declare
  item jsonb;
  k text;
  v text;
  key_id text;
  identities text[] := array[]::text[];
  required_keys text[] := array['symbol','name','listing','assetType','currency','quantity','averageKrw','amountKrw','buyQuantity','buyAmount','sellQuantity','sellAmount','sellCost','realized','dividends','fees','start','lastSell'];
  number_keys text[] := array['quantity','averageKrw','amountKrw','buyQuantity','buyAmount','sellQuantity','sellAmount','sellCost','realized','dividends','fees'];
begin
  if new.as_of > (now() at time zone 'Asia/Seoul')::date then raise exception 'Future snapshot'; end if;
  if TG_OP = 'INSERT' then
    if new.revision <> 1 then raise exception 'Initial revision must be one'; end if;
  else
    if new.user_id <> old.user_id or new.revision <> old.revision + 1 or new.as_of < old.as_of then
      raise exception 'Invalid revision, owner, or snapshot date';
    end if;
  end if;
  for item in select value from jsonb_array_elements(new.rows) loop
    if jsonb_typeof(item) <> 'object' or not (item ?& required_keys) or (select count(*) from jsonb_object_keys(item)) <> cardinality(required_keys) then raise exception 'Invalid master columns'; end if;
    foreach k in array required_keys loop
      if jsonb_typeof(item->k) <> 'string' or length(item->>k)>240 then raise exception 'Invalid field %',k; end if;
    end loop;
    if btrim(item->>'name')='' or item->>'listing' not in ('KOSPI','KOSDAQ','미국') or item->>'assetType' not in ('주식','ETF') then raise exception 'Invalid security'; end if;
    if item->>'listing'='미국' then
      if item->>'currency'<>'USD' or item->>'symbol' !~ '^[A-Z0-9][A-Z0-9.-]{0,19}$' then raise exception 'Invalid US security'; end if;
      key_id := 'US:'||(item->>'symbol');
    else
      if item->>'currency'<>'KRW' or item->>'symbol' !~ '^[0-9A-Z]{6}$' then raise exception 'Invalid KR security'; end if;
      key_id := 'KR:'||(item->>'symbol');
    end if;
    if key_id=any(identities) then raise exception 'Duplicate security'; end if;
    identities := array_append(identities,key_id);
    foreach k in array number_keys loop
      v := item->>k;
      if v='' then continue; end if;
      if v !~ '^-?[0-9]+(\.[0-9]{1,12})?$' then raise exception 'Invalid numeric field %',k; end if;
      if abs(v::numeric)>1e15 or (k<>'realized' and v::numeric<0) then raise exception 'Numeric range %',k; end if;
    end loop;
    if item->>'quantity'='' then raise exception 'Missing quantity'; end if;
    if (item->>'quantity')::numeric>0 then
      if coalesce(nullif(item->>'averageKrw','')::numeric,0)<=0 or coalesce(nullif(item->>'amountKrw','')::numeric,0)<=0 or item->>'start'='' then raise exception 'Missing held basis/date'; end if;
    else
      if coalesce(nullif(item->>'averageKrw','')::numeric,0)<>0 or coalesce(nullif(item->>'amountKrw','')::numeric,0)<>0 then raise exception 'Nonzero closed basis'; end if;
    end if;
    foreach k in array array['start','lastSell'] loop
      v:=item->>k;
      if v<>'' and (v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v::date>new.as_of) then raise exception 'Invalid security date'; end if;
    end loop;
  end loop;
  if TG_OP='UPDATE' and exists(
    select 1 from jsonb_array_elements(old.rows) x
    where not ((case when x->>'listing'='미국' then 'US:' else 'KR:' end)||(x->>'symbol'))=any(identities)
  ) then raise exception 'Existing securities cannot be removed'; end if;
  new.saved_at:=now();
  return new;
end;
$$;
revoke all on function public.manual_security_master_guard() from public,anon,authenticated;
create trigger manual_security_master_guard before insert or update on public.manual_security_master
for each row execute function public.manual_security_master_guard();
