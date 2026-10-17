-- Immutable, per-owner K4/E4 evidence. SELECT already covered by cloudtrend_owner_read.
-- Do not grant UPDATE: checkpoints and signal.json are append-only.
create policy "cloudtrend_owner_insert_holding_price_exit"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and name ~ (
    '^' || (select auth.uid())::text ||
    '/holding-price-exits/holding-price-exit-k4-e4-v1/[a-f0-9]{64}/(signal[.]json|[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9]{64}[.]json)$'
  )
);
