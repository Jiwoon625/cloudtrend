import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import { parseManualMarketData } from "./engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import { type ScreeningSnapshot, type SnapshotEntry } from "./screeningSnapshot";
import { krDailyInputArchive, mergeKrDailyInputs } from "./ledger/octoberShadowArchive";
import { simulateStrategy } from "./portfolioLedgers";
import { getOperationalSignals } from "./engine/operationalStrategy";
import { buildKospiShadowSession } from "./engine/kospiShadowDataset";
import * as etfShadow from "./ledger/etfAdoptedShadow";
import {
  ADOPTED_SERIES_KINDS,
  freezeRestartSeries,
  freezeAdoptedSeries,
  hashSeriesValue,
  VERIFIED_INITIAL_FX,
  type AdoptedSeriesKind,
  type FrozenModelSeries,
} from "./ledger/modelSeries";
import type { ModelJournalRun } from "./ledger/modelJournal";
import type { KrDailyInputArchive } from "./ledger/octoberShadowArchive";
import type { OctoberShadowStore } from "./ledger/octoberShadowRepository.server";
import * as publication from "./ledger/octoberShadowPipeline";
import { replayKrShadow, sliceKrDatasetForReplay } from "./shadowReplay.server";
import {
  ADOPTED_SHADOW_FROZEN_CODE_HASH,
  LINT_EQUIVALENT_SYNTAX_RUNTIME_HASH,
} from "./ledger/octoberShadowRuntime";
import manifest from "./ledger/octoberShadowEngineManifest.generated.json";

const persistence = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock("./ledger/octoberShadowRepository.server", () => ({
  octoberShadowStore: persistence.store,
}));
afterEach(() => vi.restoreAllMocks());

function replayDataset(
  missingSymbols = ["000002"],
  missingDate = "2026-10-14",
  sessions = ["2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14"],
): MarketDataset {
  const warmup: string[] = [];
  for (let at = Date.parse("2026-10-02T00:00:00Z"); warmup.length < 130; at -= 86_400_000) {
    const day = new Date(at);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      warmup.unshift(day.toISOString().slice(0, 10));
  }
  const dates = [...warmup, ...sessions];
  const instruments = [
    { symbol: "000001", name: "Synthetic KOSPI", market: "KOSPI", type: "STOCK" },
    { symbol: "000002", name: "Synthetic KOSDAQ", market: "KOSDAQ", type: "STOCK" },
    { symbol: "069500", name: "Synthetic ETF", market: "ETF", type: "ETF" },
    { symbol: "KOSPI", name: "Synthetic index", market: "INDEX", type: "INDEX" },
  ];
  return parseManualMarketData(
    JSON.stringify(
      dates.flatMap((date) =>
        instruments.map((instrument) => ({
          ...instrument,
          date,
          open: 100,
          high: 101,
          low: 99,
          close: missingSymbols.includes(instrument.symbol) && date === missingDate ? 0 : 100,
          volume: 100_000,
          tradingValue: 10_000_000,
          marketCap: 100_000_000_000,
          foreignNetBuyValue: 0,
          institutionNetBuyValue: 0,
          etfUnderlyingIndexClose: 100,
          etfMarketCap: 100_000_000_000,
          etfTradingValue: 10_000_000,
          priceSource: "TOSS_ADJUSTED_CANDLE",
          marketCapSource: "KRX_ETF",
          tradingValueSource: "KRX_ETF",
        })),
      ),
    ),
  ).dataset;
}

/** Only persistence is replaced; replay, snapshots, hashing and all five book engines run. */
async function replayPersistence(
  codeHash = ADOPTED_SHADOW_FROZEN_CODE_HASH as string,
  changedKind?: AdoptedSeriesKind,
  restart = true,
) {
  const registry = new Map<string, FrozenModelSeries>();
  const sessions = new Map<string, ModelJournalRun>();
  const archives = new Map<string, KrDailyInputArchive>();
  const prepared = new Map<string, publication.PreparedOctoberPublication>();
  const writes: string[] = [];
  const store: OctoberShadowStore = {
    async readKrInput(date, hash) {
      const value = archives.get(hash);
      if (!value || value.date !== date) throw new Error("Missing test archive");
      return structuredClone(value);
    },
    async putKrInput(value) {
      const hash = await hashSeriesValue(value);
      writes.push("archive");
      archives.set(hash, structuredClone(value));
      return { date: value.date, hash };
    },
    async readPrepared(market, date) {
      return prepared.get(`${market}:${date}`) ?? null;
    },
    async prepare(value) {
      writes.push("prepare");
      prepared.set(`${value.market}:${value.date}`, structuredClone(value));
      return value;
    },
    async readSeries(id) {
      return registry.get(id) ?? null;
    },
    async insertSeries(series) {
      registry.set(series.bookId, series);
    },
    async readLatest<T extends ModelJournalRun>(id: string) {
      return (
        ([...sessions.values()]
          .filter((run) => run.bookId === id)
          .sort((a, b) => b.receipt.date.localeCompare(a.receipt.date))[0] as T | undefined) ?? null
      );
    },
    async readSession<T extends ModelJournalRun>(id: string, date: string) {
      return (sessions.get(`${id}:${date}`) as T | undefined) ?? null;
    },
    async append(series, run, previous) {
      const latest = await store.readLatest(series.bookId);
      expect(run.previousStateHash).toBe(previous?.stateHash ?? null);
      expect(latest?.stateHash ?? null).toBe(previous?.stateHash ?? null);
      const { stateHash, ...body } = run;
      expect(await hashSeriesValue(body)).toBe(stateHash);
      writes.push("append");
      sessions.set(`${series.bookId}:${run.receipt.date}`, structuredClone(run));
      return { reused: false, stateHash };
    },
  };
  for (const kind of ADOPTED_SERIES_KINDS)
    await store.insertSeries(
      await (restart ? freezeRestartSeries : freezeAdoptedSeries)({
        kind,
        frozenAt: restart ? "2026-10-09T00:00:00Z" : "2026-10-03T00:00:00Z",
        codeHash: !changedKind || kind === changedKind ? codeHash : ADOPTED_SHADOW_FROZEN_CODE_HASH,
        sourceHash: `sha256:${"b".repeat(64)}`,
        ...(kind.startsWith("US_") ? { initialFx: VERIFIED_INITIAL_FX } : {}),
      }),
    );
  persistence.store.mockReturnValue(store);
  const audits: Array<Record<string, unknown>> = [];
  const artifacts = new Map<string, string>();
  const client = {
    storage: {
      from: () => ({
        async upload(path: string, body: string) {
          artifacts.set(path, body);
          return { error: null };
        },
        async download(path: string) {
          return artifacts.has(path)
            ? { data: new Blob([artifacts.get(path)!]), error: null }
            : { data: null, error: { message: "Object not found" } };
        },
      }),
    },
    from(table: string) {
      expect(table).toBe("shadow_replay_audit");
      return {
        async insert(row: Record<string, unknown>) {
          audits.push(row);
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { store, client, sessions, archives, prepared, writes, audits, artifacts, registry };
}

const days = ["2026-10-12", "2026-10-13", "2026-10-14"];
const owner = "11111111-1111-4111-8111-111111111111";
function signalSnapshot(date: string, onset: boolean): ScreeningSnapshot {
  const entry: SnapshotEntry = {
    symbol: "000002",
    name: "Synthetic KOSDAQ",
    instrumentType: "STOCK",
    sectorCode: "S",
    sectorName: "S",
    grade: "A",
    status: "",
    totalScore: 80,
    scoreDelta1d: 0,
    technicalPoints: 8,
    priorityPoints: 5,
    hardFilterPassed: true,
    ...getOperationalSignals("KOSDAQ", 7, 8, true, date),
  };
  return {
    date,
    asOfDate: date,
    savedAt: `${date}T23:10:00Z`,
    entries: onset ? [entry] : [],
    marketGateStatus: "NEUTRAL",
    totalCount: onset ? 1 : 0,
    passedCount: onset ? 1 : 0,
    gradeACount: onset ? 1 : 0,
    gradeBCount: 0,
  };
}
function runCommon(raw: MarketDataset, dates = days) {
  const archives = dates.map((date, index) =>
    krDailyInputArchive(
      sliceKrDatasetForReplay(raw, date),
      signalSnapshot(date, index === 0),
      `${date}T23:10:00Z`,
    ),
  );
  const inputs = mergeKrDailyInputs(archives);
  return simulateStrategy(
    { initialCapital: 30_000, maxPositions: 30, sectorCap: 0.3, roundTripCostRate: 0.003 },
    inputs.snapshots,
    inputs.bars,
    inputs.markets,
    "",
    dates,
    {},
    {
      version: "kr-common-execution-20261012-v1",
      startDate: "2026-10-12",
      throughDate: dates.at(-1)!,
      scope: "KOSDAQ",
    },
  );
}

// All data is synthetic and every persistence operation stays in memory.
// The real parser, scorer, publication validator and five book engines run unchanged.
describe("restart replay observation universe", () => {
  it("retains observed missing closes independently from scored bars and removes future observations", () => {
    const raw = replayDataset();
    const before = structuredClone(raw);
    const sliced = sliceKrDatasetForReplay(raw, days[2]!);
    expect(sliced.instruments.some((i) => i.symbol === "000002")).toBe(true);
    expect(sliced.observedBars!["000002"]!.at(-1)).toMatchObject({
      tradeDate: days[2],
      open: 100,
      close: 0,
      volume: 100_000,
      openObserved: true,
      volumeObserved: true,
    });
    expect(sliced.bars["000002"]!.at(-1)!.tradeDate).toBe(days[1]);
    const earlier = sliceKrDatasetForReplay(raw, days[1]!);
    expect(
      Object.values(earlier.observedBars!)
        .flat()
        .every((bar) => bar.tradeDate <= days[1]!),
    ).toBe(true);
    expect(raw).toEqual(before);
  });

  it("fills a pending entry from its observed open while leaving authoritative NAV missing", () => {
    const result = runCommon(replayDataset(["000002"], days[1]!), days.slice(0, 2));
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryDate: days[1],
      entryPrice: 100,
      shares: 9,
      status: "OPEN",
      currentPrice: null,
      holdingDays: 1,
    });
    expect(result.modelAccounting).toMatchObject({
      cash: "29098.65",
      nav: null,
      valuationStatus: "MISSING",
    });
  });

  it("retains a held observation without false liquidation or extra fee", () => {
    const result = runCommon(replayDataset());
    expect(result.trades[0]).toMatchObject({ status: "OPEN", currentPrice: null, holdingDays: 2 });
    expect(result.modelAccounting).toMatchObject({
      cash: "29098.65",
      nav: null,
      valuationStatus: "MISSING",
    });
    expect(result.trades[0]!.exitReason).toBeNull();
  });

  it.each(["absent", "zero-volume"] as const)(
    "preserves the actual %s model-liquidation contract",
    (condition) => {
      const raw = replayDataset();
      if (condition === "absent")
        raw.observedBars!["000002"] = raw.observedBars!["000002"]!.filter(
          (bar) => bar.tradeDate !== days[2],
        );
      else raw.observedBars!["000002"]!.at(-1)!.volume = 0;
      const result = runCommon(raw);
      expect(result.trades[0]).toMatchObject({
        status: "CLOSED",
        exitDate: days[2],
        exitPrice: 100,
      });
      expect(result.modelAccounting).toMatchObject({
        cash: "29997.3",
        nav: "29997.3",
        valuationStatus: "COMPLETE",
      });
    },
  );

  it("counts a missing-close H60 observation and carries maturity to the next observed open", () => {
    const dates = Array.from({ length: 62 }, (_, i) =>
      new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10),
    );
    const raw = replayDataset([]);
    const example = raw.observedBars!["000002"]![0]!;
    const bars = dates.map((date, i) => ({
      ...example,
      tradeDate: date,
      open: 100,
      close: i >= 60 ? 0 : 100,
      volume: 100_000,
    }));
    raw.bars["000002"] = bars.filter((bar) => bar.close > 0);
    raw.observedBars!["000002"] = bars;
    raw.tradeDates = dates;
    raw.asOfDate = dates.at(-1)!;
    const maturity = runCommon(raw, dates.slice(0, 61));
    expect(maturity.trades[0]).toMatchObject({ status: "OPEN", holdingDays: 60 });
    expect(maturity.modelAccounting).toMatchObject({ nav: null, valuationStatus: "MISSING" });
    const carried = runCommon(raw, dates);
    expect(carried.trades[0]).toMatchObject({
      status: "CLOSED",
      exitDate: dates[61],
      exitReason: "60거래일 만기",
      holdingDays: 61,
    });
  });

  it.each(["000001", "000002", "069500"])(
    "publishes 15 sessions retaining %s observation without creating stale scores",
    async (symbol) => {
      const f = await replayPersistence();
      const raw = replayDataset([symbol]);
      const publicationSpy = vi.spyOn(publication, "recordOctoberPublication");
      const etfSpy = vi.spyOn(etfShadow, "stepAdoptedEtfSeries");
      const result = await replayKrShadow({
        client: f.client,
        userId: owner,
        dataset: raw,
        config: DEFAULT_SCORING_CONFIG,
        sources: [],
        calculatedAt: "2026-10-14T23:20:00Z",
      });
      expect(result.deferred).toBeNull();
      expect(result.processed.map((d) => d.date)).toEqual(days);
      expect(result.processed.every((d) => d.records.length === 5)).toBe(true);
      expect(f.sessions.size).toBe(15);
      expect(f.audits.at(-1)?.["status"]).toBe("RECORDED");
      const input = publicationSpy.mock.calls.at(-1)![1];
      if (input.market !== "KR") throw new Error("Expected KR publication");
      expect(input.dataset.instruments.some((i) => i.symbol === symbol)).toBe(true);
      expect(input.dataset.bars[symbol]!.at(-1)!.tradeDate).toBe(days[1]);
      expect(input.analysis.rows.some((row) => row.instrument.symbol === symbol)).toBe(false);
      expect(input.snapshot.entries.some((row) => row.symbol === symbol)).toBe(false);
      expect(input.analysis.rows.every((row) => row.snapshot.tradeDate === days[2])).toBe(true);
      if (symbol !== "069500") {
        const archive = [...f.archives.values()].find((value) => value.date === days[2])!;
        expect(archive.inputs.bars[symbol]).toEqual([raw.observedBars![symbol]!.at(-1)]);
      }
      if (symbol === "000001") {
        const session = buildKospiShadowSession(
          input.dataset,
          input.config,
          {
            sourceHash: input.sourceHash,
            configHash: "test",
            codeVersion: input.codeHash,
            sourceCollectedAt: input.availableAt,
            now: input.decisionAt,
          },
          days[2],
          input.analysis,
        );
        expect(session.rows.find((row) => row.symbol === symbol)).toMatchObject({
          open: 100,
          close: 0,
          volume: 100_000,
          priceObserved: true,
          score: null,
          priority: null,
          onsetEligible: false,
        });
      }
      if (symbol === "069500") {
        const etfInput = etfSpy.mock.calls.at(-1)![1];
        expect(etfInput.prices.find((row) => row.symbol === symbol)).toMatchObject({
          open: { price: "100", volume: 100_000 },
          close: { price: null },
        });
        expect(etfInput.closeSignals.some((row) => row.symbol === symbol)).toBe(false);
      }
    },
  );

  it("executes the published ETF observation at its valid open and preserves a held missing-close day", async () => {
    const f = await replayPersistence();
    const spy = vi.spyOn(etfShadow, "stepAdoptedEtfSeries");
    await replayKrShadow({
      client: f.client,
      userId: owner,
      dataset: replayDataset(["069500"]),
      config: DEFAULT_SCORING_CONFIG,
      sources: [],
      calculatedAt: "2026-10-14T23:20:00Z",
    });
    const [series, input, previous] = spy.mock.calls.at(-1)!;
    const state = structuredClone(previous!.result.state);
    state.pendingEntries = [
      {
        symbol: "069500",
        originDate: days[0]!,
        confirmationDate: days[1]!,
        availableAt: state.lastCloseAt!,
        sourceHash: input.sourceHash,
        entryWeight: "0.05",
        averageTradingValue20: 1_000_000_000,
      },
    ];
    const filled = await etfShadow.stepEtfAdoptedShadow(series, state, input);
    const fullClose = structuredClone(input);
    fullClose.prices[0]!.close!.price = "100";
    const control = await etfShadow.stepEtfAdoptedShadow(series, state, fullClose);
    expect(filled.record.fills).toEqual(control.record.fills);
    expect(filled.state.cash).toBe(control.state.cash);
    expect(filled.record.fills).toHaveLength(1);
    expect(filled.record.fills[0]).toMatchObject({
      symbol: "069500",
      side: "BUY",
      executionDate: days[2],
      price: "100",
    });
    expect(filled.state.valuation).toMatchObject({ nav: null, status: "MISSING" });
    const next = structuredClone(input);
    next.sessionDate = "2026-10-15";
    next.previousSessionDate = days[2]!;
    next.openAt = "2026-10-15T00:00:00Z";
    next.closeAt = "2026-10-16T08:10:00+09:00";
    next.closeSignals = [];
    next.calendar.coverageEnd = next.sessionDate;
    next.calendar.regularSessions.push(next.sessionDate);
    for (const row of next.prices) {
      row.open!.asOfDate = next.sessionDate;
      row.open!.availableAt = next.openAt;
      row.close!.asOfDate = next.sessionDate;
      row.close!.availableAt = next.closeAt;
    }
    next.prices.push({ ...structuredClone(next.prices[0]!), symbol: "069501" });
    const held = await etfShadow.stepEtfAdoptedShadow(series, filled.state, next);
    expect(held.record.fills).toEqual([]);
    expect(held.state.positions).toHaveLength(1);
    expect(held.state.cash).toBe(filled.state.cash);
    expect(held.state.valuation).toMatchObject({ nav: null, status: "MISSING" });
    for (const mode of ["absent", "zero-volume"]) {
      const missing = structuredClone(next);
      if (mode === "absent") missing.prices.shift();
      else missing.prices[0]!.open!.volume = 0;
      const liquidated = await etfShadow.stepEtfAdoptedShadow(series, filled.state, missing);
      expect(liquidated.state.positions).toEqual([]);
      expect(liquidated.record.fills[0]).toMatchObject({
        symbol: "069500",
        side: "SELL",
        reason: "MODEL_UNOBSERVED",
        priceAsOfDate: days[2],
      });
    }
  });

  it.each([false, true])(
    "keeps a market-wide KRX batch pending with missing-close observations (all=%s)",
    async (allMissing) => {
      const f = await replayPersistence();
      const raw = replayDataset([]);
      const etf = raw.instruments.find((instrument) => instrument.symbol === "069500")!;
      const etfBars = structuredClone(raw.observedBars!["069500"]!);
      for (let i = 0; i < 10; i++) {
        const symbol = i === 0 ? "069500" : String(69500 + i).padStart(6, "0");
        if (i > 0) raw.instruments.push({ ...etf, id: symbol, symbol });
        const observations = structuredClone(etfBars);
        const current = observations.at(-1)!;
        current.etfMarketCap = null;
        current.etfTradingValue = null;
        current.etfUnderlyingIndexClose = null;
        if (allMissing || i === 0) current.close = 0;
        raw.observedBars![symbol] = observations;
        raw.bars[symbol] = observations.filter((bar) => bar.close > 0);
      }
      const result = await replayKrShadow({
        client: f.client,
        userId: owner,
        dataset: raw,
        config: DEFAULT_SCORING_CONFIG,
        sources: [],
        calculatedAt: "2026-10-14T23:20:00Z",
      });
      expect(result.deferred?.date, result.deferred?.reason).toBe(days[2]);
      expect(result.processed.map((day) => day.date)).toEqual(days.slice(0, 2));
      expect(result.deferred).toMatchObject({
        date: days[2],
        reason: "ETF completed close/strategy data is still pending",
      });
      expect(f.sessions.size).toBe(10);
      expect(f.audits.at(-1)?.["status"]).toBe("WAITING_INPUT");
    },
  );

  it("keeps future model-decision admission blocked before any publication or archive writes", async () => {
    const f = await replayPersistence();
    const result = await replayKrShadow({
      client: f.client,
      userId: owner,
      dataset: replayDataset(),
      config: DEFAULT_SCORING_CONFIG,
      sources: [],
      calculatedAt: "2026-10-12T22:59:59Z",
    });
    expect(result.processed).toEqual([]);
    expect(result.deferred?.date).toBe(days[0]);
    expect(f.writes).toEqual([]);
    expect(f.audits.at(-1)?.["status"]).toBe("WAITING_INPUT");
  });

  it("leaves beta missing-close selection unchanged", () => {
    const raw = replayDataset(["000002"], "2026-10-08");
    const sliced = sliceKrDatasetForReplay(raw, "2026-10-08");
    expect(sliced.observedBars!["000002"]!.at(-1)!.close).toBe(0);
    expect(sliced.instruments.some((i) => i.symbol === "000002")).toBe(false);
  });
});

// Exact fixture hashes reproduced against pristine source at
// 524597bb1edcd4fd33e89de080ca91a59b96e956 before this observation-only fix.
it.each([false, true])(
  "preserves complete-input five-book contract outputs (restart=%s)",
  async (restart) => {
    // Hold provenance constant to compare calculation semantics. Other replay tests
    // exercise the actual generated runtime admission without substituting its hash.
    const runtime = manifest.codeHash;
    manifest.codeHash = LINT_EQUIVALENT_SYNTAX_RUNTIME_HASH;
    try {
      const f = await replayPersistence(ADOPTED_SHADOW_FROZEN_CODE_HASH, undefined, restart);
      const dates = restart ? ["2026-10-08", ...days] : ["2026-10-06", "2026-10-07"];
      const result = await replayKrShadow({
        client: f.client,
        userId: owner,
        dataset: replayDataset([], "", dates),
        config: DEFAULT_SCORING_CONFIG,
        sources: [],
        calculatedAt: restart ? "2026-10-14T23:20:00Z" : "2026-10-07T23:20:00Z",
      });
      expect(result.deferred).toBeNull();
      expect(f.sessions.size).toBe(restart ? 15 : 10);
      const hashes = {
        registry: await hashSeriesValue([...f.registry]),
        sessions: await hashSeriesValue([...f.sessions]),
        archives: await hashSeriesValue([...f.archives]),
      };
      expect(hashes).toEqual(
        restart
          ? {
              registry: "sha256:e7a9e50787c4737bfe4c071acac65a87935543d250b59fcceda4bbe0674009f1",
              sessions: "sha256:f6c31ebf7679f056f70380fe7941c19a8848ae4262c528bc5504bf65616c736e",
              archives: "sha256:d5369f23a3de6ce860309e0de23e561866067d16a047a7ca876e371616d4ad49",
            }
          : {
              registry: "sha256:3bffdd36b81f05757d79eff13197de667308a9e99f58009840fb8b3b6732cbee",
              sessions: "sha256:6e8f16aa0b06cbf5fb8fff96d6711209cc0315647a8a70082ee2f240cc29a70c",
              archives: "sha256:631782e955cc8b30c6d19e161474ca5a4d6dfdd48fd51429ddffb4e24c55c6fb",
            },
      );
    } finally {
      manifest.codeHash = runtime;
    }
  },
);
