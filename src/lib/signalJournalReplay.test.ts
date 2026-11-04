import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import type { ScreeningSnapshot } from "./screeningSnapshot";
const mock = vi.hoisted(() => ({
  rules: vi.fn(),
  existing: vi.fn(),
  record: vi.fn(),
  coverage: vi.fn(),
  dates: vi.fn(),
  analyze: vi.fn(),
  slice: vi.fn(),
  usAnalyze: vi.fn(),
}));
vi.mock("./signalJournal.server", () => ({
  completedSignalKeys: async () => new Set(),
  signalRules: mock.rules,
  existingSignal: mock.existing,
  recordSignal: mock.record,
  saveSignalCoverage: mock.coverage,
  signalSessionCalendar: mock.dates,
}));
vi.mock("./currentScreening", () => ({ runCurrentScreening: mock.analyze }));
vi.mock("./shadowReplayCalculation", () => ({ sliceKrDatasetForReplay: mock.slice }));
vi.mock("./screeningPublicationAnalysis", () => ({
  screeningPublicationAnalysis: (v: unknown) => v,
}));
vi.mock("./etfReportScore", () => ({ appendEtfReportEvidence: (v: unknown) => v }));
vi.mock("./operationalUnderlyingIndex.server", () => ({
  loadOperationalIndex: async () => undefined,
}));
vi.mock("./screeningSnapshot", () => ({ buildSnapshot: (v: unknown) => v }));
vi.mock("./engine/usProspective", () => ({
  US_PROSPECTIVE_RULE_VERSION: "v1",
  runUsProspectiveAnalysis: mock.usAnalyze,
}));
import { publishKrSignalJournal } from "./krSignalJournal.server";
import { publishUsSignalJournal } from "./usSignalJournal.server";
const client = {} as SupabaseClient;
const config = { ...DEFAULT_SCORING_CONFIG };
beforeEach(() => {
  vi.resetAllMocks();
  mock.rules.mockResolvedValue({
    rules: [
      {
        id: "old",
        codeHash: "code",
        strategyVersion: "v1",
        config,
        effectiveFrom: "2026-11-04",
        registeredAt: "2026-11-04T00:00:00Z",
      },
    ],
    currentCodeHash: "code",
    currentRuleId: "old",
  });
  mock.existing.mockResolvedValue(null);
  mock.record.mockImplementation(async (_c, _o, _m, s) => s);
  mock.dates.mockResolvedValue(["2026-11-04", "2026-11-05", "2026-11-06"]);
  mock.slice.mockImplementation((_ds, date) => ({ asOfDate: date }));
  mock.analyze.mockImplementation((ds) => ({
    analysis: { asOfDate: ds.asOfDate, date: ds.asOfDate, entries: [] },
    dataset: ds,
  }));
});
it("fills a skipped KR date from its dated slice and records a later missing date as pending, without performance calculation", async () => {
  const dataset = {
    asOfDate: "2026-11-05",
    tradeDates: ["2026-11-04", "2026-11-05"],
  } as MarketDataset;
  const snapshot = {
    asOfDate: "2026-11-05",
    strategyVersion: "v1",
    entries: [],
  } as unknown as ScreeningSnapshot;
  const result = await publishKrSignalJournal(client, "owner", {
    dataset,
    config,
    snapshot,
    sourceHash: "source",
  });
  expect(mock.slice).toHaveBeenCalledExactlyOnceWith(dataset, "2026-11-04");
  expect(mock.record.mock.calls.map((c) => [c[3].asOfDate, c[6]])).toEqual([
    ["2026-11-04", "RECONSTRUCTED"],
    ["2026-11-05", "OBSERVED"],
  ]);
  expect(result.pending).toEqual([{ date: "2026-11-06", reason: "해당 거래일 자료 없음" }]);
});
it("reconstructs an old configuration instead of attaching it to a result calculated with newer settings", async () => {
  mock.rules.mockResolvedValue({
    rules: [
      {
        id: "old",
        codeHash: "code",
        strategyVersion: "v1",
        config,
        effectiveFrom: "2026-11-04",
        registeredAt: "2026-11-04T00:00:00Z",
      },
    ],
    currentCodeHash: "code",
    currentRuleId: "new",
  });
  mock.dates.mockResolvedValue(["2026-11-04"]);
  const dataset = { asOfDate: "2026-11-04", tradeDates: ["2026-11-04"] } as MarketDataset;
  await publishKrSignalJournal(client, "owner", {
    dataset,
    config,
    snapshot: { asOfDate: "2026-11-04", strategyVersion: "v1" } as ScreeningSnapshot,
    sourceHash: "s",
  });
  expect(mock.analyze.mock.calls[0]?.[1]).toEqual(config);
  expect(mock.record.mock.calls[0]?.[6]).toBe("RECONSTRUCTED");
});
it("never uses current executable rules for an old missing version", async () => {
  mock.rules.mockResolvedValue({
    rules: [
      {
        id: "old",
        codeHash: "retired",
        strategyVersion: "v1",
        config,
        effectiveFrom: "2026-11-04",
        registeredAt: "2026-11-04T00:00:00Z",
      },
    ],
    currentCodeHash: "new",
  });
  const result = await publishKrSignalJournal(client, "owner", {
    dataset: { tradeDates: ["2026-11-04"] } as MarketDataset,
    config,
    snapshot: { asOfDate: "2026-11-04" } as ScreeningSnapshot,
    sourceHash: "s",
  });
  expect(result.pending).toHaveLength(3);
  expect(mock.analyze).not.toHaveBeenCalled();
  expect(mock.record).not.toHaveBeenCalled();
});
it("US missing predecessor is pending, never a fabricated empty signal or reset streak", async () => {
  const sourceClient = {
    storage: {
      from: () => ({
        download: async () => ({ data: null, error: { message: "Object not found" } }),
      }),
    },
  } as unknown as SupabaseClient;
  const result = await publishUsSignalJournal(sourceClient, "owner", {
    rows: [{ date: "2026-11-05", symbol: "TEST" }] as never,
    throughDate: "2026-11-05",
    sourceHash: "s",
    collectedAt: "2026-11-06T01:00:00Z",
  });
  expect(result.pending).toHaveLength(3);
  expect(result.pending.find((p) => p.date === "2026-11-05")?.reason).toContain("직전 거래일");
  expect(mock.usAnalyze).not.toHaveBeenCalled();
  expect(mock.record).not.toHaveBeenCalled();
});

it("an invalid historical source stays pending without preventing the current screen signal", async () => {
  mock.analyze.mockImplementationOnce(() => {
    throw new Error("historical provider mismatch");
  });
  const result = await publishKrSignalJournal(client, "owner", {
    dataset: { asOfDate: "2026-11-05", tradeDates: ["2026-11-04", "2026-11-05"] } as MarketDataset,
    config,
    snapshot: { asOfDate: "2026-11-05", strategyVersion: "v1" } as ScreeningSnapshot,
    sourceHash: "s",
  });
  expect(result.pending.find((p) => p.date === "2026-11-04")?.reason).toContain("재시도");
  expect(mock.record.mock.calls.map((c) => c[3].asOfDate)).toEqual(["2026-11-05"]);
});
