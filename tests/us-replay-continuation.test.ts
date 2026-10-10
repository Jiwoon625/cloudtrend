/* eslint-disable @typescript-eslint/no-explicit-any -- The in-memory PostgREST fixture and adversarial malformed-payload tests deliberately accept arbitrary JSON. */
import { describe, expect, it, vi } from "vitest";
import type { trustedSupabaseClient } from "../scripts/analysis-run-store";
import { stableJson } from "../scripts/analysis-run-store";
import { runUsScreening } from "../scripts/run-us-screening";
import { runUsGapReplay } from "../scripts/run-us-gap-replay";
import { bytesHash } from "../scripts/us-replay-source";
import {
  US_OPERATING_STRATEGY_IDS,
  type UsOperatingReplayPlan,
} from "../scripts/us-operating-replay";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
import { US_PROSPECTIVE_STRATEGIES } from "../src/lib/engine/usProspectivePortfolio";
import type { OctoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import {
  recordOctoberPublication,
  type OctoberRun,
  type PreparedOctoberPublication,
} from "../src/lib/ledger/octoberShadowPipeline";
import {
  freezeAdoptedSeries,
  hashSeriesValue,
  VERIFIED_INITIAL_FX,
  type FrozenModelSeries,
  type AdoptedSeriesKind,
  type SeriesHash,
} from "../src/lib/ledger/modelSeries";
import type { ModelJournalRun } from "../src/lib/ledger/modelJournal";
import { ADOPTED_SHADOW_FROZEN_CODE_HASH } from "../src/lib/ledger/octoberShadowRuntime";
import engineManifest from "../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import { shadowReplayClock } from "../src/lib/shadowReplay.server";
import { sourceCsv } from "./us-replay-fixtures";
const mock = vi.hoisted(() => ({ store: null as unknown, publish: vi.fn() }));
vi.mock("../src/lib/ledger/octoberShadowRepository.server", () => ({
  octoberShadowStore: () => mock.store,
}));
vi.mock("../scripts/us-screening-publication", async (original) => ({
  ...(await original<typeof import("../scripts/us-screening-publication")>()),
  publishBrowserViews: mock.publish,
}));
const uid = "11111111-1111-4111-8111-111111111111";
const baseDate = "2026-10-07",
  recoveredDate = "2026-10-08",
  currentDate = "2026-10-09";
const csv = (date: string) =>
  sourceCsv(date) +
  `${date},NEW,NEW,20,22,19,21,1000,${date === currentDate ? "0.5,0.6" : "0.05,0.1"},1.3,0.3,1.6,2000000,0.0001,true,true,true\n`;

async function fixture(options: { pending?: boolean; held?: boolean; filled?: boolean } = {}) {
  const files = new Map<string, string>();
  const writes: string[] = [],
    reads: string[] = [];
  let failAt = "";
  const hit = (point: string) => {
    if (failAt === point) {
      failAt = "";
      throw new Error(`Injected ${point}`);
    }
  };
  const appliedPlans = new Map<string, UsOperatingReplayPlan>();
  const tables: Record<string, any[]> = {};
  const registry = new Map<string, FrozenModelSeries>();
  const sessions = new Map<string, ModelJournalRun>();
  const prepared = new Map<string, PreparedOctoberPublication>();
  const store: OctoberShadowStore = {
    async readKrInput() {
      throw new Error("KR forbidden");
    },
    async putKrInput() {
      throw new Error("KR forbidden");
    },
    async readSeries(b) {
      return registry.get(b) ?? null;
    },
    async insertSeries(s) {
      registry.set(s.bookId, structuredClone(s));
    },
    async readLatest<T extends ModelJournalRun>(b: string) {
      return (
        ([...sessions.values()]
          .filter((r) => r.bookId === b)
          .sort((a, b) => b.receipt.date.localeCompare(a.receipt.date))[0] as T | undefined) ?? null
      );
    },
    async readSession<T extends ModelJournalRun>(b: string, d: string) {
      return (sessions.get(`${b}:${d}`) as T | undefined) ?? null;
    },
    async readPrepared(m, d) {
      return prepared.get(`${m}:${d}`) ?? null;
    },
    async prepare(p) {
      const old = prepared.get(`${p.market}:${p.date}`);
      if (old) {
        expect(p).toEqual(old);
        return old;
      }
      if (p.date === currentDate) hit("shadow prepare");
      writes.push(`shadow-prepare:${p.date}`);
      prepared.set(`${p.market}:${p.date}`, structuredClone(p));
      return p;
    },
    async append(s, r, p) {
      expect((await store.readLatest(s.bookId))?.stateHash ?? null).toBe(p?.stateHash ?? null);
      writes.push(`shadow:${r.receipt.date}`);
      sessions.set(`${s.bookId}:${r.receipt.date}`, structuredClone(r));
      if (r.receipt.date === currentDate) hit(`shadow ${s.policy.kind}`);
      return { reused: false, stateHash: r.stateHash };
    },
  };
  mock.store = store;
  for (const kind of ["US_A0", "US_A2", "US_B3"] as AdoptedSeriesKind[])
    await store.insertSeries(
      await freezeAdoptedSeries({
        kind,
        frozenAt: "2026-10-03T00:00:00Z",
        codeHash: ADOPTED_SHADOW_FROZEN_CODE_HASH,
        sourceHash: bytesHash("base") as SeriesHash,
        initialFx: VERIFIED_INITIAL_FX,
      }),
    );
  let state = {};
  for (const [i, date] of ["2026-10-05", "2026-10-06", baseDate].entries()) {
    const analysis = runUsProspectiveAnalysis(parseUsProspectiveCsv(csv(date)), state);
    const clock = shadowReplayClock("US", date, "2026-10-10T00:00:00Z");
    await recordOctoberPublication(store, {
      market: "US",
      analysis,
      sourceHash: await hashSeriesValue({ date }),
      codeHash: ADOPTED_SHADOW_FROZEN_CODE_HASH,
      runtimeCodeHash: engineManifest.codeHash as SeriesHash,
      availableAt: clock.modelAvailableAt,
      decisionAt: clock.modelDecisionAt,
      confirmedRegularClose: true,
      failedSymbols: 0,
      previousSessionDate: ["2026-10-02", "2026-10-05", "2026-10-06"][i]!,
      marketCalendarOk: true,
    });
    state = analysis.state;
  }
  const baseAnalysis = runUsProspectiveAnalysis(parseUsProspectiveCsv(csv(baseDate)));
  // A stale ordinary rank would suppress NEW's real Oct9 onset. Reconstruction must replace it.
  baseAnalysis.state.coreRanks = { TEST: 0.1, NEW: options.pending ? 0.1 : 0.9 };
  const base = { dataHash: bytesHash("base-original"), analysis: baseAnalysis };
  files.set(`${uid}/results/us-screening/${baseDate}.json`, JSON.stringify(base));
  tables["us_screening_history"] = [
    { date: baseDate, data_hash: base.dataHash, rule_version: US_PROSPECTIVE_RULE_VERSION },
  ];
  tables["us_strategy_registry"] = [
    ...US_PROSPECTIVE_STRATEGIES.map((s) => ({
      strategy_id: s.id,
      label: s.label,
      role: s.role,
      rule_version: US_PROSPECTIVE_RULE_VERSION,
      config: s,
      active: true,
    })),
    {
      strategy_id: "SPY_BENCHMARK",
      label: "SPY Benchmark",
      role: "BENCHMARK",
      rule_version: US_PROSPECTIVE_RULE_VERSION,
      config: { symbol: "SPY", initialCapital: 100000 },
      active: true,
    },
  ];
  tables["us_portfolio_snapshots"] = US_OPERATING_STRATEGY_IDS.map((id) => ({
    strategy_id: id,
    date: baseDate,
    rule_version: US_PROSPECTIVE_RULE_VERSION,
    nav_usd: 100000,
    cash_usd: id === "SPY_BENCHMARK" ? 0 : 100000,
    benchmark_nav: 100000,
    daily_return: 0,
    cumulative_return: 0,
    turnover: 0,
    fees_usd: 0,
    positions_count: id === "SPY_BENCHMARK" ? 1 : 0,
    state:
      id === "SPY_BENCHMARK"
        ? { basePrice: 101, currentPrice: 101, symbol: "SPY" }
        : {
            initializedDate: "2026-09-28",
            lastDate: baseDate,
            initialCapital: 100000,
            cash: 100000,
            positions: {},
            pendingTargets: {},
            pendingExits: {},
            lastQuarterRebalance: null,
            benchmarkBasePrice: 101,
            benchmarkBaseDate: "2026-09-28",
            totalFees: 0,
            adv20BySymbol: {},
          },
  }));
  if (options.held) {
    const snapshot = tables["us_portfolio_snapshots"][0];
    snapshot.cash_usd -= 21;
    snapshot.positions_count = 1;
    snapshot.state.cash -= 21;
    snapshot.state.positions.NEW = {
      symbol: "NEW",
      name: "NEW",
      sector: null,
      shares: 1,
      lastPrice: 21,
      entryDate: baseDate,
      entryPrice: 21,
    };
  }
  if (options.filled) {
    const state = tables["us_portfolio_snapshots"].find(
      (r) => r.strategy_id === "A2_QUARTER_SHADOW",
    ).state;
    state.pendingTargets.NEW = {
      symbol: "NEW",
      signalDate: baseDate,
      targetWeight: 0.05,
      reason: "ENTRY_ONSET80",
    };
    state.adv20BySymbol.NEW = 2000000;
  }
  tables["us_portfolio_trades"] = [];
  const metadata = {
    confirmedRegularClose: true,
    failedSymbols: 0,
    previousSessionDate: recoveredDate,
  };
  const ingest = {
    as_of_date: currentDate,
    data_hash: bytesHash(csv(currentDate)),
    storage_bucket: "cloudtrend-data",
    storage_path: `${uid}/input.csv`,
    row_count: 3,
    symbol_count: 3,
    collected_at: `${currentDate}T21:00:00Z`,
    metadata,
  };
  tables["us_screening_ingest"] = [ingest];
  files.set(ingest.storage_path, csv(currentDate));
  let onUpload: ((p: string) => void) | undefined;
  const client = {
    from(table: string) {
      reads.push(table);
      if (/actual|beta/i.test(table)) throw new Error(`Forbidden table: ${table}`);
      const filters: ((r: any) => boolean)[] = [];
      let selected = "*",
        sort = "",
        ascending = true,
        count = Infinity;
      const result = () => {
        let data = [...(tables[table] ?? [])].filter((r) => filters.every((f) => f(r)));
        if (sort)
          data.sort(
            (a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1),
          );
        data = data.slice(0, count);
        return data.map((r) =>
          selected === "*"
            ? structuredClone(r)
            : Object.fromEntries(selected.split(",").map((k) => [k, structuredClone(r[k])])),
        );
      };
      const q: any = {
        select(v: string) {
          selected = v;
          return q;
        },
        eq(k: string, v: unknown) {
          if (k !== "user_id") filters.push((r) => r[k] === v);
          return q;
        },
        lt(k: string, v: string) {
          filters.push((r) => r[k] < v);
          return q;
        },
        gte(k: string, v: string) {
          filters.push((r) => r[k] >= v);
          return q;
        },
        lte(k: string, v: string) {
          filters.push((r) => r[k] <= v);
          return q;
        },
        in(k: string, v: unknown[]) {
          filters.push((r) => v.includes(r[k]));
          return q;
        },
        order(k: string, opts?: { ascending: boolean }) {
          sort = k;
          ascending = opts?.ascending ?? true;
          return q;
        },
        limit(n: number) {
          count = n;
          return q;
        },
        async maybeSingle() {
          return { data: result()[0] ?? null, error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({ data: result(), error: null }).then(resolve);
        },
        async upsert(value: any, opts: { onConflict: string }) {
          writes.push(table);
          for (const row of Array.isArray(value) ? value : [value]) {
            const keys = opts.onConflict.split(",").filter((k) => k !== "user_id");
            const old = (tables[table] ??= []).find((r) => keys.every((k) => r[k] === row[k]));
            if (old) Object.assign(old, structuredClone(row));
            else tables[table].push(structuredClone(row));
          }
          return { error: null };
        },
        async insert(row: any) {
          if (table === "us_screening_history" && row.date === currentDate) hit("history before");
          writes.push(table);
          (tables[table] ??= []).push(structuredClone(row));
          if (table === "us_screening_history" && row.date === currentDate) hit("history after");
          return { error: null };
        },
        update(value: any) {
          writes.push(table);
          q.then = (resolve: (v: unknown) => unknown) => {
            for (const r of tables[table] ?? [])
              if (filters.every((f) => f(r))) Object.assign(r, structuredClone(value));
            return Promise.resolve({ error: null }).then(resolve);
          };
          return q;
        },
      };
      return q;
    },
    async rpc(name: string, args: { p_plan: UsOperatingReplayPlan; p_apply: boolean }) {
      expect(name).toBe("apply_us_operating_replay");
      const receipt = {
        version: "us-operating-replay-v1",
        planHash: args.p_plan.planHash,
        baseDate: args.p_plan.baseDate,
        throughDate: args.p_plan.throughDate,
        snapshotsInserted: args.p_plan.snapshots.length,
        tradesInserted: args.p_plan.trades.length,
        pendingResolved: args.p_plan.pendingResolutions.length,
        validated: true,
      };
      if (appliedPlans.has(args.p_plan.planHash)) {
        for (const expected of args.p_plan.snapshots) {
          const actual = tables["us_portfolio_snapshots"].find(
            (r) => r.strategy_id === expected.strategy_id && r.date === expected.date,
          );
          if (stableJson(actual) !== stableJson(expected))
            return { data: null, error: { message: "Committed snapshot changed" } };
        }
        for (const expected of args.p_plan.trades) {
          const actual = tables["us_portfolio_trades"].find(
            (r) => r.trade_key === expected.trade_key,
          );
          if (
            !actual ||
            (stableJson(actual) !== stableJson(expected) &&
              !(
                expected.status === "PENDING" &&
                actual.status === "CANCELLED" &&
                actual.detail.resolved_on > args.p_plan.throughDate
              ))
          )
            return { data: null, error: { message: "Committed trade changed" } };
        }
        return { data: { ...receipt, alreadyApplied: true }, error: null };
      }
      if (args.p_apply) {
        if (args.p_plan.throughDate === currentDate) hit("RPC before");
        writes.push("operating-rpc");
        tables["us_portfolio_snapshots"].push(...structuredClone(args.p_plan.snapshots));
        tables["us_portfolio_trades"].push(...structuredClone(args.p_plan.trades));
        for (const resolution of args.p_plan.pendingResolutions) {
          const old = tables["us_portfolio_trades"].find(
            (r) => r.trade_key === resolution.trade_key,
          );
          old.status = "CANCELLED";
          old.detail = {
            ...old.detail,
            resolution: "ROLLED_FORWARD_OR_RESOLVED",
            resolved_on: resolution.resolved_on,
          };
        }
        appliedPlans.set(args.p_plan.planHash, structuredClone(args.p_plan));
        if (args.p_plan.throughDate === currentDate) hit("RPC after");
      }
      return { data: receipt, error: null };
    },
    storage: {
      from: () => ({
        async download(path: string) {
          reads.push(path);
          return files.has(path)
            ? { data: { text: async () => files.get(path)! }, error: null }
            : { data: null, error: { message: "404 Object not found" } };
        },
        async upload(path: string, body: string, opts: { upsert: boolean }) {
          onUpload?.(path);
          if (path.endsWith(`${currentDate}.plan.json`)) hit("plan upload");
          if (path.endsWith(`${currentDate}.manifest.json`)) hit("manifest upload");
          if (path.endsWith(`${currentDate}.receipt.json`)) hit("receipt upload");
          if (path.endsWith(`/us-screening/${currentDate}.json`)) hit("result upload");
          if (path.endsWith("/latest.json")) hit("cache upload");
          writes.push(path);
          if (files.has(path) && !opts.upsert) return { error: { message: "Already exists" } };
          files.set(path, body);
          return { error: null };
        },
      }),
    },
  } as unknown as ReturnType<typeof trustedSupabaseClient>;
  const roster = JSON.stringify({
    version: "us-dated-roster-v1",
    asOfDate: baseDate,
    capturedAt: `${baseDate}T21:00:00Z`,
    rows: parseUsProspectiveCsv(csv(baseDate)),
  });
  const recoveredCsv = options.pending
    ? csv(recoveredDate).replace("0.05,0.1", "0.5,0.6")
    : csv(recoveredDate);
  const source = {
    date: recoveredDate,
    previousSessionDate: baseDate,
    storagePath: `${uid}/recovered.csv`,
    dataHash: bytesHash(recoveredCsv),
    rowCount: 3,
    symbolCount: 3,
    sourceCapturedAt: "2026-10-10T00:00:00Z",
    confirmedRegularClose: true,
    failedSymbols: 0,
    sourceCoverageComplete: true,
    quarantinedSymbols: [],
    pit: {
      kind: "DATED_ROSTER_RECONSTRUCTION",
      asOfDate: baseDate,
      rosterCapturedAt: `${baseDate}T21:00:00Z`,
      rosterStoragePath: `${uid}/roster.json`,
      rosterHash: bytesHash(roster),
    },
  };
  const manifest = JSON.stringify(
    { version: "us-dated-replay-v1", baseDate, throughDate: recoveredDate, sessions: [source] },
    null,
    2,
  );
  const manifestPath = `${uid}/replay-manifest.json`,
    manifestHash = bytesHash(manifest);
  files.set(source.storagePath, recoveredCsv);
  files.set(source.pit.rosterStoragePath, roster);
  files.set(manifestPath, manifest);
  await runUsGapReplay({
    client,
    userId: uid,
    manifestPath,
    manifestHash,
    apply: true,
    calculatedAt: "2026-10-10T00:30:00Z",
  });
  const prefix = `${uid}/results/us-gap-replay/${manifestHash.slice(7)}`;
  writes.length = 0;
  reads.length = 0;
  mock.publish.mockClear();
  return {
    client,
    files,
    writes,
    reads,
    tables,
    registry,
    sessions,
    prepared,
    ingest,
    store,
    prefix,
    base,
    manifest,
    failOnce(point: string) {
      failAt = point;
    },
    setOnUpload(fn: (p: string) => void) {
      onUpload = fn;
    },
    edit(path: string, change: (value: any) => void) {
      const value = JSON.parse(files.get(path)!);
      change(value);
      files.set(path, JSON.stringify(value));
    },
  };
}

describe("completed reconstruction to ordinary daily continuation", () => {
  it("uses Oct8 recovered ranks and every book to screen Oct9 without inventing Oct8 history; Oct12 remains pending", async () => {
    const f = await fixture();
    const original = f.files.get(`${uid}/results/us-screening/${baseDate}.json`);
    const prior = structuredClone(f.tables["us_portfolio_snapshots"]);
    const shadowPrefix = structuredClone([...f.sessions]);
    expect(f.files.get(`${f.prefix}/manifest.json`)).toBe(f.manifest);
    expect(f.tables["us_screening_history"].map((r) => r.date)).toEqual([baseDate]);
    await runUsScreening(f.client, uid);
    expect(f.tables["us_screening_history"].map((r) => r.date)).toEqual([baseDate, currentDate]);
    expect(f.files.has(`${uid}/results/us-screening/${recoveredDate}.json`)).toBe(false);
    expect(f.files.get(`${uid}/results/us-screening/${baseDate}.json`)).toBe(original);
    expect(f.tables["us_portfolio_snapshots"].filter((r) => r.date < currentDate)).toEqual(prior);
    for (const [k, v] of shadowPrefix) expect(f.sessions.get(k)).toEqual(v);
    const result = JSON.parse(f.files.get(`${uid}/results/us-screening/${currentDate}.json`)!);
    expect(result.analysis.rows.find((r: any) => r.symbol === "NEW").a0Entry).toBe(true);
    expect(
      runUsProspectiveAnalysis(
        parseUsProspectiveCsv(csv(currentDate)),
        f.base.analysis.state,
      ).rows.find((r) => r.symbol === "NEW")!.a0Entry,
    ).toBe(false);
    for (const id of US_OPERATING_STRATEGY_IDS)
      expect(
        f.tables["us_portfolio_snapshots"].filter((r) => r.strategy_id === id).at(-1).date,
      ).toBe(currentDate);
    const pending = f.tables["us_portfolio_trades"].filter(
      (r) => r.symbol === "NEW" && r.signal_date === currentDate,
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((r) => r.status === "PENDING" && r.execution_date === null)).toBe(true);
    const preview = f.tables["us_portfolio_snapshots"].find(
      (r) => r.date === currentDate && r.strategy_id === "A0_QUARTER_PRIMARY",
    ).state.orderPreview;
    expect(JSON.stringify(preview)).toContain("2026-10-12");
    expect([...f.sessions.values()].filter((r) => r.receipt.date === currentDate)).toHaveLength(3);
    expect(f.reads.some((p) => /actual|frozen-beta/i.test(p))).toBe(false);
  });

  it.each(["receipt.json", "plan.json", "manifest.json"])(
    "blocks missing %s before any writes",
    async (name) => {
      const f = await fixture();
      f.files.delete(`${f.prefix}/${name}`);
      await expect(runUsScreening(f.client, uid)).rejects.toThrow(
        "Previous US replay publication is incomplete",
      );
      expect(f.writes).toEqual([]);
    },
  );
  it.each([
    [
      "not applied",
      "receipt.json",
      (v: any) => {
        v.applied = false;
      },
    ],
    [
      "wrong receipt range",
      "receipt.json",
      (v: any) => {
        v.throughDate = currentDate;
      },
    ],
    [
      "forged operating hash",
      "receipt.json",
      (v: any) => {
        v.operatingPlanHash = bytesHash("forged");
      },
    ],
    [
      "missing Shadow receipt",
      "receipt.json",
      (v: any) => {
        v.shadowStateHashes[0].records.pop();
      },
    ],
    [
      "forged Shadow hash",
      "receipt.json",
      (v: any) => {
        v.shadowStateHashes[0].records[0].stateHash = bytesHash("forged");
      },
    ],
    [
      "modified operating plan",
      "plan.json",
      (v: any) => {
        v.operating.snapshots[0].cash_usd += 1;
      },
    ],
    [
      "modified Shadow analysis",
      "plan.json",
      (v: any) => {
        v.shadow.analyses[0].state.coreRanks.NEW = 0.9;
      },
    ],
    [
      "modified manifest",
      "manifest.json",
      (v: any) => {
        v.sessions[0].pit.kind = "ATOMIC_DATED_SNAPSHOT";
      },
    ],
  ])("rejects %s before mutation", async (_label, name, mutate) => {
    const f = await fixture();
    f.edit(`${f.prefix}/${name}`, mutate);
    await expect(runUsScreening(f.client, uid)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it("rejects a forged rank artifact despite a genuine applied receipt", async () => {
    const f = await fixture();
    f.edit(`${uid}/results/us-replay-state/${recoveredDate}.json`, (v) => {
      v.analysis.state.coreRanks.NEW = 0.9;
    });
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("rank artifact identity");
    expect(f.writes).toEqual([]);
  });
  it.each([...US_OPERATING_STRATEGY_IDS])("requires exact %s operating predecessor", async (id) => {
    const f = await fixture();
    f.tables["us_portfolio_snapshots"] = f.tables["us_portfolio_snapshots"].filter(
      (r) => r.strategy_id !== id || r.date !== recoveredDate,
    );
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("operating predecessor");
    expect(f.writes).toEqual([]);
  });
  it.each(["US_A0", "US_A2", "US_B3"])("requires committed %s Shadow predecessor", async (id) => {
    const f = await fixture();
    const run = [...f.sessions.values()].find(
      (r) => r.bookId.endsWith(id) && r.receipt.date === recoveredDate,
    )!;
    f.sessions.delete(`${run.bookId}:${recoveredDate}`);
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("Shadow predecessor");
    expect(f.writes).toEqual([]);
  });
  it("rejects model pending ledger changes and original result changes", async () => {
    const f = await fixture();
    f.tables["us_portfolio_trades"].push({
      strategy_id: "A0_QUARTER_PRIMARY",
      status: "PENDING",
      trade_key: "forged",
    });
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("pending model trades");
    expect(f.writes).toEqual([]);
    f.tables["us_portfolio_trades"] = [];
    f.files.set(`${uid}/results/us-screening/${baseDate}.json`, "{}");
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("protected original");
    expect(f.writes).toEqual([]);
  });
  it("retains the same-day partial replay block even with a completed prior reconstruction", async () => {
    const f = await fixture();
    f.files.set(`${uid}/results/us-replay-state/${currentDate}.json`, "{}");
    await expect(runUsScreening(f.client, uid)).rejects.toThrow(
      "US replay publication is incomplete",
    );
    expect(f.writes).toEqual([]);
  });
  it.each(["history", "ingest", "operating", "shadow", "rank", "target replay"])(
    "rechecks a concurrent %s change before advancing any ledger",
    async (kind) => {
      const f = await fixture();
      f.setOnUpload((path) => {
        if (!path.endsWith(`${currentDate}.manifest.json`)) return;
        if (kind === "rank")
          f.edit(`${uid}/results/us-replay-state/${recoveredDate}.json`, (v) => {
            v.analysis.state.coreRanks.NEW = 0.9;
          });
        if (kind === "target replay")
          f.files.set(`${uid}/results/us-replay-state/${currentDate}.json`, "{}");
        if (kind === "history")
          f.tables["us_screening_history"].push({
            date: currentDate,
            data_hash: bytesHash("other"),
            rule_version: US_PROSPECTIVE_RULE_VERSION,
          });
        if (kind === "ingest") f.ingest.data_hash = bytesHash("other");
        if (kind === "operating") {
          const row = structuredClone(f.tables["us_portfolio_snapshots"].at(-1));
          row.date = currentDate;
          f.tables["us_portfolio_snapshots"].push(row);
        }
        if (kind === "shadow") {
          const run = structuredClone([...f.sessions.values()].at(-1)!);
          run.receipt.date = currentDate;
          f.sessions.set(`${run.bookId}:${currentDate}`, run);
        }
      });
      await expect(runUsScreening(f.client, uid)).rejects.toThrow();
      expect(f.writes).toEqual([
        `${uid}/results/us-continuation/${currentDate}.plan.json`,
        `${uid}/results/us-screening/${currentDate}.manifest.json`,
      ]);
    },
  );
  it("rejects a conflicting current-date immutable manifest", async () => {
    const f = await fixture();
    f.files.set(
      `${uid}/results/us-screening/${currentDate}.manifest.json`,
      JSON.stringify({ dataHash: bytesHash("other"), ruleVersion: US_PROSPECTIVE_RULE_VERSION }),
    );
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("US date input is locked");
    expect(f.writes).toEqual([]);
  });
  it.each(["held", "pending"] as const)(
    "blocks a quarantined %s security before model mutation",
    async (kind) => {
      const f = await fixture({ [kind]: true });
      const lines = csv(currentDate).trimEnd().split("\n");
      const cells = lines[3]!.split(",");
      cells[3] = cells[4] = cells[5] = cells[6] = "";
      lines[3] = cells.join(",");
      const unsafeCsv = `${lines.join("\n")}\n`;
      f.files.set(f.ingest.storage_path, unsafeCsv);
      f.ingest.data_hash = bytesHash(unsafeCsv);
      await expect(runUsScreening(f.client, uid)).rejects.toThrow(
        "held/pending security lacks current prices: NEW",
      );
      expect(f.writes).toEqual([]);
    },
  );
  it("continues with an explicit non-held DBRG quarantine while reporting incomplete source coverage", async () => {
    const f = await fixture();
    const safeCsv = csv(currentDate) + `${currentDate},DBRG,DBRG,,,,,,,,,,,,,,false,false,true\n`;
    f.files.set(f.ingest.storage_path, safeCsv);
    f.ingest.data_hash = bytesHash(safeCsv);
    f.ingest.row_count = f.ingest.symbol_count = 4;
    Object.assign(f.ingest.metadata, {
      sourceCoverageComplete: false,
      providerGapSymbols: ["DBRG"],
    });
    await runUsScreening(f.client, uid);
    const result = JSON.parse(f.files.get(`${uid}/results/us-screening/${currentDate}.json`)!);
    expect(result.source.metadata.sourceCoverageComplete).toBe(false);
    expect(result.analysis.rows.find((r: any) => r.symbol === "DBRG").a0Entry).toBe(false);
  });
  it("leaves the normal completed-ATOMIC predecessor and same-day idempotent flow unchanged", async () => {
    const f = await fixture();
    const saved = JSON.parse(f.files.get(`${f.prefix}/plan.json`)!);
    const rank = JSON.parse(f.files.get(`${uid}/results/us-replay-state/${recoveredDate}.json`)!);
    f.files.set(
      `${uid}/results/us-screening/${recoveredDate}.json`,
      JSON.stringify({ dataHash: rank.dataHash, analysis: saved.shadow.analyses[0] }),
    );
    f.tables["us_screening_history"].push({
      date: recoveredDate,
      data_hash: rank.dataHash,
      rule_version: US_PROSPECTIVE_RULE_VERSION,
    });
    f.files.delete(`${uid}/results/us-replay-state/${recoveredDate}.json`);
    for (const suffix of ["plan.json", "manifest.json", "receipt.json"])
      f.files.delete(`${f.prefix}/${suffix}`);
    await runUsScreening(f.client, uid);
    expect(f.tables["us_screening_history"].map((r) => r.date)).toEqual([
      baseDate,
      recoveredDate,
      currentDate,
    ]);
    expect(f.reads.some((p) => p.includes("/us-gap-replay/"))).toBe(false);
    const tables = structuredClone(f.tables),
      sessions = structuredClone([...f.sessions]);
    f.writes.length = 0;
    await runUsScreening(f.client, uid);
    expect(f.tables).toEqual(tables);
    expect([...f.sessions]).toEqual(sessions);
    expect(f.writes).toEqual([`${uid}/cache/us-screening/latest.json`]);
  });
  it.each([
    "plan upload",
    "manifest upload",
    "shadow prepare",
    "shadow US_A0",
    "shadow US_A2",
    "shadow US_B3",
    "RPC before",
    "RPC after",
    "receipt upload",
    "result upload",
    "history before",
    "history after",
    "cache upload",
    "browser publish",
  ])(
    "resumes the exact same Oct9 plan after %s without duplicate model/history writes",
    async (point) => {
      const f = await fixture();
      const original = f.files.get(`${uid}/results/us-screening/${baseDate}.json`);
      const previousSnapshots = structuredClone(f.tables["us_portfolio_snapshots"]);
      const previousShadow = structuredClone([...f.sessions]);
      if (point === "browser publish")
        mock.publish.mockRejectedValueOnce(new Error("Injected browser publish"));
      else f.failOnce(point);
      await expect(runUsScreening(f.client, uid)).rejects.toThrow();
      await runUsScreening(f.client, uid);
      expect(f.tables["us_screening_history"].map((r) => r.date)).toEqual([baseDate, currentDate]);
      expect(f.tables["us_portfolio_snapshots"].filter((r) => r.date === currentDate)).toHaveLength(
        4,
      );
      expect([...f.sessions.values()].filter((r) => r.receipt.date === currentDate)).toHaveLength(
        3,
      );
      expect(f.tables["us_portfolio_snapshots"].filter((r) => r.date < currentDate)).toEqual(
        previousSnapshots,
      );
      for (const [k, v] of previousShadow) expect(f.sessions.get(k)).toEqual(v);
      const trades = f.tables["us_portfolio_trades"].map((t) => t.trade_key);
      expect(new Set(trades).size).toBe(trades.length);
      expect(f.files.get(`${uid}/results/us-screening/${baseDate}.json`)).toBe(original);
      const before = structuredClone(f.tables),
        beforeShadow = structuredClone([...f.sessions]);
      await runUsScreening(f.client, uid);
      expect(f.tables).toEqual(before);
      expect([...f.sessions]).toEqual(beforeShadow);
    },
  );
  it("does not resume an interrupted target with changed input or a forged plan", async () => {
    const f = await fixture();
    f.failOnce("shadow US_A0");
    await expect(runUsScreening(f.client, uid)).rejects.toThrow();
    f.writes.length = 0;
    const hash = f.ingest.data_hash;
    f.ingest.metadata.previousSessionDate = baseDate;
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("input/plan conflict");
    expect(f.writes).toEqual([]);
    f.ingest.metadata.previousSessionDate = recoveredDate;
    f.ingest.data_hash = hash;
    f.edit(`${uid}/results/us-continuation/${currentDate}.plan.json`, (p) => {
      p.operating.snapshots[0].cash_usd += 1;
    });
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("input/plan conflict");
    expect(f.writes).toEqual([]);
  });
  it("blocks a missing executed Oct8 model trade even when all seven snapshots and the receipt remain intact", async () => {
    const f = await fixture({ filled: true });
    const fills = f.tables["us_portfolio_trades"].filter((r) =>
      ["EXECUTED", "PARTIAL"].includes(r.status),
    );
    expect(fills.length).toBeGreaterThan(0);
    f.tables["us_portfolio_trades"] = f.tables["us_portfolio_trades"].filter(
      (r) => !fills.includes(r),
    );
    await expect(runUsScreening(f.client, uid)).rejects.toThrow(
      "committed operating ledger differs",
    );
    expect(f.writes).toEqual([]);
  });
  it("blocks a conflicting target receipt and a newer cache before any model retry", async () => {
    const f = await fixture();
    f.failOnce("RPC before");
    await expect(runUsScreening(f.client, uid)).rejects.toThrow();
    f.writes.length = 0;
    f.files.set(
      `${uid}/results/us-continuation/${currentDate}.receipt.json`,
      JSON.stringify({ applied: true }),
    );
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("receipt conflict");
    expect(f.writes).toEqual([]);
    f.files.delete(`${uid}/results/us-continuation/${currentDate}.receipt.json`);
    f.files.set(
      `${uid}/cache/us-screening/latest.json`,
      JSON.stringify({ analysis: { date: "2026-10-12" } }),
    );
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("newer latest cache");
    expect(f.writes).toEqual([]);
  });
  it("resumes a real pending fill once, using A0 0.15% and unchanged A2/B3 0.25% costs", async () => {
    const f = await fixture({ pending: true });
    f.failOnce("RPC after");
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("Injected RPC after");
    await runUsScreening(f.client, uid);
    const fills = f.tables["us_portfolio_trades"].filter(
      (r) => r.execution_date === currentDate && ["EXECUTED", "PARTIAL"].includes(r.status),
    );
    expect(fills).toHaveLength(3);
    for (const fill of fills)
      expect(fill.fee_usd).toBeCloseTo(
        fill.model_notional * (fill.strategy_id === "A0_QUARTER_PRIMARY" ? 0.0015 : 0.0025),
        8,
      );
    expect(new Set(f.tables["us_portfolio_trades"].map((r) => r.trade_key)).size).toBe(
      f.tables["us_portfolio_trades"].length,
    );
  });
  it("does not admit a newer ingest merely because a different hash-valid continuation plan exists", async () => {
    const f = await fixture();
    f.setOnUpload((path) => {
      if (!path.endsWith(`${currentDate}.manifest.json`)) return;
      const newer = "2026-10-12";
      const plan = JSON.parse(
        f.files.get(`${uid}/results/us-continuation/${currentDate}.plan.json`)!,
      );
      f.ingest.as_of_date = newer;
      plan.input.as_of_date = newer;
      plan.operating.throughDate = newer;
      plan.shadow.analyses[0].date = newer;
      const { planHash: ignored, ...payload } = plan;
      plan.planHash = bytesHash(stableJson(payload));
      f.files.set(`${uid}/results/us-continuation/${newer}.plan.json`, JSON.stringify(plan));
    });
    await expect(runUsScreening(f.client, uid)).rejects.toThrow("ingest changed during admission");
    expect(f.writes).toEqual([
      `${uid}/results/us-continuation/${currentDate}.plan.json`,
      `${uid}/results/us-screening/${currentDate}.manifest.json`,
    ]);
  });
  it.each(["2027-10-10T00:00:00Z", "invalid", "2026-10-09T19:00:00Z"])(
    "rejects invalid or unconfirmed source capture %s before any mutation",
    async (capture) => {
      const f = await fixture();
      f.ingest.collected_at = capture;
      await expect(runUsScreening(f.client, uid)).rejects.toThrow("valid post-close source");
      expect(f.writes).toEqual([]);
    },
  );
});
