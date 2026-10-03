-- Store one validated original object per source. The calculation engine
-- revalidates and normalizes it before use, avoiding a second normalized copy.
drop policy if exists cloudtrend_owner_insert_source on storage.objects;
create policy cloudtrend_owner_insert_source
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'source'
  and (storage.foldername(name))[3] in ('screening', 'backtest')
  and (storage.foldername(name))[4] ~ '^[0-9a-f-]{36}$'
  and lower(name) ~ '[.](csv|txt|json|xlsx)$'
);

drop policy if exists cloudtrend_owner_update_source on storage.objects;
create policy cloudtrend_owner_update_source
on storage.objects for update to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'source'
)
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'source'
  and (storage.foldername(name))[3] in ('screening', 'backtest')
  and (storage.foldername(name))[4] ~ '^[0-9a-f-]{36}$'
  and lower(name) ~ '[.](csv|txt|json|xlsx)$'
);

drop policy if exists cloudtrend_owner_insert_staging on storage.objects;
create policy cloudtrend_owner_insert_staging
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'staging'
  and lower(name) ~ '[.](csv|txt|json|xlsx)$'
);

drop policy if exists cloudtrend_owner_update_staging on storage.objects;
create policy cloudtrend_owner_update_staging
on storage.objects for update to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'staging'
)
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] = 'staging'
  and lower(name) ~ '[.](csv|txt|json|xlsx)$'
);
