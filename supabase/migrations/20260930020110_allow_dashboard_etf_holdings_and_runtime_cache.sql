
create policy "cloudtrend_owner_insert_dashboard_runtime"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'cloudtrend-data'
  and (
    name = ((select auth.uid())::text || '/portfolio/etf-holdings/latest.json')
    or name = ((select auth.uid())::text || '/cache/dashboard-operations/kr-v1.json')
    or name = ((select auth.uid())::text || '/cache/dashboard-operations/us-v1.json')
  )
);

create policy "cloudtrend_owner_update_dashboard_runtime"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'cloudtrend-data'
  and (
    name = ((select auth.uid())::text || '/portfolio/etf-holdings/latest.json')
    or name = ((select auth.uid())::text || '/cache/dashboard-operations/kr-v1.json')
    or name = ((select auth.uid())::text || '/cache/dashboard-operations/us-v1.json')
  )
)
with check (
  bucket_id = 'cloudtrend-data'
  and (
    name = ((select auth.uid())::text || '/portfolio/etf-holdings/latest.json')
    or name = ((select auth.uid())::text || '/cache/dashboard-operations/kr-v1.json')
    or name = ((select auth.uid())::text || '/cache/dashboard-operations/us-v1.json')
  )
);
