import type { KrDailyInputArchive } from "./octoberShadowArchive";
import { describe, expect, it } from "vitest";
import {
  ADOPTED_SERIES_KINDS,
  freezeAdoptedSeries,
  hashSeriesValue,
  VERIFIED_INITIAL_FX,
  type FrozenModelSeries,
} from "./modelSeries";
import {
  recordOctoberPublication,
  type UsModelPublication,
  type PreparedOctoberPublication,
} from "./octoberShadowPipeline";
import type { OctoberShadowStore } from "./octoberShadowRepository.server";
import type { ModelJournalRun } from "./modelJournal";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "../engine/usProspective";
import { octoberModelCalendar, regularCloseAt } from "./octoberShadowCalendar";
import { nextKrRegularSession } from "./krShadowDecision";
const codeHash = `sha256:${"a".repeat(64)}` as const,
  sourceHash = `sha256:${"b".repeat(64)}` as const;

function source(date: string): UsModelPublication {
  const input: UsProspectiveInputRow = {
    date,
    symbol: "TEST",
    name: "Synthetic fixture",
    market: "NASDAQ",
    sector: "TECH",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: 1,
    ret252: 1,
    beta60Spy: 1,
    ichimokuTkGap: 1,
    relvol1_20: 1,
    adv20Usd: 1e9,
    amihud20: 0.001,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 1359.6,
  };
  return {
    market: "US",
    analysis: runUsProspectiveAnalysis([input]),
    codeHash,
    sourceHash,
    availableAt: `${date}T21:00:00Z`,
    decisionAt: `${date}T21:30:00Z`,
    confirmedRegularClose: true,
    failedSymbols: 0,
    previousSessionDate: date === "2026-10-05" ? "2026-10-02" : "2026-10-05",
    marketCalendarOk: true,
  };
}
async function fixture() {
  const registry = new Map<string, FrozenModelSeries>(),
    sessions = new Map<string, ModelJournalRun>();
  const prepared = new Map<string, PreparedOctoberPublication>();
  const archives = new Map<string, KrDailyInputArchive>();
  let appends = 0,
    failOn = 0;
  const store: OctoberShadowStore = {
    async readKrInput(date, hash) {
      const value = archives.get(hash);
      if (!value || value.date !== date) throw new Error("Missing archive fixture");
      return structuredClone(value);
    },
    async putKrInput(value) {
      const hash = await hashSeriesValue(value);
      archives.set(hash, structuredClone(value));
      return { date: value.date, hash };
    },
    async readPrepared(market, date) {
      return prepared.get(`${market}:${date}`) ?? null;
    },
    async prepare(value) {
      const key = `${value.market}:${value.date}`;
      if (!prepared.has(key)) prepared.set(key, structuredClone(value));
      return prepared.get(key)!;
    },
    async readSeries(id) {
      return registry.get(id) ?? null;
    },
    async insertSeries(s) {
      registry.set(s.bookId, s);
    },
    async readLatest<T extends ModelJournalRun>(id: string) {
      return (
        ([...sessions.values()]
          .filter((r) => r.bookId === id)
          .sort((a, b) => b.receipt.date.localeCompare(a.receipt.date))[0] as T | undefined) ?? null
      );
    },
    async readSession<T extends ModelJournalRun>(id: string, date: string) {
      return (sessions.get(`${id}:${date}`) as T | undefined) ?? null;
    },
    async append(series, run, previous) {
      appends++;
      if (appends === failOn) throw new Error("simulated process/storage interruption");
      const head = await store.readLatest(series.bookId);
      if ((head?.stateHash ?? null) !== (previous?.stateHash ?? null))
        throw new Error("atomic predecessor conflict");
      if (run.previousStateHash !== (previous?.stateHash ?? null))
        throw new Error("bad predecessor");
      const { stateHash, ...body } = run;
      expect(await hashSeriesValue(body)).toBe(stateHash);
      sessions.set(`${series.bookId}:${run.receipt.date}`, structuredClone(run));
      return { reused: false, stateHash: run.stateHash };
    },
  };
  for (const kind of ADOPTED_SERIES_KINDS)
    await store.insertSeries(
      await freezeAdoptedSeries({
        kind,
        frozenAt: "2026-10-03T00:00:00Z",
        codeHash,
        sourceHash,
        ...(kind.startsWith("US_") ? { initialFx: VERIFIED_INITIAL_FX } : {}),
      }),
    );
  return {
    store,
    sessions,
    archives,
    prepared,
    registry,
    appends: () => appends,
    failAt: (n: number) => {
      failOn = n;
    },
  };
}
describe("completed manual/upload publication to October journal", () => {
  it("initializes only registry cash contracts; no sessions before start", async () => {
    const f = await fixture();
    expect(f.registry.size).toBe(8);
    expect(f.sessions.size).toBe(0);
    expect((await recordOctoberPublication(f.store, source("2026-10-02"))).status).toBe(
      "WAITING_START",
    );
    expect(f.appends()).toBe(0);
  });
  it("records all US books once, exact retry and restarted next day preserve the predecessor chain", async () => {
    const f = await fixture(),
      first = source("2026-10-05");
    const a = await recordOctoberPublication(f.store, first);
    expect(a.records).toHaveLength(3);
    expect(f.sessions.size).toBe(3);
    const retry = await recordOctoberPublication(
      { ...f.store },
      { ...first, decisionAt: "2026-10-05T22:00:00Z" },
    );
    expect(retry.records.every((r) => r.reused)).toBe(true);
    expect(f.appends()).toBe(3);
    await recordOctoberPublication({ ...f.store }, source("2026-10-06"));
    expect(f.sessions.size).toBe(6);
  });
  it("recovers a partially published market without appending a second first book", async () => {
    const f = await fixture();
    f.failAt(2);
    await expect(recordOctoberPublication(f.store, source("2026-10-05"))).rejects.toThrow(
      "interruption",
    );
    expect(f.sessions.size).toBe(1);
    const result = await recordOctoberPublication(
      { ...f.store },
      { ...source("2026-10-05"), decisionAt: "2026-10-06T21:30:00Z" },
    );
    expect(result.records.map((r) => r.reused)).toEqual([true, false, false]);
    expect(f.sessions.size).toBe(3);
  });
  it.each([
    { confirmedRegularClose: false },
    { failedSymbols: 1 },
    { marketCalendarOk: false },
    { availableAt: "2026-10-05T19:00:00Z" },
    { availableAt: "2026-10-06T21:00:00Z" },
    { previousSessionDate: "2026-10-01" },
  ])("rejects incomplete or late-source evidence before any write: %o", async (patch) => {
    const f = await fixture();
    await expect(
      recordOctoberPublication(f.store, { ...source("2026-10-05"), ...patch }),
    ).rejects.toThrow();
    expect(f.appends()).toBe(0);
  });
  it("rejects missing first session, changed engine, revised same day and forged stored state", async () => {
    const f = await fixture();
    await expect(recordOctoberPublication(f.store, source("2026-10-06"))).rejects.toThrow(
      "next regular session",
    );
    await expect(
      recordOctoberPublication(f.store, {
        ...source("2026-10-05"),
        codeHash: `sha256:${"c".repeat(64)}`,
      }),
    ).rejects.toThrow("manifest");
    await recordOctoberPublication(f.store, source("2026-10-05"));
    const revised = source("2026-10-05");
    revised.analysis.rows[0]!.close = 102;
    await expect(recordOctoberPublication(f.store, revised)).rejects.toThrow("immutable");
    const first = [...f.sessions.values()][0]!;
    first.stateHash = `sha256:${"d".repeat(64)}`;
    await expect(recordOctoberPublication(f.store, source("2026-10-06"))).rejects.toThrow(
      "integrity",
    );
  });
});
describe("reviewed regular-session boundaries", () => {
  it("starts US on Oct5 and KR on Oct6, blocks Oct9 KR and missing support", async () => {
    expect((await octoberModelCalendar("US", "2026-10-05")).regularSessions).toEqual([
      "2026-10-05",
    ]);
    expect((await octoberModelCalendar("KR", "2026-10-09")).regularSessions).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
    ]);
    await expect(octoberModelCalendar("KR", "2027-01-04")).rejects.toThrow("calendar");
    expect(regularCloseAt("US", "2026-10-05")).toBe("2026-10-05T20:00:00Z");
    expect(regularCloseAt("US", "2026-11-27")).toBe("2026-11-27T18:00:00Z");
    expect(regularCloseAt("US", "2026-12-31")).toBe("2026-12-31T21:00:00Z");
  });
});

import { DEFAULT_SCORING_CONFIG } from "../engine/scoring";
import { ETF_POLICY, type EtfStrategySnapshot } from "../engine/etfStrategy";
import type { MarketDataset } from "../engine/dataset";
import type { AnalysisResult, ScreeningRow } from "../engine/pipeline";
import type { KrModelPublication } from "./octoberShadowPipeline";
function krSource(date: string): KrModelPublication {
  const bar = {
    tradeDate: date,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1e6,
    tradingValue: 1e8,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  };
  const instruments = [
    {
      symbol: "000001",
      name: "Synthetic KOSPI",
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
    {
      symbol: "000002",
      name: "Synthetic KOSDAQ",
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
    {
      symbol: "000003",
      name: "Synthetic ETF",
      market: "KOSPI",
      instrumentType: "ETF",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
  ] as MarketDataset["instruments"];
  const strategy: EtfStrategySnapshot = {
    version: ETF_POLICY.version,
    date,
    previousDate: date === "2026-10-06" ? "2026-10-02" : "2026-10-06",
    eligible: false,
    score: 50,
    previousScore: 50,
    technical: 50,
    priority: 50,
    health: 50,
    environment: 50,
    environmentSource: "stock_sector",
    region: "KR",
    sector: "TECH",
    annualVolatility: 0.2,
    entryWeight: 0.075,
    underlyingClose: 100,
    underlyingMa60: 95,
    onset: false,
    rawOnset: false,
    entryState: "none",
    originDate: null,
    confirmationDate: null,
    confirmationIssues: [],
    averageTradingValue20: 1e8,
    dataStatus: "ready",
    krxReferenceDate: date,
    exit: null,
    issues: [],
  };
  const rows = instruments.map((instrument) => ({
    instrument,
    snapshot: { tradeDate: date },
    operatingScore10: 5,
    priority: { points: 5 },
    ...(instrument.instrumentType === "ETF" ? { etfStrategy: strategy } : {}),
  })) as ScreeningRow[];
  const dataset = {
    provider: "TEST_FIXTURE",
    version: "1",
    asOfDate: date,
    isLive: true,
    capabilities: {
      marketCap: true,
      fundamentals: true,
      etfFacts: true,
      sectors: true,
      investorFlow: true,
      volatilityIndex: true,
      exactTradingValue: true,
    },
    notes: [],
    sectors: [],
    tradeDates: ["2026-10-02", "2026-10-06", ...(date > "2026-10-06" ? [date] : [])],
    kospiGateDates: ["2026-10-02", "2026-10-06", ...(date > "2026-10-06" ? [date] : [])],
    instruments,
    bars: Object.fromEntries(instruments.map((i) => [i.symbol, [bar]])),
    indexSeries: [{ indexCode: "KOSPI", bars: [bar] }],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  } as unknown as MarketDataset;
  const next = nextKrRegularSession(date);
  const availableAt = next ? `${next}T08:00:00+09:00` : `${date}T23:50:00+09:00`;
  const decisionAt = next ? `${next}T08:10:00+09:00` : `${date}T23:55:00+09:00`;
  return {
    market: "KR",
    codeHash,
    sourceHash,
    availableAt,
    decisionAt,
    confirmedRegularClose: true,
    failedSymbols: 0,
    dataset,
    config: DEFAULT_SCORING_CONFIG,
    universeEvidence: {
      asOfDate: date === "2026-10-06" ? "2026-10-02" : "2026-10-06",
      sourceHash,
      symbols: instruments.map((i) => i.symbol),
    },
    sourceEvidence: [{ sourceHash, asOfDate: date, registeredAt: availableAt }],
    analysis: { asOfDate: date, calculatedAt: decisionAt, rows } as AnalysisResult,
    snapshot: {
      date,
      asOfDate: date,
      savedAt: availableAt,
      entries: [],
      marketGateStatus: "UNKNOWN",
      totalCount: 0,
      passedCount: 0,
      gradeACount: 0,
      gradeBCount: 0,
    },
  };
}
describe("KR five-book complete publication", () => {
  it("records first Oct6 and next Oct7 from rolling uploads without importing prestart history", async () => {
    const f = await fixture();
    const first = await recordOctoberPublication(f.store, krSource("2026-10-06"));
    expect(first.records).toHaveLength(5);
    expect(f.sessions.size).toBe(5);
    const retry = await recordOctoberPublication({ ...f.store }, krSource("2026-10-06"));
    expect(retry.records.every((r) => r.reused)).toBe(true);
    await recordOctoberPublication({ ...f.store }, krSource("2026-10-07"));
    expect(f.sessions.size).toBe(10);
    expect([...f.sessions.values()].every((r) => r.receipt.date >= "2026-10-06")).toBe(true);
  });
  it("defers every book when a required ETF close is pending and rejects source/config changes", async () => {
    const f = await fixture(),
      incomplete = krSource("2026-10-06");
    incomplete.analysis.rows[2]!.etfStrategy!.dataStatus = "krx_batch_pending";
    await expect(recordOctoberPublication(f.store, incomplete)).rejects.toThrow("pending");
    expect(f.appends()).toBe(0);
    const bad = krSource("2026-10-06");
    bad.dataset.isLive = false;
    await expect(recordOctoberPublication(f.store, bad)).rejects.toThrow("synthetic");
    await expect(recordOctoberPublication(f.store, krSource("2026-10-05"))).rejects.toThrow();
    expect(f.appends()).toBe(0);
  });
});

it("persists one shared KR day archive and compact run references; missing archives fail closed", async () => {
  const f = await fixture();
  await recordOctoberPublication(f.store, krSource("2026-10-06"));
  expect(f.archives.size).toBe(1);
  const adopted = [...f.sessions.values()].filter((run) =>
    ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"].some((kind) => run.bookId.endsWith(`:${kind}`)),
  ) as import("./krAdoptedShadow").AdoptedKrRun[];
  expect(adopted).toHaveLength(3);
  for (const run of adopted) {
    expect(run.frozenInputs).toEqual({ snapshots: [], bars: {}, markets: {}, marketGates: {} });
    expect(run.frozenInputArchive?.days).toHaveLength(1);
    expect(run.frozenInputArchive?.days[0]?.hash).toBe(
      adopted[0]!.frozenInputArchive?.days[0]?.hash,
    );
  }
  const day = [...f.archives.values()][0]!;
  expect(Object.keys(day.inputs.bars)).toEqual(["000001", "000002"]);
  expect(
    Object.values(day.inputs.bars)
      .flat()
      .every((bar) => bar.tradeDate === "2026-10-06"),
  ).toBe(true);
  f.archives.clear();
  await expect(recordOctoberPublication(f.store, krSource("2026-10-07"))).rejects.toThrow(
    "archive",
  );
  expect(f.sessions.size).toBe(5);
});

it("exports synthetic application-shaped payloads only for optional local PostgreSQL verification", async () => {
  const output = process.env["CLOUDTREND_OCTOBER_APP_FIXTURES"];
  if (!output) return;
  const f = await fixture();
  await recordOctoberPublication(f.store, source("2026-10-05"));
  await recordOctoberPublication(f.store, krSource("2026-10-06"));
  const prepared = [...f.prepared.values()];
  const value = {
    series: [...f.registry.values()],
    archives: [...f.archives].map(([hash, payload]) => ({ date: payload.date, hash, payload })),
    prepared,
    preparedPayloadHashes: await Promise.all(prepared.map((payload) => hashSeriesValue(payload))),
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(output, JSON.stringify(value), { mode: 0o600 });
});
