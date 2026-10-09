/** Disposable embedded PostgreSQL only. No credentials or production connections. */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const db = new PGlite();
await db.exec(
  `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}') $$; GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO anon,authenticated,service_role;`,
);
await db.exec(readFileSync(root + "/docs/ledger-foundation.sql", "utf8"));
for (const suffix of [
  "owner_october_shadow_append",
  "kr_shadow_next_morning",
  "shadow_runtime_hash_provenance",
  "shadow_pending_archive_validation",
  "cloudtrend_consistency_restart",
]) {
  const files = readdirSync(root + "/supabase/migrations").filter((x) =>
    x.endsWith("_" + suffix + ".sql"),
  );
  if (files.length !== 1) throw Error(suffix);
  await db.exec(readFileSync(root + "/supabase/migrations/" + files[0], "utf8"));
  console.log("PASS migration " + suffix);
}
console.log(
  (
    await db.query(
      "select proname,prosecdef,pg_get_userbyid(proowner) as owner,proconfig from pg_proc where proname in ('ledger_append_model_session','ledger_append_own_october_model_session')",
    )
  ).rows,
);
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
await db.query("insert into auth.users(id) values ($1),($2)", [owner, other]);
await db.exec(
  `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false); SELECT set_config('request.jwt.claims','{"is_anonymous":false}',false);`,
);
const payload = {
  runId: "run-1",
  asOfDate: "2026-10-12",
  market: "KR",
  strategyVersion: "v4",
  savedAt: "2026-10-12T08:00:00Z",
  entries: [],
};
const insert = `insert into public.screening_run_archive(user_id,run_id,date,market,strategy_version,calculated_at,snapshot) values ($1,$2,'2026-10-12','KR','v4','2026-10-12T08:00:00Z',$3)`;
await db.query(insert, [owner, "run-1", JSON.stringify(payload)]);
const denied = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log("PASS reject " + name);
    return;
  }
  throw Error("Unexpectedly allowed " + name);
};
await denied("other owner insert", () =>
  db.query(insert, [other, "run-1", JSON.stringify(payload)]),
);
await denied("snapshot without identity", () => db.query(insert, [owner, "run-2", "{}"]));
await denied("update immutable run", () =>
  db.exec("update public.screening_run_archive set strategy_version='tampered'"),
);
await denied("delete immutable run", () => db.exec("delete from public.screening_run_archive"));
await db.exec(`SELECT set_config('request.jwt.claim.sub','${other}',false)`);
if ((await db.query("select * from public.screening_run_archive")).rows.length)
  throw Error("Cross-owner read");
console.log("PASS owner isolation");
await db.exec(
  `SELECT set_config('request.jwt.claim.sub','${owner}',false); SELECT set_config('request.jwt.claims','{"is_anonymous":true}',false)`,
);
if ((await db.query("select * from public.screening_run_archive")).rows.length)
  throw Error("Anonymous read");
await denied("anonymous write", () =>
  db.query(insert, [owner, "run-3", JSON.stringify({ ...payload, runId: "run-3" })]),
);
await db.exec("RESET ROLE");
// Controlled clock only inside this disposable database: production functions remain unchanged.
for (const name of ["ledger_append_model_session", "ledger_append_own_october_model_session"]) {
  const [{ definition }] = (
    await db.query("select pg_get_functiondef(oid) definition from pg_proc where proname=$1", [
      name,
    ])
  ).rows;
  await db.exec(
    definition.replaceAll(
      "pg_catalog.statement_timestamp()",
      "'2026-10-14T00:00:00Z'::timestamptz",
    ),
  );
}
const fixture = JSON.parse(
  readFileSync(
    process.env.CLOUDTREND_RESTART_APP_FIXTURES ?? "/tmp/ct-restart-fixtures.json",
    "utf8",
  ),
);
const byKind = new Map(fixture.series.map((s) => [s.policy.kind, s]));
for (const series of fixture.series) {
  const kind = series.policy.kind,
    role = ["US_A2", "US_B3", "KR_KOSPI_CONFIRM1_BEAR"].includes(kind)
      ? "ALTERNATIVE_SHADOW"
      : "ADOPTED_SHADOW";
  await db.query(
    "insert into public.ledger_model_series(user_id,series_id,strategy_id,role,scheduled_start,config_hash,payload) values ($1,$2,$3,$4,$5,$6,$7)",
    [
      owner,
      series.bookId,
      kind,
      role,
      series.accountingStartDate,
      series.configHash,
      JSON.stringify(series),
    ],
  );
}
await db.exec(
  `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false); SELECT set_config('request.jwt.claims','{"is_anonymous":false}',false);`,
);
const rpc = async (run, previousDate = null, previousHash = null) =>
  (
    await db.query(
      "select public.ledger_append_own_october_model_session($1::jsonb,$2::date,$3::text) result",
      [JSON.stringify(run), previousDate, previousHash],
    )
  ).rows[0].result;
const stage = async (payload, hash, kind, representative) => {
  const series = byKind.get(representative);
  return rpc({
    book: "MODEL",
    bookId: series.bookId,
    contractHash: series.contractHash,
    publicationArtifact: { kind, hash, payload },
  });
};
for (const archive of fixture.archives)
  await stage(archive.payload, archive.hash, "KR_DAILY_INPUT", "KR_MIXED");
let count = 0;
for (let i = 0; i < fixture.prepared.length; i++) {
  const prepared = fixture.prepared[i];
  await stage(
    prepared,
    fixture.preparedPayloadHashes[i],
    "PREPARED_PUBLICATION",
    prepared.market === "KR" ? "KR_MIXED" : "US_A0",
  );
  for (const entry of prepared.entries) {
    const result = await rpc(entry.run, entry.previousDate, entry.previousHash);
    if (result.reused !== false || result.stateHash !== entry.run.stateHash)
      throw Error("Append acknowledgement mismatch");
    if (!(await rpc(entry.run, entry.previousDate, entry.previousHash)).reused)
      throw Error("Retry not idempotent");
    count++;
  }
}
console.log(
  "PASS exact engine publications and idempotent owner append: " + count + " new-series books",
);
await db.close();
