/** Disposable embedded PostgreSQL: existing bridge only, synthetic data, no external service. */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const root = new URL("..", import.meta.url);
const db = new PGlite();
try {
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
    CREATE TABLE public.us_screening_history(user_id uuid,date date,signals jsonb);`);
  for (const path of [
    "supabase/migrations/20261002213815_unified_ledger_foundation.sql",
    "docs/portfolio-ledgers.sql",
    "docs/us-actual-portfolio.sql",
    "supabase/migrations/20261003020957_website_actual_ledger_bridge.sql",
  ])
    await db.exec(readFileSync(new URL(path, root), "utf8"));
  const owner = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  await db.query("insert into auth.users(id) values ($1),($2)", [owner, other]);
  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false);`,
  );
  const read = async () =>
    (
      await db.query("select public.ledger_read_website_document($1,'portfolio_ledgers') result", [
        owner,
      ])
    ).rows[0].result;
  const legacy = {
    id: "old-fill",
    symbol: "005930",
    name: "Synthetic",
    market: "KOSPI",
    signalKey: "old",
    side: "BUY",
    date: "2026-09-01",
    price: 20,
    shares: 100,
    fee: 2,
    note: "old original preserved",
    order: 0,
  };
  let doc = {
    version: 3,
    actualCapital: 10000000,
    etfCapital: 10000000,
    settings: { initialCapital: 10000000 },
    strategy: null,
    executions: [legacy],
    excluded: {},
    migratedAt: "2026-10-01T00:00:00Z",
    operatingCapitalPlan: { planned: 12345678 },
  };
  await db.query("insert into public.portfolio_ledgers(user_id,revision,payload) values($1,1,$2)", [
    owner,
    JSON.stringify(doc),
  ]);
  const before = await read();
  assert.equal(before.integrityValid, true);
  const oldEvents = before.events;
  let revision = 1;
  const save = async () => {
    const result = await db.query(
      "update public.portfolio_ledgers set payload=$1,revision=revision+1 where user_id=$2 and revision=$3 returning revision",
      [JSON.stringify(doc), owner, revision],
    );
    assert.equal(result.rows.length, 1);
    revision++;
  };
  const newFill = {
    ...legacy,
    id: "new-fill",
    signalKey: null,
    date: "2026-10-12",
    price: 100,
    shares: 10,
    fee: 1,
    order: 1,
    note: "actual new allocation",
  };
  doc.executions.push(newFill);
  doc.newActualPortfolio = {
    version: 1,
    seriesId: "actual-performance-2026-10-12-v1",
    assignments: {
      "new-fill": {
        executionId: "new-fill",
        quantity: 10,
        gross: 1000,
        fee: 1,
        brokerReference: "synthetic-new-receipt",
      },
    },
    cashEvents: [],
    audit: [],
  };
  await save();
  let snapshot = await read();
  assert.equal(snapshot.integrityValid, true);
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(
    snapshot.events.filter((e) => e.source.recordId === "old-fill"),
    oldEvents,
  );
  assert.deepEqual(snapshot.payload.executions[0], legacy);
  const eventCount = snapshot.events.length;
  doc.newActualPortfolio.cashEvents.push({
    id: "cash-1",
    date: "2026-10-12",
    kind: "DEPOSIT",
    amount: 2000,
    reference: "actual allocated cash",
  });
  await save();
  snapshot = await read();
  assert.equal(snapshot.events.length, eventCount);
  assert.equal(snapshot.payload.newActualPortfolio.cashEvents[0].amount, 2000);
  assert.equal(snapshot.payload.actualCapital, 10000000);
  assert.equal(snapshot.payload.operatingCapitalPlan.planned, 12345678);
  doc.executions[1] = { ...newFill, fee: 3 };
  doc.newActualPortfolio.assignments["new-fill"].fee = 3;
  await save();
  snapshot = await read();
  assert.equal(snapshot.events.filter((e) => e.source.recordId === "new-fill").length, 2);
  assert.equal(snapshot.events.filter((e) => e.source.recordId === "old-fill").length, 1);
  assert.equal(snapshot.integrityValid, true);
  doc.executions = [legacy];
  delete doc.newActualPortfolio.assignments["new-fill"];
  await save();
  snapshot = await read();
  assert.equal(snapshot.events.filter((e) => e.source.recordId === "new-fill").length, 3);
  assert.equal(
    snapshot.events.find((e) => e.source.recordId === "new-fill" && e.revision === 3).voided,
    true,
  );
  assert.deepEqual(snapshot.payload.executions, [legacy]);
  assert.equal(snapshot.integrityValid, true);
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${other}',false);`);
  const foreign = await read();
  assert.ok(foreign === null || foreign.payload === null);
  assert.equal(
    (
      await db.query(
        "update public.portfolio_ledgers set revision=revision+1 where user_id=$1 returning user_id",
        [owner],
      )
    ).rows.length,
    0,
  );
  console.log(
    "PASS existing canonical bridge: metadata + fill atomic, original preservation, shared cash metadata, correction/void history, owner isolation; no migration required",
  );
} finally {
  await db.close();
}
