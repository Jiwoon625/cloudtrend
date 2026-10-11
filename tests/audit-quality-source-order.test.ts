import { expect, it } from "vitest";
import { computeDatasetDataStatus } from "../src/lib/datasetDataStatus";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { sourceFingerprintRecords } from "../src/lib/sourceFingerprintRecords";
import {
  inputFingerprint,
  listActiveSources,
  type ActiveSourceRecord,
} from "../src/lib/screeningSources.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
function fixture(date = "2026-10-08") {
  const raw = getMockDataset();
  raw.asOfDate = date;
  raw.instruments = raw.instruments.filter((i) => i.instrumentType === "STOCK").slice(0, 2);
  raw.bars = Object.fromEntries(
    raw.instruments.map((i) => [
      i.symbol,
      [
        {
          ...raw.bars[i.symbol]!.at(-1)!,
          tradeDate: date,
          marketCap: null,
          foreignNetBuyValue: null,
          institutionNetBuyValue: null,
        },
      ],
    ]),
  );
  raw.observedBars = structuredClone(raw.bars);
  raw.indexSeries = [];
  return raw;
}
it("counts current partial coverage, including genuine zero flows and excluding missing/stale values", () => {
  const raw = fixture();
  const [a, b] = raw.instruments;
  raw.observedBars![a!.symbol]![0]!.marketCap = 123;
  raw.observedBars![a!.symbol]![0]!.foreignNetBuyValue = 0;
  raw.observedBars![a!.symbol]![0]!.institutionNetBuyValue = 0;
  raw.observedBars![b!.symbol]!.unshift({
    ...raw.observedBars![b!.symbol]![0]!,
    tradeDate: "2026-10-07",
    marketCap: 456,
    foreignNetBuyValue: 1,
    institutionNetBuyValue: 1,
  });
  const result = computeDatasetDataStatus(
    raw,
    DEFAULT_SCORING_CONFIG,
    new Date("2026-10-11T00:00:00Z"),
  );
  for (const kind of ["시가총액", "투자자별 순매수"])
    expect(result.coverage.find((c) => c.kind === kind)).toMatchObject({
      count: 1,
      availableEntities: 1,
      entities: 2,
      ok: false,
      asOfDate: "2026-10-08",
    });
});
it("checks future rows against the real Korean market date, separately from the file date", () => {
  const raw = fixture("2026-10-12");
  const before = computeDatasetDataStatus(
    raw,
    DEFAULT_SCORING_CONFIG,
    new Date("2026-10-11T14:59:59Z"),
  );
  const after = computeDatasetDataStatus(
    raw,
    DEFAULT_SCORING_CONFIG,
    new Date("2026-10-11T15:00:00Z"),
  );
  expect(before).toMatchObject({
    qualityDate: "2026-10-11",
    checks: { futureDates: 2, afterAsOfDates: 0 },
  });
  expect(after).toMatchObject({
    qualityDate: "2026-10-12",
    checks: { futureDates: 0, afterAsOfDates: 0 },
  });
  raw.asOfDate = "2026-10-10";
  expect(
    computeDatasetDataStatus(raw, DEFAULT_SCORING_CONFIG, new Date("2026-10-13T00:00:00Z")).checks,
  ).toMatchObject({ futureDates: 0, afterAsOfDates: 2 });
});
it("does not call a late historical upload future data or mutate the source", () => {
  const raw = fixture();
  const before = JSON.stringify(raw);
  expect(
    computeDatasetDataStatus(raw, DEFAULT_SCORING_CONFIG, new Date("2026-10-20T00:00:00Z")).checks
      .futureDates,
  ).toBe(0);
  expect(JSON.stringify(raw)).toBe(before);
  expect(() => computeDatasetDataStatus(raw, DEFAULT_SCORING_CONFIG, new Date("invalid"))).toThrow(
    "Invalid quality-check time",
  );
});
const sources = ["a", "b"].map((id) => ({
  id,
  data_hash: id,
  schema_hash: "schema",
  activated_at: "2026-10-11T00:00:00.123456Z",
  created_at: "2026-10-11T00:00:00.123457Z",
})) as ActiveSourceRecord[];
it("fingerprints exact merge order and timestamp tie-breakers rather than sorting away precedence", () => {
  expect(inputFingerprint(sources, DEFAULT_SCORING_CONFIG)).not.toBe(
    inputFingerprint([...sources].reverse(), DEFAULT_SCORING_CONFIG),
  );
  expect(sourceFingerprintRecords(sources)[0]!.createdAt).toBe("2026-10-11T00:00:00.123457Z");
  expect(inputFingerprint(sources, DEFAULT_SCORING_CONFIG)).not.toBe(
    inputFingerprint(
      [{ ...sources[0]!, created_at: "2026-10-11T00:00:00.123458Z" }, sources[1]!],
      DEFAULT_SCORING_CONFIG,
    ),
  );
});
it("requests deterministic source order including final id tie-break", async () => {
  const order: string[] = [];
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order(column: string) {
      order.push(column);
      return this;
    },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(resolve({ data: sources, error: null }));
    },
  };
  await listActiveSources({ from: () => query } as unknown as SupabaseClient, "owner");
  expect(order).toEqual(["activated_at", "created_at", "id"]);
  for (const path of ["src/lib/sourceRegistry.ts", "scripts/source-registry-store.ts"])
    expect(readFileSync(path, "utf8")).toContain('.order("id", { ascending: true })');
  for (const path of [
    "src/lib/screeningCache.ts",
    "src/lib/screeningSources.server.ts",
    "scripts/web-screening-cache-store.ts",
  ])
    expect(readFileSync(path, "utf8")).toContain("sourceFingerprintRecords(");
});

it("counts future preserved missing-close observations even when no analytical bar exists", () => {
  const raw = parseManualMarketData(
    "symbol,name,market,securityType,date,open,high,low,close,volume,tradingValue\n033340,Test,KOSDAQ,STOCK,2026-10-20,100,101,99,0,1000,100000",
    { allowIncompleteIndex: true },
  ).dataset;
  expect(raw.observedBars?.["033340"]).toHaveLength(1);
  expect(raw.bars["033340"]).toHaveLength(0);
  const result = computeDatasetDataStatus(
    raw,
    DEFAULT_SCORING_CONFIG,
    new Date("2026-10-11T00:00:00Z"),
  );
  expect(result.checks.futureDates).toBe(1);
});

it("counts raw VKOSPI dates outside indexSeries but not derived proxy dates twice", () => {
  const raw = fixture("2026-10-08");
  raw.vkospiObservations = [
    { date: "2026-10-20", value: 20, source: "VKOSPI" },
    { date: "2026-10-20", value: 20, source: "REALIZED_VOLATILITY_KOSPI" },
  ];
  expect(
    computeDatasetDataStatus(raw, DEFAULT_SCORING_CONFIG, new Date("2026-10-11T00:00:00Z")).checks,
  ).toMatchObject({ futureDates: 1, afterAsOfDates: 1 });
});
