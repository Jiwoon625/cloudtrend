-- Reference copy of remote migration cloudtrend_private_files_and_history.
-- Already applied to cloudtrend. Do not reapply to an initialized database.
create table public.screening_history (
 user_id uuid not null references auth.users(id) on delete cascade,
 date date not null,
 snapshot jsonb not null check (octet_length(snapshot::text) <= 1048576),
 primary key (user_id,date)
);
alter table public.screening_history enable row level security;
grant select,insert,update,delete on public.screening_history to authenticated;
create policy history_owner on public.screening_history for all to authenticated
 using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create function public.trim_screening_history() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
 delete from public.screening_history where user_id=new.user_id and date in (
 select date from public.screening_history where user_id=new.user_id order by date desc offset 90
 );
 return new;
end $$;
revoke execute on function public.trim_screening_history() from public, anon, authenticated;
create trigger keep_90_snapshots after insert on public.screening_history for each row execute function public.trim_screening_history();
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
 values ('cloudtrend-data','cloudtrend-data',false,47185920,array['application/json']);
create policy cloudtrend_owner_read on storage.objects for select to authenticated
 using (bucket_id='cloudtrend-data' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy cloudtrend_owner_insert on storage.objects for insert to authenticated
 with check (bucket_id='cloudtrend-data' and name in ((select auth.uid())::text||'/kr.json',(select auth.uid())::text||'/us.json',(select auth.uid())::text||'/backtest.json'));
create policy cloudtrend_owner_update on storage.objects for update to authenticated
 using (bucket_id='cloudtrend-data' and (storage.foldername(name))[1]=(select auth.uid())::text)
 with check (bucket_id='cloudtrend-data' and name in ((select auth.uid())::text||'/kr.json',(select auth.uid())::text||'/us.json',(select auth.uid())::text||'/backtest.json'));
create policy cloudtrend_owner_delete on storage.objects for delete to authenticated
 using (bucket_id='cloudtrend-data' and (storage.foldername(name))[1]=(select auth.uid())::text);
