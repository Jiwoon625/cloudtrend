import { describe, it, expect } from "vitest";
import { getMockDataset } from "./mockProvider";
import { DEFAULT_SCORING_CONFIG } from "./scoring";
import { shadowDatasetAsOf, buildKospiShadowSession } from "./kospiShadowDataset";
const provenance = {
  sourceHash: "source",
  configHash: "config",
  codeVersion: "sha",
  sourceCollectedAt: "2026-08-28T08:00:00Z",
  now: "2026-10-02T09:00:00Z",
};
describe("Shadow dated source adapter", () => {
  it("truncates every price series, session calendar and future fact before calculation", () => {
    const raw = getMockDataset(),
      date = raw.tradeDates.at(-2)!;
    raw.financials["FUTURE"] = { ...Object.values(raw.financials)[0]!, sourceDate: raw.asOfDate };
    const ds = shadowDatasetAsOf(raw, date);
    expect(ds.tradeDates.at(-1)).toBe(date);
    expect(Object.values(ds.bars).every((b) => b.every((r) => r.tradeDate <= date))).toBe(true);
    expect(ds.indexSeries.every((s) => s.bars.every((b) => b.tradeDate <= date))).toBe(true);
    expect(ds.financials["FUTURE"]).toBeUndefined();
    expect(ds.vkospiSeries).toEqual([]);
    expect(raw.tradeDates.at(-1)).not.toBe(date);
  });
  it("rejects duplicate bars, future dates and synthetic feeds", () => {
    const raw = structuredClone(getMockDataset());
    expect(() => buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, provenance)).toThrow(
      /Synthetic/,
    );
    expect(() => shadowDatasetAsOf(raw, "2027-01-01")).toThrow(/exceeds/);
    raw.bars["005930"]!.push({ ...raw.bars["005930"]!.at(-1)! });
    expect(() => shadowDatasetAsOf(raw, raw.asOfDate)).toThrow(/Duplicate/);
  });
  it("rejects intraday registration and stale benchmark rows", () => {
    const raw = { ...structuredClone(getMockDataset()), isLive: true };
    expect(() =>
      buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, {
        ...provenance,
        sourceCollectedAt: `${raw.asOfDate}T05:00:00Z`,
      }),
    ).toThrow(/regular close/);
    raw.indexSeries = raw.indexSeries.map((s) =>
      s.indexCode === "KOSPI" ? { ...s, bars: s.bars.slice(0, -1) } : s,
    );
    expect(() => buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, provenance)).toThrow(
      /Exact-date/,
    );
  });
  it("does not transform missing dated regime inputs into neutral, or leak other markets/primary labels", () => {
    const raw = { ...structuredClone(getMockDataset()), isLive: true };
    const s = buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, provenance);
    expect(s.gate.status).toBe("UNKNOWN");
    expect(s.rows.length).toBeGreaterThan(0);
    expect(
      s.rows.every((r) => raw.instruments.find((i) => i.symbol === r.symbol)?.market === "KOSPI"),
    ).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/kospiEntry|kosdaq80|a2Entry|primarySignal/);
  });
  it("future source changes cannot alter an earlier as-of session", () => {
    const raw = { ...structuredClone(getMockDataset()), isLive: true },
      date = raw.tradeDates.at(-2)!;
    const a = buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, provenance, date);
    const changed = structuredClone(raw);
    for (const bars of Object.values(changed.bars)) {
      const last = bars.at(-1)!;
      last.close *= 100;
      last.high *= 100;
    }
    const b = buildKospiShadowSession(changed, DEFAULT_SCORING_CONFIG, provenance, date);
    expect(b).toEqual(a);
  });
});
