import runtime from "../src/lib/integratedAllocationRuntime.generated.json";
/** Disposable embedded PostgreSQL only: synthetic owners, no URL/key/network or live writes. */
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import {
  createIntegratedAllocationShadow,
  reviewIntegratedAllocationMonth,
  verifyIntegratedAllocationLedger,
  ALLOCATION_MARKETS,
  type IntegratedAllocationLedger,
} from "../src/lib/integratedAllocationShadow";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type SeriesHash,
} from "../src/lib/ledger/modelSeries";
import {
  integratedRegistry,
  prepareIntegratedInitialization,
  prepareIntegratedDailyPublication,
} from "../src/lib/integratedAllocationPublication";
import {
  octoberModelCalendar,
  regularOpenAt,
  regularCloseAt,
} from "../src/lib/ledger/octoberShadowCalendar";
import evidence from "../src/lib/ledger/octoberShadowCalendarEvidence.json";
const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const codeHash = runtime.codeHash as SeriesHash;
const draft = readFileSync("docs/integrated-allocation-owner-append.sql", "utf8");
const rollback = readFileSync("docs/integrated-allocation-owner-append.rollback.sql", "utf8");
let beforeCatalog: unknown, beforeAcl: unknown, originalBody: string, patchedDefinition: string;
const catalog = async () =>
  (
    await db.query(`select c.relname,c.relacl,c.relrowsecurity,
  (select jsonb_agg(to_jsonb(p)) from pg_policy p where p.polrelid=c.oid) policies,
  (select jsonb_agg(to_jsonb(t)) from pg_trigger t where t.tgrelid=c.oid) triggers,
  (select jsonb_agg(to_jsonb(i)) from pg_index i where i.indrelid=c.oid) indexes,
  (select jsonb_agg(to_jsonb(k)) from pg_constraint k where k.conrelid=c.oid) constraints
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by c.relname`)
  ).rows;
const acl = async () =>
  (
    await db.query(`select proname,proacl,prosecdef,pg_get_userbyid(proowner) owner,proconfig from pg_proc
 where proname in ('ledger_append_model_session','ledger_append_own_october_model_session') order by proname`)
  ).rows;
async function auth(id = owner, anonymous = false, role = "authenticated") {
  await db.exec("RESET ROLE");
  await db.query(
    `select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)`,
    [id, JSON.stringify({ is_anonymous: anonymous })],
  );
  await db.exec(`SET ROLE ${role}`);
}
async function invoke(
  run: unknown,
  previous: { receipt?: { date: string }; stateHash: SeriesHash } | null = null,
) {
  return (
    await db.query<{
      result: {
        reused?: boolean;
        initialized?: boolean;
        bookId?: string;
        contractHash?: SeriesHash;
        stateHash?: SeriesHash;
      };
    }>(
      `select public.ledger_append_own_october_model_session($1::jsonb,$2::date,$3::text) result`,
      [JSON.stringify(run), previous?.receipt?.date ?? null, previous?.stateHash ?? null],
    )
  ).rows[0]!.result;
}
async function seal<T extends { result: IntegratedAllocationLedger }>(body: T, resealInner = true) {
  const {
    stateHash: _hash,
    canonicalPayload: _canonical,
    resultCanonicalPayload: _innerCanonical,
    ...rest
  } = body as T & {
    stateHash?: SeriesHash;
    canonicalPayload?: string;
    resultCanonicalPayload?: string;
  };
  const { stateHash: oldHash, ...inner } = rest.result;
  const payload = {
    ...rest,
    result: { ...inner, stateHash: resealInner ? await hashSeriesValue(inner) : oldHash },
    resultCanonicalPayload: canonicalSeriesJson(inner),
  };
  return {
    ...payload,
    stateHash: await hashSeriesValue(payload),
    canonicalPayload: canonicalSeriesJson(payload),
  };
}
async function registry(kind: "O1" | "S07" = "O1") {
  return {
    result: await createIntegratedAllocationShadow(kind, { codeHash }),
    registry: await integratedRegistry(kind, codeHash),
  };
}
async function initialization(kind: "O1" | "S07" = "O1") {
  return prepareIntegratedInitialization(kind, codeHash);
}
const nextKr = (day: string) => {
  let t = Date.parse(day + "T00:00:00Z");
  do {
    t += 86400000;
  } while (
    [0, 6].includes(new Date(t).getUTCDay()) ||
    ["2026-12-25", "2026-12-31"].includes(new Date(t).toISOString().slice(0, 10))
  );
  return new Date(t).toISOString().slice(0, 10);
};
async function daily(
  date = "2026-10-12",
  previous: { result: IntegratedAllocationLedger; stateHash: SeriesHash } | null = null,
  kind: "O1" | "S07" = "O1",
) {
  const initial = await registry(kind);
  const result = structuredClone(previous?.result ?? initial.result);
  const due = ALLOCATION_MARKETS.filter((m) =>
    m === "U"
      ? !["2026-11-26", "2026-12-25"].includes(date)
      : !["2026-12-25", "2026-12-31"].includes(date),
  );
  let availableAt = date + "T22:00:00Z";
  for (const market of due) {
    const at = market === "U" ? date + "T22:00:00Z" : nextKr(date) + "T08:10:00+09:00";
    if (Date.parse(at) > Date.parse(availableAt)) availableAt = at;
    result.markets[market].sessions.push(date);
    result.markets[market].signalObservations.push({ date, status: "MISSING" });
    result.markets[market].lastSessionDate = date;
    result.markets[market].lastDecisionAt = at;
    const id = `session:${market}:${date}`;
    result.receipts.push({
      id,
      inputHash: await hashSeriesValue(id),
      record: {
        id,
        type: "SESSION",
        date,
        sourceHash: await hashSeriesValue(date),
        fills: [],
        cancelledBuys: [],
        transfers: [],
        issues: [],
      },
    });
  }
  const { stateHash: _hash, ...inner } = result;
  result.stateHash = await hashSeriesValue(inner);
  const receipt = {
    book: "MODEL",
    bookId: result.bookId,
    date,
    contractHash: result.contractHash,
    codeHash,
    configHash: result.contractHash,
    sourceHash: await hashSeriesValue(date),
  };
  return seal({
    book: "MODEL",
    bookId: result.bookId,
    contractHash: result.contractHash,
    registry: initial.registry,
    result,
    receipt: { ...receipt, runHash: await hashSeriesValue(receipt) },
    previousStateHash: previous?.stateHash ?? null,
    calendar: {
      version: evidence.version,
      sourceHash: await hashSeriesValue(evidence),
      coverageStart: evidence.coverageStart,
      coverageEnd: evidence.coverageEnd,
    },
    publication: {
      version: "integrated-allocation-publication-v1",
      batchHash: receipt.sourceHash,
      markets: due,
      availableAt,
      decisionAt: availableAt,
    },
  });
}
async function rejected(
  value: unknown,
  previous: Parameters<typeof invoke>[1] = null,
  match?: RegExp,
) {
  const rowsBefore = (
    await db.query<{ n: number }>(`select count(*) n from public.ledger_model_sessions`)
  ).rows;
  await expect(invoke(value, previous)).rejects.toThrow(match);
  expect(
    (await db.query<{ n: number }>(`select count(*) n from public.ledger_model_sessions`)).rows,
  ).toEqual(rowsBefore);
}
beforeAll(async () => {
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}') $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO anon,authenticated,service_role;`);
  await db.exec(readFileSync("docs/ledger-foundation.sql", "utf8"));
  for (const suffix of [
    "owner_october_shadow_append",
    "kr_shadow_next_morning",
    "shadow_runtime_hash_provenance",
    "shadow_pending_archive_validation",
    "cloudtrend_consistency_restart",
  ]) {
    const names = readdirSync("supabase/migrations").filter((x) =>
      x.endsWith("_" + suffix + ".sql"),
    );
    expect(names).toHaveLength(1);
    await db.exec(readFileSync("supabase/migrations/" + names[0], "utf8"));
  }
  beforeCatalog = await catalog();
  beforeAcl = await acl();
  originalBody = (
    await db.query<{ prosrc: string }>(
      `select prosrc from pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure`,
    )
  ).rows[0]!.prosrc;
  await db.exec(draft);
  await db.exec(draft);
  patchedDefinition = (
    await db.query<{ definition: string }>(
      `select pg_get_functiondef('public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure) definition`,
    )
  ).rows[0]!.definition;
}, 60000);
afterAll(async () => {
  await db.close();
});
it("preserves all existing ACL/RLS/keys/triggers and the entire old eight-book branch verbatim", async () => {
  expect(await catalog()).toEqual(beforeCatalog);
  expect(await acl()).toEqual(beforeAcl);
  const current = (
    await db.query<{ prosrc: string }>(
      `select prosrc from pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure`,
    )
  ).rows[0]!.prosrc;
  expect(
    current.replace(
      / {2}-- BEGIN BOUNDED INTEGRATED ALLOCATION BRANCH[\s\S]*? {2}-- END BOUNDED INTEGRATED ALLOCATION BRANCH\n\n/,
      "",
    ),
  ).toBe(originalBody);
  expect(draft).not.toMatch(/\b(?:grant|revoke|create\s+table|alter\s+table|create\s+policy)\s/i);
});
it("initializes exactly two fresh owner registries before start, never sessions; retry is exact", async () => {
  await auth();
  for (const kind of ["O1", "S07"] as const) {
    const value = await initialization(kind);
    expect(await invoke(value)).toMatchObject({
      initialized: true,
      reused: false,
      bookId: value.bookId,
    });
    expect(await invoke(value)).toMatchObject({ initialized: true, reused: true });
  }
  expect(
    (await db.query<{ n: number }>(`select count(*) n from public.ledger_model_sessions`)).rows[0]!
      .n,
  ).toBe(0);
  expect(
    (await db.query<{ n: number }>(`select count(*) n from public.ledger_model_series`)).rows[0]!.n,
  ).toBe(2);
});
it("rejects initialized holdings, foreign namespaces/owners and anonymous or direct-write paths", async () => {
  await auth();
  const initial = await initialization();
  await rejected(
    await seal({ ...initial, result: { ...initial.result, centralCashKrw: "1" } }),
    null,
    /fresh integrated/,
  );
  await rejected(await seal({ ...initial, bookId: initial.bookId.replace(":O1", ":OTHER") }));
  await rejected(await seal({ ...initial, user_id: other }));
  await rejected(
    await seal({
      ...initial,
      registry: { ...initial.registry, sourceHash: `sha256:${"b".repeat(64)}` },
    }),
    null,
    /frozen contract/,
  );
  await auth(owner, true);
  await rejected(initial, null, /non-anonymous/);
  await auth("", false);
  await rejected(initial, null, /non-anonymous/);
  await auth(owner, false, "anon");
  await expect(invoke(initial)).rejects.toThrow(/permission denied/);
  await auth();
  await expect(
    db.exec(`insert into public.ledger_model_series select * from public.ledger_model_series`),
  ).rejects.toThrow(/permission denied/);
  await expect(
    db.query(`select public.ledger_append_model_session($1::uuid,$2::jsonb,$3::jsonb,null,null)`, [
      owner,
      initial.registry,
      initial,
    ]),
  ).rejects.toThrow(/permission denied/);
  await auth(other);
  expect((await db.query(`select * from public.ledger_model_series`)).rows).toEqual([]);
  expect(await invoke(initial)).toMatchObject({ initialized: true, reused: false });
  expect((await db.query(`select user_id from public.ledger_model_series`)).rows).toEqual([
    { user_id: other },
  ]);
});
it("rejects future daily batches with the unmodified production clock", async () => {
  await auth();
  await rejected(await daily("2099-10-12"), null, /future|calendar/);
});
it("atomically appends a complete daily head, exact retries after advance, and immutable registries", async () => {
  await db.exec("RESET ROLE");
  // Test-local clock only. The checked-in SQL has no clock override API.
  await db.exec(
    patchedDefinition.replaceAll(
      "pg_catalog.statement_timestamp()",
      "'2026-10-20T23:00:00Z'::timestamptz",
    ),
  );
  await auth();
  const first = await daily(),
    second = await daily("2026-10-13", first);
  expect(await invoke(first)).toMatchObject({ reused: false, stateHash: first.stateHash });
  expect(await invoke(second, first)).toMatchObject({ reused: false });
  expect(await invoke(first)).toMatchObject({ reused: true });
  await rejected(
    await seal({ ...second, result: { ...second.result, centralCashKrw: "1" } }),
    first,
    /daily batch conflict/,
  );
  const initial = await initialization();
  expect(await invoke(initial)).toMatchObject({ initialized: true, reused: true });
  expect(
    (await db.query<{ n: number }>(`select count(*) n from public.ledger_model_sessions`)).rows[0]!
      .n,
  ).toBe(2);
});
it("rejects missing markets, changed receipt prefixes, fake hashes, skipped or stale predecessor heads", async () => {
  await auth();
  const first = await daily(),
    second = await daily("2026-10-13", first),
    third = await daily("2026-10-14", second);
  await rejected(
    { ...third, canonicalPayload: third.canonicalPayload + " " },
    second,
    /state hash/,
  );
  await rejected(
    await seal({
      ...third,
      calendar: { ...third.calendar, sourceHash: `sha256:${"0".repeat(64)}` },
    }),
    second,
    /calendar/,
  );
  await rejected(
    await seal({ ...third, publication: { ...third.publication, markets: ["K", "E"] } }),
    second,
    /daily publication/,
  );
  await rejected(
    await seal({
      ...third,
      publication: { ...third.publication, batchHash: `sha256:${"b".repeat(64)}` },
    }),
    second,
    /batch hash/,
  );
  const incomplete = structuredClone(third);
  incomplete.result.receipts.pop();
  await rejected(await seal(incomplete), second, /daily event set/);
  const altered = structuredClone(third);
  altered.result.receipts[0]!.record.issues = ["changed"];
  await rejected(await seal(altered), second, /prefix changed/);
  const fake = structuredClone(third);
  fake.receipt.runHash = `sha256:${"f".repeat(64)}`;
  await rejected(await seal(fake), second, /receipt/);
  await rejected(await daily("2026-10-15", second), second, /skip/);
  await rejected(await daily("2026-10-14", first), first, /head/);
  await rejected(await daily("2026-10-09"), null, /pre-start/);
  await rejected(await daily("2026-11-19", second), second, /special/);
});
it("serializes duplicate and conflicting daily requests to a single immutable head", async () => {
  await auth();
  const first = await daily(),
    second = await daily("2026-10-13", first),
    third = await daily("2026-10-14", second);
  const replies = await Promise.all([invoke(third, second), invoke(third, second)]);
  expect(replies.map((x) => x.reused).sort()).toEqual([false, true]);
  const conflict = await seal({
    ...third,
    result: { ...third.result, centralCashKrw: "1" },
  });
  await rejected(conflict, second, /conflict/);
  expect(
    (
      await db.query<{ n: number }>(
        `select count(*) n from public.ledger_model_sessions where session_date='2026-10-14'`,
      )
    ).rows[0]!.n,
  ).toBe(1);
});
it("permits only one last-session monthly receipt and prevents premature or duplicate monthly events", async () => {
  await db.exec("RESET ROLE");
  await db.exec(
    patchedDefinition.replaceAll(
      "pg_catalog.statement_timestamp()",
      "'2026-11-03T00:00:00Z'::timestamptz",
    ),
  );
  await auth();
  let previous = await daily("2026-10-14", await daily("2026-10-13", await daily()));
  for (let d = 15; d < 30; d++) {
    const day = `2026-10-${d}`;
    if ([0, 6].includes(new Date(day + "T00:00:00Z").getUTCDay())) continue;
    const next = await daily(day, previous);
    await invoke(next, previous);
    previous = next;
  }
  const last = await daily("2026-10-30", previous);
  await rejected(last, previous, /O1 month-end receipt required/);
  const kr = await octoberModelCalendar("KR", evidence.coverageEnd),
    us = await octoberModelCalendar("US", evidence.coverageEnd);
  const krCalendar = { sourceHash: kr.sourceHash, sessions: kr.regularSessions },
    usCalendar = { sourceHash: us.sourceHash, sessions: us.regularSessions };
  last.result = (
    await reviewIntegratedAllocationMonth(last.result, {
      month: "2026-10",
      decisionAt: last.publication.decisionAt,
      codeHash,
      sourceHash: codeHash,
      calendars: { K: krCalendar, E: krCalendar, U: usCalendar },
    })
  ).ledger;
  await verifyIntegratedAllocationLedger(last.result);
  const receipt = last.result.receipts.at(-1)!;
  expect(receipt.id).toBe("month:2026-10");
  const duplicate = structuredClone(last);
  duplicate.result.receipts.push(receipt);
  await rejected(await seal(duplicate), previous, /count|month-end receipt required/);
  const wrongMonth = structuredClone(last);
  wrongMonth.result.lastReviewMonth = "2026-09";
  await rejected(await seal(wrongMonth), previous, /month-end/);
  const accepted = await seal(last);
  expect(await invoke(accepted, previous)).toMatchObject({ reused: false });
  expect(await invoke(accepted, previous)).toMatchObject({ reused: true });
  const early = await daily("2026-11-02", accepted);
  early.result.receipts.push({
    ...receipt,
    id: "month:2026-11",
    record: { ...receipt.record, id: "month:2026-11", date: "2026-11" },
  });
  early.result.lastReviewMonth = "2026-11";
  await rejected(await seal(early), accepted, /month-end/);
});
it("fails closed for holiday, calendar expiry, special-hours and future publication evidence", async () => {
  await db.exec("RESET ROLE");
  await db.exec(
    patchedDefinition.replaceAll(
      "pg_catalog.statement_timestamp()",
      "'2027-01-01T00:00:00Z'::timestamptz",
    ),
  );
  await auth();
  await rejected(await daily("2026-12-25"), null, /publication/);
  await rejected(await daily("2027-01-04"), null, /calendar/);
  const future = await daily();
  future.publication.decisionAt = "2099-10-12T00:00:00Z";
  await rejected(await seal(future), null, /not yet available/);
  // Production input has no clock override: unknown extra fields are rejected.
  await rejected(await seal({ ...(await daily()), now: "2099-10-12T00:00:00Z" }), null, /envelope/);
});
it("keeps a closed US sleeve on Thanksgiving and accepts the reviewed US early-close boundary", async () => {
  const isolatedOwner = "33333333-3333-4333-8333-333333333333";
  const seed = await daily("2026-11-25");
  await db.exec("RESET ROLE");
  // Synthetic prior head isolates the holiday boundary without bypassing unknown November 19 hours in production.
  await db.query(
    `insert into public.ledger_model_series(user_id,series_id,strategy_id,role,scheduled_start,config_hash,payload) values($1,$2,'O1','ALLOCATOR_SHADOW','2026-10-12',$3,$4)`,
    [isolatedOwner, seed.bookId, seed.contractHash, seed.registry],
  );
  await db.query(
    `insert into public.ledger_model_sessions(user_id,series_id,session_date,state_hash,payload) values($1,$2,'2026-11-25',$3,$4)`,
    [isolatedOwner, seed.bookId, seed.stateHash, seed],
  );
  await auth(isolatedOwner);
  const thanksgiving = await daily("2026-11-26", seed);
  expect(thanksgiving.publication.markets).toEqual(["K", "E"]);
  const advanced = structuredClone(thanksgiving);
  advanced.result.markets.U.sessions.push("2026-11-26");
  await rejected(await seal(advanced), seed, /Closed integrated market/);
  expect(await invoke(thanksgiving, seed)).toMatchObject({ reused: false });
  const early = await daily("2026-11-27", thanksgiving);
  early.result.markets.U.lastDecisionAt = "2026-11-27T18:00:00Z";
  const tooEarly = structuredClone(early);
  tooEarly.result.markets.U.lastDecisionAt = "2026-11-27T17:59:59Z";
  await rejected(await seal(tooEarly), thanksgiving, /not closed/);
  expect(await invoke(await seal(early), thanksgiving)).toMatchObject({ reused: false });
});
it("persists the actual initialization and daily publication factories with independent availability/decision times", async () => {
  await auth("44444444-4444-4444-8444-444444444444");
  const initialization = await prepareIntegratedInitialization("S07", codeHash);
  expect(await invoke(initialization)).toMatchObject({ initialized: true, reused: false });
  const date = "2026-10-12";
  const sessions = await Promise.all(
    ALLOCATION_MARKETS.map(async (market) => {
      const exchange = market === "U" ? "US" : "KR";
      const source = await octoberModelCalendar(exchange, evidence.coverageEnd);
      return {
        market,
        date,
        previousSessionDate: null,
        openAt: regularOpenAt(exchange, date),
        closeAt: regularCloseAt(exchange, date),
        availableAt: market === "U" ? "2026-10-12T20:01:00Z" : "2026-10-13T08:00:00+09:00",
        decisionAt: market === "U" ? "2026-10-12T20:02:00Z" : "2026-10-13T08:10:00+09:00",
        sourceHash: codeHash,
        codeHash,
        calendar: {
          sourceHash: source.sourceHash,
          sessions: source.regularSessions.filter((d) => d >= date),
        },
        prices: [],
        signalObservation: "COMPLETE" as const,
        deliveredEntrySignals:
          market === "K"
            ? [
                {
                  symbol: "005930",
                  venue: "KOSPI" as const,
                  sector: "fixture",
                  side: "BUY" as const,
                  originDate: date,
                  reason: "ENTRY",
                  annualVolatility: 0.3,
                },
              ]
            : [],
        rawOnsets: market === "K" ? ["005930"] : [],
        signals: [],
      };
    }),
  );
  const publication = await prepareIntegratedDailyPublication({
    registry: initialization.registry,
    previous: null,
    date,
    sessions,
    now: "2026-10-13T00:00:00Z",
  });
  expect(Date.parse(publication.publication.decisionAt)).toBeGreaterThan(
    Date.parse(publication.publication.availableAt),
  );
  const staticReview = structuredClone(publication);
  staticReview.result.receipts.push({
    id: "month:2026-10",
    inputHash: codeHash,
    record: {
      id: "month:2026-10",
      type: "MONTH_REVIEW",
      date: "2026-10",
      sourceHash: codeHash,
      fills: [],
      cancelledBuys: [],
      transfers: [],
      issues: [],
    },
  });
  staticReview.result.lastReviewMonth = "2026-10";
  await rejected(await seal(staticReview), null, /S07 monthly receipt forbidden/);
  expect(await invoke(publication)).toMatchObject({
    reused: false,
    stateHash: publication.stateHash,
  });
  expect(await invoke(publication)).toMatchObject({ reused: true });
  expect(
    (await db.query<{ payload: unknown }>(`select payload from public.ledger_model_sessions`))
      .rows[0]!.payload,
  ).toEqual(publication);
  expect(publication.result.deliveredEntrySignals).toHaveLength(1);
  const second = await daily("2026-10-13", publication, "S07");
  const rewritten = structuredClone(second);
  rewritten.result.deliveredEntrySignals[0]!.reason = "REWRITTEN";
  await rejected(await seal(rewritten), publication, /delivered-signal prefix/);
  const duplicate = structuredClone(second);
  duplicate.result.deliveredEntrySignals.push(duplicate.result.deliveredEntrySignals[0]!);
  await rejected(await seal(duplicate), publication, /Duplicate integrated delivered/);
  const missing = structuredClone(second);
  missing.result.markets.K.signalObservations[0]!.status = "MISSING";
  await rejected(await seal(missing), publication, /signal-observation prefix/);
  const falseSignal = structuredClone(second);
  falseSignal.result.deliveredEntrySignals.push({
    ...falseSignal.result.deliveredEntrySignals[0]!,
    symbol: "000660",
    originDate: "2026-10-13",
    confirmationDate: "2026-10-13",
    sourceHash: await hashSeriesValue("2026-10-13"),
  });
  await rejected(await seal(falseSignal), publication, /delivered entry evidence/);
  expect(await invoke(second, publication)).toMatchObject({ reused: false });
});
it("atomically creates the first registry and session only after a complete valid first-day batch", async () => {
  await auth("55555555-5555-4555-8555-555555555555");
  const first = await daily();
  const missing = structuredClone(first);
  missing.result.receipts.pop();
  await rejected(await seal(missing), null, /daily event set/);
  expect((await db.query(`select * from public.ledger_model_series`)).rows).toEqual([]);
  expect(await invoke(first)).toMatchObject({ reused: false });
  expect((await db.query(`select * from public.ledger_model_series`)).rows).toHaveLength(1);
  expect((await db.query(`select * from public.ledger_model_sessions`)).rows).toHaveLength(1);
});
it("rejects corrupt inner hashes and noncanonical equivalent bytes before an append-only head is created", async () => {
  await auth("66666666-6666-4666-8666-666666666666");
  const first = await daily();
  const corrupt = structuredClone(first);
  corrupt.result.stateHash = `sha256:${"f".repeat(64)}`;
  await rejected(await seal(corrupt, false), null, /inner canonical state hash/);
  const { stateHash: _hash, canonicalPayload: _canonical, ...body } = first;
  const text = JSON.stringify(body, null, 2);
  await rejected(
    {
      ...first,
      canonicalPayload: text,
      stateHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    },
    null,
    /canonical bytes/,
  );
  const { stateHash: _innerHash, ...inner } = first.result;
  const innerPretty = JSON.stringify(inner, null, 2);
  const forgedBody = {
    ...body,
    result: {
      ...inner,
      stateHash: `sha256:${createHash("sha256").update(innerPretty).digest("hex")}`,
    },
    resultCanonicalPayload: innerPretty,
  };
  await rejected(
    {
      ...forgedBody,
      canonicalPayload: canonicalSeriesJson(forgedBody),
      stateHash: await hashSeriesValue(forgedBody),
    },
    null,
    /canonical bytes/,
  );
  expect((await db.query(`select * from public.ledger_model_series`)).rows).toEqual([]);
});
it("reconstructs canonical byte parity for supported number/string edges and rejects lossy encodings", async () => {
  const statement = draft
    .match(/WITH RECURSIVE[\s\S]*?FROM tokens;/)![0]
    .replace("a_canonical_value", "$1::jsonb")
    .replace("INTO a_rendered,a_valid", "");
  const values: unknown[] = [
    null,
    {},
    [],
    true,
    false,
    0,
    -0,
    0.1,
    0.30000000000000004,
    1e-6,
    1e-7,
    -1e-6,
    -1e-7,
    Number.MAX_SAFE_INTEGER,
    { z: [], a: { b: "한글 😀 \n \t \u2028" }, m: 1.2345678901234567 },
  ];
  for (const value of values) {
    const row = (
      await db.query<{ canonical: string; valid: boolean }>(statement, [JSON.stringify(value)])
    ).rows[0]!;
    expect(row).toEqual({ canonical: canonicalSeriesJson(value), valid: true });
  }
  for (const raw of [
    '{"a":70510386455392576}',
    '{"a":70510386455392580}',
    '{"a":9007199254740992}',
    '{"a":0.10000000000000001}',
    '{"한글":1}',
  ]) {
    expect((await db.query<{ valid: boolean }>(statement, [raw])).rows[0]!.valid).toBe(false);
  }
});
it("rejects drifted existing RPC definitions before applying or rolling back", async () => {
  await db.exec("RESET ROLE");
  await expect(db.exec(draft)).rejects.toThrow(/unchanged owner append boundary/);
  await db.exec("rollback");
  await expect(db.exec(rollback)).rejects.toThrow(/unchanged owner append boundary/);
  await db.exec("rollback");
});
it("rollback removes only the new capability, retaining exact old body, ACL and every stored row", async () => {
  await db.exec("RESET ROLE");
  const rows = (
    await db.query(
      `select * from public.ledger_model_sessions order by user_id,series_id,session_date`,
    )
  ).rows;
  await db.exec(patchedDefinition);
  await db.exec(rollback);
  await db.exec(rollback);
  expect(await acl()).toEqual(beforeAcl);
  expect(await catalog()).toEqual(beforeCatalog);
  expect(
    (
      await db.query(
        `select * from public.ledger_model_sessions order by user_id,series_id,session_date`,
      )
    ).rows,
  ).toEqual(rows);
  expect(
    (
      await db.query<{ prosrc: string }>(
        `select prosrc from pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure`,
      )
    ).rows[0]!.prosrc,
  ).toBe(originalBody);
  await auth();
  await expect(invoke(await initialization())).rejects.toThrow(/Only the eight/);
});

it("continues an owner-initialized allocation through the existing service-only batch RPC", async () => {
  await db.exec("RESET ROLE");
  await db.exec(
    patchedDefinition.replaceAll(
      "pg_catalog.statement_timestamp()",
      "'2026-10-14T23:00:00Z'::timestamptz",
    ),
  );
  const batchOwner = "77777777-7777-4777-8777-777777777777";
  const interactiveOwner = "99999999-9999-4999-8999-999999999999";
  await auth(interactiveOwner);
  await invoke(await initialization("S07"));
  const seed = await prepareIntegratedInitialization("S07", codeHash);
  const makeSessions = async (date: string, previousSessionDate: string | null) =>
    Promise.all(
      ALLOCATION_MARKETS.map(async (market) => {
        const exchange = market === "U" ? "US" : "KR";
        const calendar = await octoberModelCalendar(exchange, evidence.coverageEnd);
        const signal = {
          symbol: "005930",
          venue: "KOSPI" as const,
          sector: "fixture",
          side: "BUY" as const,
          originDate: "2026-10-12",
          reason: "ENTRY",
          annualVolatility: 0.3,
        };
        const signals = market === "K" && date === "2026-10-12" ? [signal] : [];
        return {
          market,
          date,
          previousSessionDate,
          openAt: regularOpenAt(exchange, date),
          closeAt: regularCloseAt(exchange, date),
          availableAt: market === "U" ? `${date}T20:01:00Z` : `${nextKr(date)}T08:00:00+09:00`,
          decisionAt: market === "U" ? `${date}T20:02:00Z` : `${nextKr(date)}T08:10:00+09:00`,
          sourceHash: codeHash,
          codeHash,
          calendar: {
            sourceHash: calendar.sourceHash,
            sessions: calendar.regularSessions.filter((d) => d >= "2026-10-12"),
          },
          prices:
            market === "K"
              ? [
                  {
                    symbol: "005930",
                    open: "100",
                    close: "100",
                    volume: 100000,
                    maxBuyQuantity: null,
                  },
                ]
              : [],
          signalObservation: "COMPLETE" as const,
          deliveredEntrySignals: signals,
          signals,
          rawOnsets: signals.map((x) => x.symbol),
        };
      }),
    );
  const interactivePublication = await prepareIntegratedDailyPublication({
    registry: seed.registry,
    previous: null,
    date: "2026-10-12",
    sessions: await makeSessions("2026-10-12", null),
    now: "2026-10-14T23:00:00Z",
  });
  await invoke(interactivePublication);
  const filled = await prepareIntegratedDailyPublication({
    registry: seed.registry,
    previous: interactivePublication,
    date: "2026-10-13",
    sessions: await makeSessions("2026-10-13", "2026-10-12"),
    now: "2026-10-14T23:00:00Z",
  });
  expect(Number(filled.result.markets.K.positions[0]?.quantity)).toBeGreaterThan(0);
  await invoke(filled, interactivePublication);
  await auth(batchOwner);
  await invoke(await initialization("S07"));
  const publication = interactivePublication;
  // A service JWT has no user sub. It supplies the configured owner through the existing service API.
  await auth("", false, "service_role");
  const args = [batchOwner, JSON.stringify(publication.registry), JSON.stringify(publication)];
  const run = () =>
    db.query<{ result: { reused: boolean; stateHash: string } }>(
      "select public.ledger_append_model_session($1::uuid,$2::jsonb,$3::jsonb,null,null) result",
      args,
    );
  expect((await run()).rows[0]?.result).toMatchObject({
    reused: false,
    stateHash: publication.stateHash,
  });
  expect((await run()).rows[0]?.result.reused).toBe(true);
  await db.query(
    "select public.ledger_append_model_session($1::uuid,$2::jsonb,$3::jsonb,$4::date,$5::text)",
    [
      batchOwner,
      JSON.stringify(filled.registry),
      JSON.stringify(filled),
      publication.receipt.date,
      publication.stateHash,
    ],
  );
  const parity = await db.query<{ payload: unknown }>(
    "select payload from public.ledger_model_sessions where user_id=any($1::uuid[]) and series_id=$2 and session_date='2026-10-13' order by user_id",
    [[batchOwner, interactiveOwner], publication.bookId],
  );
  expect(parity.rows).toHaveLength(2);
  expect(parity.rows[0]!.payload).toEqual(parity.rows[1]!.payload);
  await auth(batchOwner);
  await expect(run()).rejects.toThrow(/permission denied/i);
  const row = await db.query<{ role: string }>(
    "select role from public.ledger_model_series where user_id=$1 and series_id=$2",
    [batchOwner, publication.bookId],
  );
  expect(row.rows[0]?.role).toBe("ALLOCATOR_SHADOW");
});

it("rejects an unreviewed runtime even when its contract and hashes are self-consistent", async () => {
  await auth("88888888-8888-4888-8888-888888888888");
  const wrong = await prepareIntegratedInitialization("O1", `sha256:${"f".repeat(64)}`);
  await expect(invoke(wrong)).rejects.toThrow(/Reviewed integrated allocation runtime/);
});

it("reproduces the live float setting failure, then restores 0 after repaired success and canonical exceptions", async () => {
  const repair = readFileSync("docs/integrated-allocation-numeric-rendering.sql", "utf8");
  const numericRollback = readFileSync(
    "docs/integrated-allocation-numeric-rendering.rollback.sql",
    "utf8",
  );
  await db.exec("RESET ROLE");
  await db.exec(patchedDefinition);
  await db.exec("SET extra_float_digits=0");
  await auth("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const value = await initialization();
  const setting = async () =>
    (await db.query<{ value: string }>("select current_setting('extra_float_digits') value"))
      .rows[0]!.value;
  expect(await setting()).toBe("0");
  await expect(invoke(value)).rejects.toThrow("Canonical numeric rendering unavailable");
  expect((await db.query("select * from public.ledger_model_series")).rows).toEqual([]);
  expect(await setting()).toBe("0");
  await db.exec("RESET ROLE");
  const originalCatalog = await catalog(),
    originalAcl = await acl();
  const originalGenericBody = (
    await db.query<{ body: string }>(
      "select prosrc body from pg_proc where oid='public.ledger_append_model_session(uuid,jsonb,jsonb,date,text)'::regprocedure",
    )
  ).rows[0]!.body;
  await db.exec(repair);
  await db.exec(repair);
  expect(await catalog()).toEqual(originalCatalog);
  expect(await acl()).toEqual(originalAcl);
  const repairedBody = (
    await db.query<{ body: string; md5: string }>(
      "select prosrc body, md5(prosrc) md5 from pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure",
    )
  ).rows[0]!;
  expect(repairedBody.md5).toBe("d96be8e4843146bc5278d56aaca2c7c1");
  expect(
    repairedBody.body.replace(
      / {2}-- BEGIN BOUNDED INTEGRATED ALLOCATION BRANCH[\s\S]*? {2}-- END BOUNDED INTEGRATED ALLOCATION BRANCH\n\n/,
      "",
    ),
  ).toBe(originalBody);
  expect(
    (
      await db.query<{ body: string }>(
        "select prosrc body from pg_proc where oid='public.ledger_append_model_session(uuid,jsonb,jsonb,date,text)'::regprocedure",
      )
    ).rows[0]!.body,
  ).toBe(originalGenericBody);
  await auth("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  await db.exec("BEGIN");
  for (const kind of ["O1", "S07"] as const) {
    expect(await invoke(await initialization(kind))).toMatchObject({
      initialized: true,
      reused: false,
    });
    expect(await setting()).toBe("0");
    expect(await invoke(await initialization(kind))).toMatchObject({
      initialized: true,
      reused: true,
    });
    expect(await setting()).toBe("0");
  }
  await db.exec("COMMIT");
  const bad = { ...value, canonicalPayload: ` ${value.canonicalPayload}` };
  bad.stateHash = `sha256:${createHash("sha256").update(bad.canonicalPayload).digest("hex")}`;
  await expect(invoke(bad)).rejects.toThrow(/canonical bytes mismatch/);
  expect(await setting()).toBe("0");
  // Also catch the failure inside the same outer transaction, rather than relying on autocommit rollback.
  await db.exec(`DO $test$ BEGIN
    BEGIN
      PERFORM public.ledger_append_own_october_model_session($json$${JSON.stringify(bad)}$json$::jsonb,null,null);
      RAISE EXCEPTION 'Unexpected canonical validation success';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM NOT LIKE 'Integrated canonical bytes mismatch%' THEN RAISE; END IF;
    END;
    IF current_setting('extra_float_digits') <> '0' THEN RAISE EXCEPTION 'Caller setting leaked'; END IF;
  END $test$;`);
  expect(await setting()).toBe("0");
  await db.exec("SET extra_float_digits=3; BEGIN");
  expect(await invoke(value)).toMatchObject({ initialized: true, reused: true });
  expect(await setting()).toBe("3");
  await db.exec("COMMIT");
  expect(await setting()).toBe("3");
  await db.exec("RESET ROLE");
  const rowsBefore = (
    await db.query("select * from public.ledger_model_series order by user_id,series_id")
  ).rows;
  await db.exec(numericRollback);
  await db.exec(numericRollback);
  expect(
    (
      await db.query<{ md5: string }>(
        "select md5(prosrc) md5 from pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure",
      )
    ).rows[0]!.md5,
  ).toBe("604613388f3dfac68fafad59ab7f3950");
  expect(
    (await db.query("select * from public.ledger_model_series order by user_id,series_id")).rows,
  ).toEqual(rowsBefore);
  expect(await acl()).toEqual(originalAcl);
  await db.exec(repair);
  expect(await catalog()).toEqual(originalCatalog);
});

it("keeps owner/service state-hash parity under inherited extra_float_digits=0", async () => {
  const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await db.exec("RESET ROLE");
  const repaired = (
    await db.query<{ definition: string }>(
      "select pg_get_functiondef('public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure) definition",
    )
  ).rows[0]!.definition;
  await db.exec(
    repaired.replaceAll("pg_catalog.statement_timestamp()", "'2026-10-14T23:00:00Z'::timestamptz"),
  );
  await db.exec("SET extra_float_digits=0");
  const run = await daily("2026-10-12", null, "S07");
  await auth(ownerA);
  await invoke(await initialization("S07"));
  expect(await invoke(run)).toMatchObject({ stateHash: run.stateHash });
  await auth(ownerB);
  await invoke(await initialization("S07"));
  await auth("", false, "service_role");
  const service = await db.query<{ result: { stateHash: string } }>(
    "select public.ledger_append_model_session($1::uuid,$2::jsonb,$3::jsonb,null,null) result",
    [ownerB, JSON.stringify(run.registry), JSON.stringify(run)],
  );
  expect(service.rows[0]!.result.stateHash).toBe(run.stateHash);
  const rows = (
    await db.query<{ payload: unknown }>(
      "select payload from public.ledger_model_sessions where user_id=any($1::uuid[]) and series_id=$2 order by user_id",
      [[ownerA, ownerB], run.bookId],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]!.payload).toEqual(rows[1]!.payload);
  expect(
    (await db.query<{ value: string }>("select current_setting('extra_float_digits') value"))
      .rows[0]!.value,
  ).toBe("0");
  await db.exec("RESET ROLE; SET extra_float_digits=1");
  await db.exec(repaired);
});
