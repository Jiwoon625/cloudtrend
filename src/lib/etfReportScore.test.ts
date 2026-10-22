import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildScreeningSummary } from "./analysisRunBundle";
import { getMockDataset } from "./engine/mockProvider";
import { runAnalysis } from "./engine/pipeline";
import { ETF_POLICY } from "./engine/etfStrategy";
import { buildSnapshot } from "./screeningSnapshot";

import { appendEtfReportEvidence, etfReportScore, etfReportScoreSummary } from "./etfReportScore";
import type { ScreeningRow } from "./engine/pipeline";

const date = "2026-10-21";
const etf = (updates: Record<string, unknown> = {}): ScreeningRow =>
  ({
    instrument: {
      symbol: "218420",
      name: "KODEX 미국S&P500에너지(합성)",
      instrumentType: "ETF",
      isLeveraged: false,
      isInverse: false,
    },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      previousDate: "2026-10-20",
      dataStatus: "krx_batch_pending",
      score: null,
      previousScore: 61.03586459007409,
      issues: ["KRX 시총·20일 거래대금 필요"],
      ...updates,
    },
    krxReviewReference: {
      reviewDate: date,
      fields: {},
      preliminary: {
        kind: "ETF",
        status: "ESTIMATE",
        priceDate: date,
        referenceDate: "2026-10-20",
        marketCap: 125e9,
        marketCapDate: "2026-10-20",
        averageTradingValue20: 855082001.5,
        tradingValueThrough: "2026-10-20",
        m0: 61.296,
        healthPoints: 7.5,
        preliminaryOnset: null,
        issues: [],
      },
    },
  }) as unknown as ScreeningRow;

describe("ETF report-only score evidence", () => {
  it("distinguishes current preliminary from official and retains dated prior reference", () => {
    const e = etfReportScore(etf(), date);
    expect(e).toMatchObject({
      scoreStatus: "PRELIMINARY",
      confirmedM0: null,
      preliminaryM0: 61.296,
      preliminaryKrxDate: "2026-10-20",
      preliminaryMarketCapDate: "2026-10-20",
      preliminaryTradingValueThrough: "2026-10-20",
      priorSessionScoreReference: 61.03586459007409,
      priorSessionDate: "2026-10-20",
      priorReferenceVerified: false,
      referenceScore: 61.296,
      referenceDate: date,
      scoreIsToday: true,
    });
    expect(etfReportScore(etf({ score: 0, dataStatus: "ready" }), date)?.scoreStatus).toBe("FINAL");
    expect(etfReportScore(etf({ score: 0, dataStatus: "ready" }), date)?.confirmedM0).toBe(0);
  });
  it("never invents zero for genuinely unavailable M0; old report must use prior reference", () => {
    const missing = etf();
    missing.krxReviewReference = { reviewDate: date, fields: {} };
    expect(etfReportScore(missing, date)).toMatchObject({
      scoreStatus: "PREVIOUS_REFERENCE",
      confirmedM0: null,
      preliminaryM0: null,
      scoreIsToday: false,
      referenceScore: 61.03586459007409,
      referenceDate: "2026-10-20",
    });
    expect(etfReportScore(etf({ previousScore: null }), date)?.scoreStatus).toBe("PRELIMINARY");
    const unavailable = etf({ previousScore: null });
    unavailable.krxReviewReference = { reviewDate: date, fields: {} };
    expect(etfReportScore(unavailable, date)).toMatchObject({
      scoreStatus: "UNAVAILABLE",
      referenceScore: null,
      referenceDate: null,
    });
  });
  it("does not create strategy M0 for bond or cash ETFs, nor accept stale previews", () => {
    // Excluded bond/cash funds must not inherit a numeric raw strategy M0.
    const safeCash = etf({ previousScore: 76.5 });
    safeCash.instrument.symbol = "423160";
    expect(etfReportScore(safeCash, date)).toMatchObject({
      scoreStatus: "NOT_STRATEGY_TARGET",
      confirmedM0: null,
      referenceScore: null,
      strategyTarget: false,
      priorSessionScoreReference: null,
      priorSessionDate: null,
    });
    const stale = etf();
    stale.krxReviewReference!.preliminary!.priceDate = "2026-10-20";
    expect(etfReportScore(stale, date)?.scoreStatus).toBe("PREVIOUS_REFERENCE");
    expect(
      etfReportScore(
        { ...etf(), instrument: { ...etf().instrument, instrumentType: "STOCK" } },
        date,
      ),
    ).toBeNull();
  });
  it("retains mixed current/prior KRX observation dates and an incomplete preview attempt", () => {
    const mixed = etf();
    mixed.krxReviewReference!.preliminary!.marketCapDate = date;
    mixed.krxReviewReference!.preliminary!.tradingValueThrough = "2026-10-20";
    mixed.krxReviewReference!.preliminary!.underlyingDate = "2026-10-20";
    expect(etfReportScore(mixed, date)).toMatchObject({
      preliminaryKrxDate: "2026-10-20",
      preliminaryMarketCapDate: date,
      preliminaryTradingValueThrough: "2026-10-20",
      preliminaryUnderlyingDate: "2026-10-20",
      scoreStatus: "PRELIMINARY",
    });
    const incomplete = etf();
    incomplete.krxReviewReference!.preliminary!.status = "INCOMPLETE";
    incomplete.krxReviewReference!.preliminary!.m0 = null;
    incomplete.krxReviewReference!.preliminary!.issues = ["20일 거래대금 이력 부족"];
    const evidence = etfReportScore(incomplete, date);
    expect(evidence).toMatchObject({
      preliminaryM0: null,
      preliminaryStatus: "INCOMPLETE",
      scoreStatus: "PREVIOUS_REFERENCE",
      referenceDate: "2026-10-20",
    });
    expect(evidence?.issues).toContain("20일 거래대금 이력 부족");
  });

  it("transports report score to run archives only; frozen model/daily calculation remains unchanged", () => {
    const analysis = runAnalysis(getMockDataset());
    const row = analysis.rows.find((r) => r.instrument.instrumentType === "ETF");
    expect(row).toBeDefined();
    row!.instrument.symbol = "218420";
    row!.etfStrategy = etf().etfStrategy!;
    row!.krxReviewReference = etf().krxReviewReference!;
    const model = buildSnapshot(analysis);
    expect(model.entries.find((e) => e.symbol === "218420")?.evidence).toBeUndefined();
    const originalRun = buildSnapshot(analysis, undefined, "synthetic-run");
    expect(
      originalRun.entries.find((e) => e.symbol === "218420")?.evidence?.["etfReportScore"],
    ).toBeUndefined();
    const archive = appendEtfReportEvidence(originalRun, analysis);
    const saved = archive.entries.find((e) => e.symbol === "218420");
    expect(saved?.evidence?.["etfReportScore"]).toMatchObject({
      type: "ETF_M0_REPORT_EVIDENCE_V1",
      scoreStatus: "UNAVAILABLE",
    });
    // This synthetic analysis may have a different asOfDate from the fixture.
    // The new report field must not alter any existing operational decisions.
    // Published run entries have an additional market identifier for evidence.
    // Compare the actual strategy/technical fields after removing report-only
    // evidence and the established run-specific market display field.
    const withoutReportOnly = (entries: typeof archive.entries) =>
      entries.map(({ evidence: _evidence, market: _market, ...entry }) => entry);
    expect(withoutReportOnly(archive.entries)).toEqual(withoutReportOnly(model.entries));
    expect(etfReportScoreSummary(analysis.rows, analysis.asOfDate)).toMatchObject({
      noAvailableScoreIsNotZero: true,
    });
    expect(appendEtfReportEvidence(model, analysis)).toBe(model);
  });
  it("caps references at exactly 25 even when every ETF has an available score", () => {
    const candidates = Array.from({ length: 80 }, () => etf());
    const summary = etfReportScoreSummary(candidates, date);
    expect(summary.totalEtfs).toBe(80);
    expect(summary.counts.PRELIMINARY).toBe(80);
    expect(summary.topReferenceEtfs).toHaveLength(25);
  });

  it.each(["new", "dropped"] as const)("keeps full evidence out of %s grade changes", (change) => {
    const analysis = runAnalysis(getMockDataset());
    const template = analysis.rows.find((row) => row.instrument.instrumentType === "ETF")!;
    analysis.rows = Array.from({ length: 80 }, () => ({
      ...template,
      instrument: { ...template.instrument, symbol: "218420" },
      grade: change === "new" ? "A" : "B",
      etfStrategy: { ...etf().etfStrategy!, date: analysis.asOfDate },
      krxReviewReference: { reviewDate: analysis.asOfDate, fields: {} },
    }));
    const core = buildSnapshot(analysis, undefined, "summary-regression");
    const previous =
      change === "new"
        ? null
        : {
            ...core,
            entries: core.entries.map((entry) => ({ ...entry, grade: "A" as const })),
          };
    const summary = {
      ...buildScreeningSummary(analysis, core, previous),
      etfScoreContinuity: etfReportScoreSummary(analysis.rows, analysis.asOfDate),
    };
    const before = JSON.stringify(summary);
    const archive = appendEtfReportEvidence(core, analysis);
    const changes = change === "new" ? summary.newGradeA : summary.droppedAtoB;
    expect(changes).toHaveLength(80);
    expect(changes.every((entry) => !entry.evidence?.["etfReportScore"])).toBe(true);
    expect(archive.entries.every((entry) => !!entry.evidence?.["etfReportScore"])).toBe(true);
    expect(JSON.stringify(summary)).toBe(before);
    expect(JSON.stringify({ ...summary, etfScoreContinuity: undefined })).not.toContain(
      "etfReportScore",
    );
    // Protect the production CLI wiring as well as the non-mutating archive wrapper.
    const cli = readFileSync(new URL("../../scripts/run-screening.ts", import.meta.url), "utf8");
    expect(cli).toContain("buildScreeningSummary(analysis, coreSnapshot, previous)");
    expect(cli.indexOf("const summary =")).toBeLessThan(
      cli.indexOf("const snapshot = appendEtfReportEvidence"),
    );
  });
});
