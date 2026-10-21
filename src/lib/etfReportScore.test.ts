import { describe, expect, it } from "vitest";
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
  it("bounds summary to 25 representative ETFs rather than writing huge arrays", () => {
    const candidates = Array.from({ length: 40 }, (_, n) => {
      const row = etf();
      row.instrument = { ...row.instrument, symbol: `T${String(n).padStart(5, "0")}` };
      // Unknown mapping -> non strategy target, with no fabricated M0.
      return row;
    });
    const s = etfReportScoreSummary([etf(), ...candidates], date);
    expect(s.totalEtfs).toBe(41);
    expect(s.noAvailableScoreIsNotZero).toBe(true);
    expect(s.topReferenceEtfs.length).toBeLessThanOrEqual(25);
  });
});
