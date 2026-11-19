-- Review-only: not applied to production by building the collector.
-- No expiry and no automatic takeover. Stop the old VM before a separately
-- reviewed owner_token-conditional release of a crash-abandoned lock.
CREATE TABLE public.collector_run_locks (
  user_id uuid NOT NULL REFERENCES auth.users(id),
  lock_name text NOT NULL CHECK (lock_name = 'lite-resume-v1'),
  owner_token uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lock_name)
);
ALTER TABLE public.collector_run_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.collector_run_locks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.collector_run_locks TO service_role;
-- No UPDATE grant: ownership is immutable for the lifetime of the row.
