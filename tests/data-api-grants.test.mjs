/** Disposable PostgreSQL, default table ACLs empty: no production data or credentials. */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite();
await db.exec(`
create role anon nologin; create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}') $$;
grant usage on schema public,auth to anon,authenticated,service_role;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
`);
const files = readdirSync("supabase/migrations")
  .filter((x) => x.endsWith(".sql"))
  .sort();
try {
  for (const file of files) {
    try {
      await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
    } catch (e) {
      throw new Error(file + ": " + e.message, { cause: e });
    }
  }
  console.log("PASS full migration replay: " + files.length);
  const matrix = {
    screening_history: ["SELECT,INSERT,UPDATE,DELETE", "SELECT,INSERT,UPDATE,DELETE"],
    analysis_runs: ["SELECT", "SELECT,INSERT,UPDATE,DELETE"],
    analysis_source_files: ["SELECT,INSERT,UPDATE", "SELECT,INSERT,UPDATE,DELETE"],
    stock_lifecycle_metadata: [
      "SELECT,INSERT,UPDATE,DELETE",
      "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    ],
    stock_trading_halts: [
      "SELECT,INSERT,UPDATE,DELETE",
      "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    ],
    portfolio_settings: ["SELECT,INSERT,UPDATE", ""],
    portfolio_trades: ["SELECT,INSERT,UPDATE", ""],
    portfolio_signal_log: ["SELECT,INSERT,UPDATE", ""],
    _cloudtrend_drive_ingest_chunks: ["", ""], // retired SQL-owner-only scratch table
    us_screening_ingest: ["SELECT", "SELECT,INSERT,UPDATE,DELETE"],
    us_screening_history: ["SELECT", "SELECT,INSERT,UPDATE,DELETE"],
    us_strategy_registry: ["SELECT", "SELECT,INSERT,UPDATE,DELETE"],
    us_portfolio_snapshots: ["SELECT", "SELECT,INSERT,UPDATE,DELETE"],
    us_portfolio_trades: ["SELECT", "SELECT,INSERT,UPDATE,DELETE"],
    portfolio_ledgers: [
      "SELECT,INSERT,UPDATE",
      "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    ],
    us_actual_portfolio_ledgers: [
      "SELECT,INSERT,UPDATE",
      "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    ],
    shadow_replay_audit: ["SELECT,INSERT", "SELECT,INSERT"],
    us_operating_replays: ["", "SELECT,INSERT"],
    screening_run_archive: ["SELECT,INSERT", "SELECT,INSERT"],
    actual_entry_decisions: ["SELECT,INSERT", ""],
    operational_index_installations: [
      "SELECT,INSERT",
      "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
    ],
    assistant_trade_proposals: ["SELECT", "SELECT,INSERT,UPDATE"],
  };
  for (const { relname } of (
    await db.query(
      "select relname from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind in ('r','p')",
    )
  ).rows) {
    const expected =
      matrix[relname] ??
      ([
        "ledger_security_versions",
        "ledger_event_sources",
        "ledger_event_versions",
        "ledger_evidence_refs",
        "ledger_reconciliation_log",
        "ledger_valuation_versions",
        "ledger_model_series",
        "ledger_model_sessions",
        "ledger_recording_log",
        "ledger_provenance_archive",
      ].includes(relname)
        ? ["SELECT", "SELECT,INSERT"]
        : null);
    assert.ok(expected, "Unreviewed table " + relname);
    const [{ relrowsecurity }] = (
      await db.query("select relrowsecurity from pg_class where oid=$1::regclass", [
        "public." + relname,
      ])
    ).rows;
    assert.equal(relrowsecurity, true, relname + " RLS");
    for (const [i, role] of ["anon", "authenticated", "service_role"].entries()) {
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        const [{ allowed }] = (
          await db.query("select has_table_privilege($1,$2,$3) allowed", [
            role,
            "public." + relname,
            privilege,
          ])
        ).rows;
        assert.equal(
          allowed,
          i === 0 ? false : expected[i - 1].split(",").includes(privilege),
          role + " " + privilege + " " + relname,
        );
      }
    }
  }
  console.log(
    "PASS exact table ACL/RLS matrix, including no anon access and no extra ledger writes",
  );
  const owner = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  await db.query("insert into auth.users values ($1),($2)", [owner, other]);
  const denied = async (sql, params = [], code = "42501") => {
    await assert.rejects(
      () => db.query(sql, params),
      (e) => e.code === code,
      sql,
    );
  };
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false)`,
  );
  await db.query("insert into public.portfolio_settings(user_id) values ($1)", [owner]);
  await db.query("update public.portfolio_settings set max_positions=20 where user_id=$1", [owner]);
  assert.equal(
    (await db.query("select max_positions from public.portfolio_settings")).rows[0].max_positions,
    20,
  );
  await denied("insert into public.portfolio_settings(user_id) values ($1)", [other]);
  await denied("update public.portfolio_settings set user_id=$1", [other]);
  await denied("delete from public.portfolio_settings");
  await db.query(
    "insert into public.screening_history(user_id,date,snapshot) values ($1,'2026-10-21','{}')",
    [owner],
  );
  await db.query(
    "insert into public.portfolio_signal_log(user_id,symbol,signal_date,decision) values ($1,'TEST','2026-10-21','EXECUTED')",
    [owner],
  );
  await db.query(
    "insert into public.shadow_replay_audit(user_id,market,signal_date,calculated_at,replay_mode,status,strategy_version) values ($1,'KR','2026-10-21',now(),'RETROSPECTIVE','RECORDED','test')",
    [owner],
  );
  await denied("insert into public.assistant_trade_proposals default values");
  await denied("update public.assistant_trade_proposals set status='APPLIED'");
  await denied("insert into public.ledger_event_versions default values");
  await denied("delete from public.ledger_event_versions");
  await denied("insert into public.us_screening_history default values");
  await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
  assert.equal((await db.query("select * from public.portfolio_settings")).rows.length, 0);
  assert.equal((await db.query("select * from public.screening_history")).rows.length, 0);
  await db.exec("reset role; set role service_role");
  await db.query(
    "insert into public.us_screening_history(user_id,date,data_hash,rule_version) values ($1,'2026-10-21','test','test')",
    [owner],
  );
  await db.query("update public.us_screening_history set rule_version='test2' where user_id=$1", [
    owner,
  ]);
  await db.query("delete from public.us_screening_history where user_id=$1", [owner]);
  await db.query(
    "insert into public.screening_history(user_id,date,snapshot) values ($1,'2026-10-22','{}')",
    [owner],
  );
  await db.exec("reset role; set role anon");
  await denied("select * from public.assistant_trade_proposals");
  await denied("select * from public.portfolio_settings");
  await db.exec("reset role");
  const [{ relrowsecurity: privateRls }] = (
    await db.query(
      "select relrowsecurity from pg_class where oid='cloudtrend_ledger_private.bridge_documents'::regclass",
    )
  ).rows;
  assert.equal(privateRls, true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    const [{ allowed }] = (
      await db.query(
        "select has_table_privilege($1,'cloudtrend_ledger_private.bridge_documents','SELECT,INSERT,UPDATE,DELETE') allowed",
        [role],
      )
    ).rows;
    assert.equal(allowed, false);
  }
  const [{ allowed }] = (
    await db.query(
      "select has_schema_privilege('authenticated','cloudtrend_ledger_private','USAGE') allowed",
    )
  ).rows;
  assert.equal(allowed, false);
  console.log(
    "PASS role SQL execution, owner isolation, append-only identity insert and protected writes",
  );
  // Column-level UPDATE grants must remain narrower than table UPDATE.
  for (const [table, column, expected] of [
    ["us_portfolio_trades", "actual_price", true],
    ["us_portfolio_trades", "model_price", false],
    ["actual_entry_decisions", "events", true],
    ["actual_entry_decisions", "user_id", false],
  ]) {
    const [{ allowed }] = (
      await db.query("select has_column_privilege($1,$2,$3,'UPDATE') allowed", [
        "authenticated",
        "public." + table,
        column,
      ])
    ).rows;
    assert.equal(allowed, expected, table + "." + column);
  }
  for (const signature of [
    "assistant_trade_claim(uuid)",
    "assistant_trade_record(uuid,uuid)",
    "ledger_read_website_document(uuid,text)",
    "ledger_append_own_october_model_session(jsonb,date,text)",
  ]) {
    const [{ allowed }] = (
      await db.query("select has_function_privilege('anon',$1,'EXECUTE') allowed", [
        "public." + signature,
      ])
    ).rows;
    assert.equal(allowed, false, signature + " anonymous execute");
  }
  const reviewer = "bdfc8818-33a7-4030-9dbd-ecad39f223ac",
    proposal = "33333333-3333-4333-8333-333333333333";
  await db.query("insert into auth.users values ($1)", [reviewer]);
  await db.exec("set role service_role");
  await db.query(
    "insert into public.assistant_trade_proposals(id,user_id,source_page_id,trade) values ($1,$2,$1,'{}')",
    [proposal, reviewer],
  );
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${other}',false)`,
  );
  await denied("select public.assistant_trade_claim($1)", [proposal]);
  assert.equal((await db.query("select * from public.assistant_trade_proposals")).rows.length, 0);
  await db.exec(`select set_config('request.jwt.claim.sub','${reviewer}',false)`);
  const [{ token }] = (await db.query("select public.assistant_trade_claim($1) token", [proposal]))
    .rows;
  assert.ok(token);
  assert.equal(
    (await db.query("select public.assistant_trade_record($1,$2) recorded", [proposal, token]))
      .rows[0].recorded,
    false,
    "No recording without canonical BUY",
  );
  assert.equal(
    (await db.query("select public.assistant_trade_release($1,$2) released", [proposal, token]))
      .rows[0].released,
    true,
  );
  await db.exec("reset role");
  console.log(
    "PASS column grants, RPC ownership, claim/release and rejection of recording without a BUY",
  );

  // Re-run only the newly added, idempotent GRANT statements: never replay data migrations on production.
  const before = (
    await db.query(
      "select relname,relacl::text from pg_class where relnamespace='public'::regnamespace order by relname",
    )
  ).rows;
  for (const file of files) {
    const sql = readFileSync("supabase/migrations/" + file, "utf8");
    const marker = "-- Explicit Data API access; independent of platform default privileges.";
    if (sql.includes(marker)) await db.exec(sql.split(marker)[1]);
  }
  assert.deepEqual(
    (
      await db.query(
        "select relname,relacl::text from pg_class where relnamespace='public'::regnamespace order by relname",
      )
    ).rows,
    before,
  );
  console.log("PASS grant reapplication preserves ACLs");
} finally {
  await db.close();
}
