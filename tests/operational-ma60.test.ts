import { describe, it, expect } from "vitest";
import { buildOperationalIndexProvider } from "../src/lib/operationalUnderlyingIndex";
import { withOperationalEtfMa60 } from "../src/lib/operationalEtfMa60";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { operationalFixture as fixture } from "./operational-ma60-fixture";
const now = "2026-10-19T10:00:00Z";
describe("approved operational MA60 provider", () => {
  it("joins frozen history and new dated observations without modifying dataset", () => {
    const { ds, artifact } = fixture();
    const before = JSON.stringify(ds);
    const p = buildOperationalIndexProvider(ds, artifact, now)!;
    expect(p.rows["360750"]?.observations.at(-1)).toEqual({
      date: "2026-10-19",
      close: 100,
      ma60: 100,
    });
    expect(JSON.stringify(ds)).toBe(before);
  });
  it("does not apply before next new session, allows explicit nonpublishing dry-run only", () => {
    const { ds, artifact } = fixture();
    ds.asOfDate = "2026-10-16";
    expect(buildOperationalIndexProvider(ds, artifact, now)).toBeUndefined();
    expect(
      buildOperationalIndexProvider(ds, artifact, now, { dryRunAtCutoff: true }),
    ).toBeDefined();
  });
  it("does not use unavailable vintage", () => {
    const { ds, artifact } = fixture();
    expect(() => buildOperationalIndexProvider(ds, artifact, "2026-10-17T00:00:00Z")).toThrow();
  });
  it("quarantines identity drift and unapproved historical conflicts per symbol", () => {
    const { ds, artifact } = fixture();
    ds.observedBars!["360750"]!.at(-1)!.etfUnderlyingIndexName = "OTHER";
    expect(buildOperationalIndexProvider(ds, artifact, now)!.rows["360750"]?.status).toBe(
      "quarantined",
    );
  });
  it("refuses newly changed past values instead of blanket overriding", () => {
    const { ds, artifact } = fixture();
    ds.observedBars!["360750"]!.at(-2)!.etfUnderlyingIndexClose = 99;
    expect(buildOperationalIndexProvider(ds, artifact, now)!.rows["360750"]?.status).toBe(
      "quarantined",
    );
  });
  it("does not fill missing current day with last available observation", () => {
    const { ds, artifact } = fixture();
    ds.observedBars!["360750"]!.at(-1)!.etfUnderlyingIndexClose = null;
    const p = buildOperationalIndexProvider(ds, artifact, now)!;
    expect(p.rows["360750"]?.observations.at(-1)?.ma60).toBeNull();
  });
  it("preserves full analysis, all M0 components and all non-ETF rows", () => {
    const { ds, artifact } = fixture();
    const original = runFullMarketAnalysis(ds).analysis;
    const encoded = JSON.stringify(original);
    const p = buildOperationalIndexProvider(ds, artifact, now)!;
    const result = withOperationalEtfMa60(original, p);
    expect(JSON.stringify(original)).toBe(encoded);
    for (let i = 0; i < result.rows.length; i++) {
      const a = original.rows[i]!,
        b = result.rows[i]!;
      for (const key of [
        "score",
        "previousScore",
        "technical",
        "priority",
        "health",
        "environment",
        "environmentSource",
        "eligible",
        "rawOnset",
        "originDate",
      ] as const)
        expect(b.etfStrategy?.[key]).toBe(a.etfStrategy?.[key]);
    }
  });
  it("does not introduce any cash/bond ETF trading change", () => {
    const { ds, artifact } = fixture("0046A0");
    const original = runFullMarketAnalysis(ds).analysis;
    const result = withOperationalEtfMa60(
      original,
      buildOperationalIndexProvider(ds, artifact, now)!,
    );
    for (let i = 0; i < original.rows.length; i++) {
      const { operationalEtfReference: reference, ...row } = result.rows[
        i
      ] as import("../src/lib/operationalEtfMa60").OperationalScreeningRow;
      expect(row).toEqual(original.rows[i]);
      if (row.instrument.instrumentType === "ETF") expect(reference?.ma60).toBe(100);
    }
  });
  it("preserves KRX data-pending state even when MA60 exists", () => {
    const { ds, artifact } = fixture();
    const original = runFullMarketAnalysis(ds).analysis;
    const row = original.rows.find((r) => r.etfStrategy)!;
    row.etfStrategy = {
      ...row.etfStrategy!,
      dataStatus: "krx_batch_pending",
      entryState: "data_pending",
      exit: null,
      onset: false,
    };
    const result = withOperationalEtfMa60(
      original,
      buildOperationalIndexProvider(ds, artifact, now)!,
    );
    expect(result.rows.find((r) => r.etfStrategy)?.etfStrategy).toMatchObject({
      dataStatus: "krx_batch_pending",
      entryState: "data_pending",
      exit: null,
      onset: false,
    });
  });
  it("never turns missing current ETF price into a normal MA60 exit", () => {
    const { ds, artifact } = fixture();
    const original = runFullMarketAnalysis(ds).analysis;
    const row = original.rows.find((r) => r.etfStrategy)!;
    row.etfStrategy = {
      ...row.etfStrategy!,
      exit: "DATA_UNAVAILABLE",
      issues: ["기준일 ETF 가격 없음"],
    };
    const result = withOperationalEtfMa60(
      original,
      buildOperationalIndexProvider(ds, artifact, now)!,
    );
    expect(result.rows.find((r) => r.etfStrategy)?.etfStrategy?.exit).toBe("DATA_UNAVAILABLE");
  });
  it("re-evaluates only MA60 confirmation issues, preserving origin and other failures", () => {
    const { ds, artifact } = fixture();
    const original = runFullMarketAnalysis(ds).analysis;
    const row = original.rows.find((r) => r.etfStrategy)!;
    row.etfStrategy = {
      ...row.etfStrategy!,
      eligible: true,
      score: 85,
      confirmationDate: ds.asOfDate,
      originDate: "2026-10-16",
      entryState: "rejected",
      onset: false,
      confirmationIssues: ["확인일 기초지수 MA60 하회"],
    };
    const provider = buildOperationalIndexProvider(ds, artifact, now)!;
    let s = withOperationalEtfMa60(original, provider).rows.find(
      (r) => r.etfStrategy,
    )!.etfStrategy!;
    expect(s).toMatchObject({
      entryState: "confirmed",
      onset: true,
      originDate: "2026-10-16",
      score: 85,
    });
    row.etfStrategy.confirmationIssues.push("확인일 데이터·대상 부적격");
    s = withOperationalEtfMa60(original, provider).rows.find((r) => r.etfStrategy)!.etfStrategy!;
    expect(s.entryState).toBe("rejected");
    expect(s.confirmationIssues).toEqual(["확인일 데이터·대상 부적격"]);
  });
});
