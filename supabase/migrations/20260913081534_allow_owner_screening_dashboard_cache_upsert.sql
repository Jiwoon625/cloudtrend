
create policy "cloudtrend_owner_insert_cache"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    name = (select auth.uid())::text || '/cache/screening/latest.json'
    or name = (select auth.uid())::text || '/cache/dashboard/latest.json'
    or name ~ ('^' || (select auth.uid())::text || '/cache/instruments/[A-Za-z0-9._-]+[.]json[.]gz$')
  )
);

create policy "cloudtrend_owner_update_cache"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    name = (select auth.uid())::text || '/cache/screening/latest.json'
    or name = (select auth.uid())::text || '/cache/dashboard/latest.json'
    or name ~ ('^' || (select auth.uid())::text || '/cache/instruments/[A-Za-z0-9._-]+[.]json[.]gz$')
  )
)
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    name = (select auth.uid())::text || '/cache/screening/latest.json'
    or name = (select auth.uid())::text || '/cache/dashboard/latest.json'
    or name ~ ('^' || (select auth.uid())::text || '/cache/instruments/[A-Za-z0-9._-]+[.]json[.]gz$')
  )
);