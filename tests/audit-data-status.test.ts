import { describe, expect, it, vi } from "vitest";
import { computeDatasetDataStatus } from "../src/lib/datasetDataStatus";
import { dataStatusStrategyVersion, dataStatusVolatility } from "../src/lib/dataStatusPresentation";
import { createDataStatusCache } from "../src/lib/dataStatusCache";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { buildFullUniverseSectorDataset } from "../src/lib/engine/sectorRotationFullUniverse";
import type { DataStatusPayload } from "../src/lib/market.functions";
import { readFileSync } from "node:fs";

describe("data quality without screening recalculation", () => {
  it("preserves pipeline identity and counts while avoiding a full analysis", () => {
    const raw = getMockDataset();
    const before = JSON.stringify(raw);
    const dataset = buildFullUniverseSectorDataset(raw);
    const t = performance.now();
    const reference = runAnalysis(dataset, DEFAULT_SCORING_CONFIG).strategyVersion;
    const oldMs = performance.now() - t;
    const start = performance.now();
    const result = computeDatasetDataStatus(raw, DEFAULT_SCORING_CONFIG);
    const newMs = performance.now() - start;
    expect(result.strategyVersion).toBe(reference);
    expect(result.coverage[0]!.count).toBe(
      Object.values(dataset.bars).reduce((n, bars) => n + bars.length, 0),
    );
    expect(result.barCoverage.length).toBe(dataset.instruments.length);
    expect(JSON.stringify(raw)).toBe(before);
    console.info(
      JSON.stringify({
        dataStatusProfile: {
          versionOnlyFullAnalysisMs: oldMs,
          completeQualitySummaryMs: newMs,
          symbols: raw.instruments.length,
        },
      }),
    );
  });
  it("matches version identity across the October boundary without invoking analysis", () => {
    for (const date of ["2026-10-09", "2026-10-12"]) {
      const raw = { ...getMockDataset(), asOfDate: date };
      expect(dataStatusStrategyVersion(date)).toBe(runAnalysis(raw).strategyVersion);
    }
    expect(
      readFileSync(new URL("../src/lib/datasetDataStatus.ts", import.meta.url), "utf8"),
    ).not.toContain("runAnalysis");
  });
  it.each([
    ["VKOSPI", "원본 VKOSPI 관측"],
    ["REALIZED_VOLATILITY_KOSPI", "실현변동성 대체 · KOSPI"],
    ["REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30", "실현변동성 대체 · KOSPI/KOSDAQ 70/30"],
    ["MOCK_VKOSPI", "합성 VKOSPI · 실자료 아님"],
  ] as const)("does not call %s a raw VKOSPI observation", (source, label) => {
    expect(
      dataStatusVolatility({
        asOfDate: "2026-10-09",
        vkospiObservations: [{ date: "2026-10-09", value: 20, source }],
      }).label,
    ).toBe(label);
  });
  it("does not guess provenance from duplicates, malformed sources or live mock values", () => {
    const point = { date: "2026-10-09", value: 20, source: "VKOSPI" as const };
    expect(
      dataStatusVolatility({ asOfDate: point.date, vkospiObservations: [point, point] }).source,
    ).toBe("UNCONFIRMED");
    const invalid = { ...point, source: "INVALID" } as unknown as typeof point;
    expect(
      dataStatusVolatility({ asOfDate: point.date, vkospiObservations: [invalid] }).source,
    ).toBe("UNCONFIRMED");
    expect(
      dataStatusVolatility({
        asOfDate: point.date,
        isLive: true,
        vkospiObservations: [{ ...point, source: "MOCK_VKOSPI" }],
      }).source,
    ).toBe("UNCONFIRMED");
  });
  it("does not infer source provenance from an available legacy boolean/array", () => {
    expect(dataStatusVolatility({ asOfDate: "2026-10-09" }).source).toBe("UNCONFIRMED");
    expect(
      dataStatusVolatility({
        asOfDate: "2026-10-09",
        vkospiObservations: [{ date: "2026-10-08", value: 20, source: "VKOSPI" }],
      }).source,
    ).toBe("UNCONFIRMED");
  });
});
describe("owner/revision-scoped quality summary reuse", () => {
  const value = { asOfDate: "2026-10-09" } as DataStatusPayload;
  it("coalesces simultaneous readers, separates owner/revision, and bounds entries", async () => {
    const cache = createDataStatusCache(2);
    const build = vi.fn(async () => value);
    const first = await Promise.all([cache.get("a", "r1", build), cache.get("a", "r1", build)]);
    expect(first).toEqual([value, value]);
    expect(build).toHaveBeenCalledTimes(1);
    await cache.get("a", "r1", build);
    await cache.get("b", "r1", build);
    await cache.get("a", "r2", build);
    expect(build).toHaveBeenCalledTimes(3);
    await cache.get("a", "r1", build);
    expect(build).toHaveBeenCalledTimes(4);
  });
  it("does not memoize failed or invalidated reads", async () => {
    const cache = createDataStatusCache();
    const fail = vi.fn(async () => {
      throw new Error("source changed");
    });
    await expect(cache.get("a", "r1", fail)).rejects.toThrow("source changed");
    const build = vi.fn(async () => value);
    expect(await cache.get("a", "r1", build)).toBe(value);
    expect(build).toHaveBeenCalledOnce();
  });
});
