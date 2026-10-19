-- Lock proposal approval before touching the owner-only immutable actual ledger.
-- A claimed row cannot be rejected. Recovery uses the same claim identity.
begin;
alter table public.assistant_trade_proposals
  add column if not exists processing_token uuid,
  add column if not exists processing_started_at timestamptz;
alter table public.assistant_trade_proposals
  drop constraint if exists assistant_trade_proposals_status_check;
alter table public.assistant_trade_proposals
  add constraint assistant_trade_proposals_status_check
  check (status in ('PENDING','PROCESSING','RECORDED','REJECTED'));
alter table public.assistant_trade_proposals
  add constraint assistant_trade_proposals_processing_integrity_check
  check ((status = 'PROCESSING') =
         (processing_token is not null and processing_started_at is not null));
-- All in-progress rows are reviewed; pending remains unreviewed.
create index if not exists assistant_trade_proposals_active_idx
  on public.assistant_trade_proposals(user_id,created_at,id)
  where status in ('PENDING','PROCESSING');
commit;
