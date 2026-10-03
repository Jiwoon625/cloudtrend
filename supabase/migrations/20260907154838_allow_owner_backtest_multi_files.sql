create policy cloudtrend_owner_insert_backtest_multi on storage.objects for insert to authenticated
 with check (
   bucket_id='cloudtrend-data'
   and (storage.foldername(name))[1]=(select auth.uid())::text
   and (storage.foldername(name))[2]='backtest'
   and name like '%.json'
 );
create policy cloudtrend_owner_update_backtest_multi on storage.objects for update to authenticated
 using (
   bucket_id='cloudtrend-data'
   and (storage.foldername(name))[1]=(select auth.uid())::text
   and (storage.foldername(name))[2]='backtest'
 )
 with check (
   bucket_id='cloudtrend-data'
   and (storage.foldername(name))[1]=(select auth.uid())::text
   and (storage.foldername(name))[2]='backtest'
   and name like '%.json'
 );