-- Immutable content-addressed derived caches; no UPDATE or DELETE authorization added.
create policy "cloudtrend_owner_insert_immutable_runtime_cache"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (
    name ~ (
      '^' || (select auth.uid())::text ||
      '/cache/holding-price-inputs/[a-f0-9]{64}[.]json[.]gz$'
    )
    or name ~ (
      '^' || (select auth.uid())::text ||
      '/cache/dashboard-operations/v2/(kr|us)-[a-f0-9]{64}[.]json[.]gz$'
    )
  )
);
