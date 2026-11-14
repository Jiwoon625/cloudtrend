-- Screening/dashboard pointers are stored gzip-encoded (see docs/screening-cache-gzip.md).
-- The uncompressed objects stay writable so a deploy that only knows the old layout still
-- works while the change rolls out; the compressed object is what the app writes from now on.
create policy "cloudtrend_owner_insert_compressed_cache"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    name = (select auth.uid())::text || '/cache/screening/latest.json.gz'
    or name = (select auth.uid())::text || '/cache/dashboard/latest.json.gz'
  )
);

create policy "cloudtrend_owner_update_compressed_cache"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    name = (select auth.uid())::text || '/cache/screening/latest.json.gz'
    or name = (select auth.uid())::text || '/cache/dashboard/latest.json.gz'
  )
)
with check (
  bucket_id = 'cloudtrend-data'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    name = (select auth.uid())::text || '/cache/screening/latest.json.gz'
    or name = (select auth.uid())::text || '/cache/dashboard/latest.json.gz'
  )
);
