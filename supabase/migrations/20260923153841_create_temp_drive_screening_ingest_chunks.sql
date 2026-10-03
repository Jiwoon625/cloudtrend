
    create table public._cloudtrend_drive_ingest_chunks (
      seq integer primary key,
      data text not null
    );
    alter table public._cloudtrend_drive_ingest_chunks enable row level security;
    revoke all on table public._cloudtrend_drive_ingest_chunks from anon, authenticated;
  