import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import { parseManualMarketData } from "./engine/manualDataset";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import { buildSnapshot } from "./screeningSnapshot";
import {
  ADOPTED_SERIES_KINDS,
  canonicalSeriesJson,
  freezeAdoptedSeries,
  hashSeriesValue,
  type FrozenModelSeries,
} from "./ledger/modelSeries";
import type { ModelJournalRun } from "./ledger/modelJournal";
import type { KrDailyInputArchive } from "./ledger/octoberShadowArchive";
import type { OctoberShadowStore } from "./ledger/octoberShadowRepository.server";
import * as publication from "./ledger/octoberShadowPipeline";
import { replayKrShadow, shadowReplayClock, sliceKrDatasetForReplay } from "./shadowReplay.server";

const persistence = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock("./ledger/octoberShadowRepository.server", () => ({
  octoberShadowStore: persistence.store,
}));
afterEach(() => vi.restoreAllMocks());

describe("Shadow replay clock", () => {
  it("separates actual calculation time from the frozen KR signal/decision clock", () => {
    const contemporary = shadowReplayClock("KR", "2026-10-06", "2026-10-06T23:20:00Z");
    expect(contemporary).toMatchObject({
      signalDate: "2026-10-06",
      modelAvailableAt: "2026-10-07T08:00:00+09:00",
      modelDecisionAt: "2026-10-07T08:10:00+09:00",
      executionAt: "2026-10-07T00:00:00Z",
      replayMode: "CONTEMPORANEOUS",
    });

    const late = shadowReplayClock("KR", "2026-10-06", "2026-10-08T00:00:00Z");
    expect(late.modelAvailableAt).toBe(contemporary.modelAvailableAt);
    expect(late.modelDecisionAt).toBe(contemporary.modelDecisionAt);
    expect(late.executionAt).toBe(contemporary.executionAt);
    expect(late.replayMode).toBe("RETROSPECTIVE");
  });

  it("uses US market event time even when the source is uploaded days later", () => {
    const clock = shadowReplayClock("US", "2026-10-05", "2026-10-08T12:00:00Z");
    expect(clock).toMatchObject({
      signalDate: "2026-10-05",
      modelAvailableAt: "2026-10-05T20:01:00Z",
      modelDecisionAt: "2026-10-05T20:02:00Z",
      executionAt: "2026-10-06T13:30:00Z",
      replayMode: "RETROSPECTIVE",
    });
  });
});

describe("KR point-in-time dataset slicing", () => {
  it("removes future rows and symbols that did not have a row on the signal date", () => {
    const raw = {
      provider: "TEST",
      version: "multi-day",
      asOfDate: "2026-10-07",
      isLive: true,
      capabilities: {},
      notes: [],
      sectors: [],
      tradeDates: ["2026-10-06", "2026-10-07"],
      kospiGateDates: ["2026-10-06", "2026-10-07"],
      instruments: [
        {
          id: "000001",
          symbol: "000001",
          name: "A",
          market: "KOSPI",
          instrumentType: "STOCK",
          sectorCode: "S",
          sectorName: "S",
        },
        {
          id: "000002",
          symbol: "000002",
          name: "B",
          market: "KOSDAQ",
          instrumentType: "STOCK",
          sectorCode: "S",
          sectorName: "S",
        },
      ],
      bars: {
        "000001": [
          { tradeDate: "2026-10-06", open: 10, high: 10, low: 10, close: 10, volume: 1 },
          { tradeDate: "2026-10-07", open: 20, high: 20, low: 20, close: 20, volume: 1 },
        ],
        "000002": [{ tradeDate: "2026-10-07", open: 30, high: 30, low: 30, close: 30, volume: 1 }],
      },
      indexSeries: [
        {
          indexCode: "KOSPI",
          bars: [
            { tradeDate: "2026-10-06", open: 100, high: 100, low: 100, close: 100, volume: 1 },
            { tradeDate: "2026-10-07", open: 101, high: 101, low: 101, close: 101, volume: 1 },
          ],
        },
      ],
      financials: {},
      etfFacts: {},
      vkospiSeries: [],
      vkospiObservations: [
        { date: "2026-10-06", value: 20, source: "TEST" },
        { date: "2026-10-07", value: 21, source: "TEST" },
      ],
      kospiPriceInputIssues: {
        "2026-10-07": ["future"],
      },
    } as unknown as MarketDataset;

    const sliced = sliceKrDatasetForReplay(raw, "2026-10-06");
    expect(sliced.asOfDate).toBe("2026-10-06");
    expect(sliced.instruments.map((instrument) => instrument.symbol)).toEqual(["000001"]);
    expect(sliced.bars["000001"]?.map((bar) => bar.tradeDate)).toEqual(["2026-10-06"]);
    expect(sliced.bars["000002"]).toBeUndefined();
    expect(sliced.indexSeries[0]?.bars.map((bar) => bar.tradeDate)).toEqual(["2026-10-06"]);
    expect(sliced.tradeDates).toEqual(["2026-10-06"]);
    expect(sliced.kospiGateDates).toEqual(["2026-10-06"]);
    expect(sliced.vkospiObservations?.map((point) => point.date)).toEqual(["2026-10-06"]);
    expect(sliced.kospiPriceInputIssues).toEqual({});
  });
});

/** Synthetic rows enter through the same parser and engine as a completed web screening. */
function replayDataset(): MarketDataset {
  const warmup: string[] = [];
  for (let at = Date.parse("2026-10-02T00:00:00Z"); warmup.length < 130; at -= 86_400_000) {
    const day = new Date(at);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      warmup.unshift(day.toISOString().slice(0, 10));
  }
  const dates = [...warmup, "2026-10-06", "2026-10-07"];
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
          close: 100,
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
async function replayPersistence() {
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
  for (const kind of ADOPTED_SERIES_KINDS.filter((kind) => !kind.startsWith("US_")))
    await store.insertSeries(
      await freezeAdoptedSeries({
        kind,
        frozenAt: "2026-10-03T00:00:00Z",
        codeHash: `sha256:${"a".repeat(64)}`,
        sourceHash: `sha256:${"b".repeat(64)}`,
      }),
    );
  persistence.store.mockReturnValue(store);
  const audits: Array<Record<string, unknown>> = [];
  const client = {
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
  return { store, client, sessions, archives, prepared, writes, audits };
}

describe("KR replay snapshot provenance", () => {
  it("hashes real mixed-market current and prior snapshots without inventing KOSPI entries", async () => {
    const raw = replayDataset();
    for (const date of ["2026-10-02", "2026-10-06"]) {
      const { analysis } = runFullMarketAnalysis(sliceKrDatasetForReplay(raw, date));
      const snapshot = buildSnapshot(analysis);
      expect(snapshot.entries).toHaveLength(3);
      expect(snapshot.entries.find((entry) => entry.symbol === "000001")?.kospiEntry).toBeDefined();
      for (const symbol of ["000002", "069500"]) {
        const entry = snapshot.entries.find((entry) => entry.symbol === symbol)!;
        expect(Object.hasOwn(entry, "kospiEntry")).toBe(false);
      }
      // Omitting an absent optional property preserves the existing persisted JSON representation.
      expect(canonicalSeriesJson(snapshot)).toBe(
        canonicalSeriesJson(JSON.parse(JSON.stringify(snapshot))),
      );
      await expect(hashSeriesValue(snapshot)).resolves.toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("reaches real five-book publication across two sessions and hashes each previous snapshot", async () => {
    const f = await replayPersistence();
    const publish = vi.spyOn(publication, "recordOctoberPublication");
    const raw = replayDataset();
    const input = {
      client: f.client,
      userId: "11111111-1111-4111-8111-111111111111",
      dataset: raw,
      config: DEFAULT_SCORING_CONFIG,
      sources: [],
      calculatedAt: "2026-10-07T23:20:00Z",
    };
    const result = await replayKrShadow(input);
    expect(result.deferred).toBeNull();
    expect(result.processed.map((day) => day.date)).toEqual(["2026-10-06", "2026-10-07"]);
    expect(result.processed.every((day) => day.records.length === 5)).toBe(true);
    expect(f.sessions.size).toBe(10);
    expect(f.archives.size).toBe(2);
    expect(f.prepared.size).toBe(2);
    expect(f.audits.map((audit) => audit["status"])).toEqual(["RECORDED", "RECORDED"]);
    expect(publish).toHaveBeenCalledTimes(2);
    for (const [index, date] of ["2026-10-02", "2026-10-06"].entries()) {
      const { analysis } = runFullMarketAnalysis(sliceKrDatasetForReplay(raw, date));
      const previousSnapshot = {
        ...buildSnapshot(analysis),
        savedAt: shadowReplayClock("KR", date, input.calculatedAt).modelAvailableAt,
      };
      const published = publish.mock.calls[index]![1];
      expect(published.market).toBe("KR");
      if (published.market !== "KR") throw new Error("Expected KR publication");
      expect(published.universeEvidence.asOfDate).toBe(date);
      expect(published.universeEvidence.sourceHash).toBe(await hashSeriesValue(previousSnapshot));
      expect(published.snapshot.entries).toHaveLength(3);
      expect(published.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    const writesBeforeRetry = [...f.writes];
    expect((await replayKrShadow(input)).processed).toEqual([]);
    expect(f.writes).toEqual(writesBeforeRetry);
  });

  it.each([NaN, Infinity, -Infinity])(
    "still rejects nonfinite evidence (%s) before any publication or ledger write",
    async (badValue) => {
      const f = await replayPersistence();
      const publish = vi.spyOn(publication, "recordOctoberPublication");
      const raw = replayDataset();
      raw.bars["000002"]!.find((bar) => bar.tradeDate === "2026-10-06")!.marketCap = badValue;
      const result = await replayKrShadow({
        client: f.client,
        userId: "11111111-1111-4111-8111-111111111111",
        dataset: raw,
        config: DEFAULT_SCORING_CONFIG,
        sources: [],
        calculatedAt: "2026-10-07T23:20:00Z",
      });
      expect(result.deferred).toEqual({
        date: "2026-10-06",
        reason: "Series provenance must contain plain finite JSON values",
      });
      expect(publish).not.toHaveBeenCalled();
      expect(f.writes).toEqual([]);
      expect(f.sessions.size).toBe(0);
      expect(f.audits).toEqual([
        expect.objectContaining({ status: "WAITING_INPUT", source_hash: null }),
      ]);
    },
  );
});
