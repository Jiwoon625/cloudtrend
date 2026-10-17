-- Actual-only owner decisions. No dependency on any fill, portfolio or Shadow table.
create table public.actual_entry_decisions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision integer not null check (revision > 0),
  events jsonb not null check (jsonb_typeof(events) = 'array' and jsonb_array_length(events) = revision),
  updated_at timestamptz not null default now()
);
alter table public.actual_entry_decisions enable row level security;
revoke all on public.actual_entry_decisions from public, anon, authenticated;
grant select, insert on public.actual_entry_decisions to authenticated;
grant update (revision, events, updated_at) on public.actual_entry_decisions to authenticated;
create policy actual_entry_decisions_owner_select on public.actual_entry_decisions for select to authenticated
  using ((select auth.uid()) = user_id and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy actual_entry_decisions_owner_insert on public.actual_entry_decisions for insert to authenticated
  with check ((select auth.uid()) = user_id and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
create policy actual_entry_decisions_owner_update on public.actual_entry_decisions for update to authenticated
  using ((select auth.uid()) = user_id and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false')
  with check ((select auth.uid()) = user_id and coalesce((select auth.jwt())->>'is_anonymous', 'false') = 'false');
-- Retain decision history. CAS is also checked in the server's update predicate.
create function public.guard_actual_entry_decision_append() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then raise exception 'Expected first decision'; end if;
  else
    if new.user_id <> old.user_id or new.revision <> old.revision + 1
      or (select coalesce(jsonb_agg(value order by ord), '[]'::jsonb) from jsonb_array_elements(new.events) with ordinality as e(value, ord) where ord <= old.revision) <> old.events
    then raise exception 'Decision history must be appended'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_actual_entry_decision_append() from public, anon, authenticated;
create trigger actual_entry_decision_append before insert or update on public.actual_entry_decisions
for each row execute function public.guard_actual_entry_decision_append();
