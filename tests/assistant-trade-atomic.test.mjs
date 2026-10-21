import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite();
const root = new URL("..", import.meta.url);
try {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;
 create table public.us_screening_history(user_id uuid,date date,signals jsonb);`);
  for (const path of [
    "supabase/migrations/20261002213815_unified_ledger_foundation.sql",
    "docs/portfolio-ledgers.sql",
    "docs/us-actual-portfolio.sql",
    "supabase/migrations/20261003020957_website_actual_ledger_bridge.sql",
    "supabase/migrations/20261019144747_assistant_trade_proposals.sql",
    "supabase/migrations/20261019151441_assistant_trade_proposal_claims.sql",
    "supabase/migrations/20261020015017_assistant_trade_owner_transitions.sql",
    "supabase/migrations/20261021070811_assistant_trade_record_etf_decimal.sql",
    "supabase/migrations/20261021074827_assistant_trade_atomic_evidence.sql",
  ])
    await db.exec(readFileSync(new URL(path, root), "utf8"));
  const uid = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
  await db.query("insert into auth.users values ($1)", [uid]);
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false)`,
  );
  for (const table of ["portfolio_ledgers", "us_actual_portfolio_ledgers"])
    await db.query(`insert into public.${table}(user_id,revision,payload) values($1,1,$2)`, [
      uid,
      JSON.stringify({ executions: [] }),
    ]);
  let n = 0;
  async function proposal(market, source, price = 10, shares = 3) {
    const id = `11111111-1111-4111-8111-${String(++n).padStart(12, "0")}`;
    const trade = {
      market,
      sourcePageId: source,
      price,
      shares,
      fee: 0,
      date: "2026-10-19",
      name: "Synthetic",
      symbol: market === "US" ? "AAPL" : "005930",
      side: "BUY",
      accountLabel: "GENERAL",
    };
    await db.exec("reset role");
    await db.query(
      "insert into public.assistant_trade_proposals(id,user_id,source_page_id,trade) values($1,$2,$3,$4)",
      [id, uid, source, JSON.stringify(trade)],
    );
    await db.exec("set role authenticated");
    const token = (await db.query("select public.assistant_trade_claim($1) token", [id])).rows[0]
      .token;
    return { id, trade, token };
  }
  function document(p, gross = p.trade.price * p.trade.shares) {
    const id = "new-actual:" + p.id;
    return {
      executions: [{ ...p.trade, id, signalKey: null, order: 0, note: "synthetic" }],
      newActualPortfolio: {
        assignments: {
          [id]: {
            quantity: p.trade.shares,
            gross,
            fee: 0,
            brokerReference: "notion:" + p.trade.sourcePageId,
          },
        },
      },
    };
  }
  async function commit(p, table, rev, doc) {
    return db.query("select public.assistant_trade_commit($1,$2,$3,$4,$5) result", [
      p.id,
      p.token,
      table,
      rev,
      JSON.stringify(doc),
    ]);
  }
  const us = await proposal("US", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 123.45678912, 1000000);
  const usd = document(us, 123456789.12);
  await commit(us, "us_actual_portfolio_ledgers", 1, usd);
  assert.equal(
    (await db.query("select status from public.assistant_trade_proposals where id=$1", [us.id]))
      .rows[0].status,
    "RECORDED",
  );
  await assert.rejects(commit(us, "us_actual_portfolio_ledgers", 1, usd));
  assert.equal(
    (await db.query("select revision from public.us_actual_portfolio_ledgers")).rows[0].revision,
    2,
  );
  const kr = await proposal("KOSPI", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const bad = document(kr, 29);
  await assert.rejects(commit(kr, "portfolio_ledgers", 1, bad));
  assert.equal(
    (await db.query("select revision from public.portfolio_ledgers")).rows[0].revision,
    1,
  );
  assert.equal(
    (await db.query("select status from public.assistant_trade_proposals where id=$1", [kr.id]))
      .rows[0].status,
    "PROCESSING",
  );
  await commit(kr, "portfolio_ledgers", 1, document(kr));
  const copy = structuredClone(document(kr));
  copy.executions[0].id = "direct-copy";
  copy.executions[0].market = "US";
  copy.executions[0].symbol = "MSFT";
  copy.newActualPortfolio.assignments = {
    "direct-copy": {
      quantity: 3,
      gross: 30,
      fee: 0,
      brokerReference: "notion:" + kr.trade.sourcePageId,
    },
  };
  await assert.rejects(
    db.query(
      "update public.us_actual_portfolio_ledgers set revision=3,payload=$1 where user_id=$2",
      [JSON.stringify(copy), uid],
    ),
  );
  const extra = await proposal("US", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  await assert.rejects(commit(extra, "us_actual_portfolio_ledgers", 1, document(extra)));
  await db.exec(
    `select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false)`,
  );
  await assert.rejects(commit(extra, "us_actual_portfolio_ledgers", 2, document(extra)));
  console.log(
    "PASS: KR/US atomic record, exact USD, transition rollback, idempotency, CAS, cross-book direct-write duplicate, wrong-owner denial",
  );
} finally {
  await db.close();
}
