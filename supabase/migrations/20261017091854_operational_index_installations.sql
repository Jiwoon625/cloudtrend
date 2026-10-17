-- An immutable installation receipt distinguishes never-installed owners from lost artifacts.
-- No prices, saved analysis, Shadow or ACTUAL tables are changed.
create table public.operational_index_installations (
  user_id uuid primary key references auth.users(id),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  original_sha256 text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  installed_at timestamptz not null default now()
);
alter table public.operational_index_installations enable row level security;
revoke all on public.operational_index_installations from anon, authenticated;
grant select, insert on public.operational_index_installations to authenticated;
grant all on public.operational_index_installations to service_role;
create policy "owner reads installation receipt" on public.operational_index_installations
  for select to authenticated using ((select auth.uid()) = user_id and
    coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy "owner records installation receipt" on public.operational_index_installations
  for insert to authenticated with check ((select auth.uid()) = user_id and
    coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
-- Existing pinned objects were installed before receipts existed. Retain their owners even
-- if one member of the pair is already missing; readers still verify both actual byte hashes.
insert into public.operational_index_installations (user_id, artifact_sha256, original_sha256)
select distinct u.id,
  '79e1321b5968b911f6344616a0aa1d63b0b26f2235e09e6dfb53a3d3a1a3f426',
  '20e037c1b172091e02d2670b53323978db193529ce370feb3850b1d1a9346b6b'
from storage.objects o join auth.users u on split_part(o.name, '/', 1) = u.id::text
where o.bucket_id = 'cloudtrend-data' and o.name in (
  u.id::text || '/results/ingestion/underlying-index/79e1321b5968b911f6344616a0aa1d63b0b26f2235e09e6dfb53a3d3a1a3f426.json',
  u.id::text || '/results/ingestion/underlying-index/20e037c1b172091e02d2670b53323978db193529ce370feb3850b1d1a9346b6b.json'
);
