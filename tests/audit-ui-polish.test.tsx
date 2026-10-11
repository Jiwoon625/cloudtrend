import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { etfDataJudgment, etfOperationalDisplay } from "../src/lib/etfOperationalDisplay";
import { UsMarketDataPanel } from "../src/components/UsMarketDataPanel";
import { KrMarketDataPanel } from "../src/components/KrMarketDataPanel";
import { formatKstDateTime } from "../src/lib/format";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";
import type { ScreeningRow } from "../src/lib/engine/pipeline";
import type { DataStatusPayload } from "../src/lib/marketPayload";
import type { UsProspectiveSummary } from "../src/lib/usBrowserViews";
import { readFileSync } from "node:fs";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
const date = "2026-10-13";
function row(): ScreeningRow {
  return {
    instrument: { symbol: "360750", instrumentType: "ETF" },
    snapshot: { tradeDate: date, close: 100 },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      dataStatus: "krx_batch_pending",
      score: null,
      rawOnset: false,
      entryState: "none",
      issues: [],
    },
  } as unknown as ScreeningRow;
}
describe("audit display consistency", () => {
  it("never calls missing KRX observations ordinary watch, in either holding state", () => {
    for (const held of [true, false, undefined])
      expect(etfOperationalDisplay(row(), date, held)).toBe("KRX 자료 대기 · 신호 판단 보류");
    expect(etfDataJudgment(row(), date)).toBe("KRX 자료 대기 · 신호 판단 보류");
    expect(etfDataJudgment(row(), "2026-10-14")).toContain("기준일 자료 미확인");
    expect(etfOperationalDisplay(row(), "2026-10-09", false)).toContain("신규 운용 시작 전");
  });
  it.each([
    ["MA60", "다음 시가 청산"],
    ["DATA_UNAVAILABLE", "데이터 오류 · 청산 점검"],
  ] as const)(
    "keeps held %s actionable when only unrelated M0 inputs are missing",
    (exit, label) => {
      const r = row();
      r.etfStrategy!.dataStatus = "incomplete";
      r.etfStrategy!.exit = exit;
      expect(etfOperationalDisplay(r, date, true)).toBe(label);
      expect(etfOperationalDisplay(r, date, false)).toBe("필수 자료 미확인 · 신호 판단 보류");
      expect(r.etfStrategy!.score).toBeNull();
    },
  );
  it("shows one explicitly labeled KST time, independent of the process timezone", () => {
    const value = {
      generatedAt: "2026-10-10T01:48:30Z",
      source: { collectedAt: "2026-10-10T01:00:00Z", metadata: {} },
      analysis: { date: "2026-10-09", summary: {}, rowCount: 0 },
    } as UsProspectiveSummary;
    const html = renderToStaticMarkup(<UsMarketDataPanel value={value} historyCount={0} />);
    expect(html).toContain("2026-10-10 10:48:30 KST");
    expect(formatKstDateTime("invalid")).toBe("-");
    expect(formatKstDateTime(undefined)).toBe("-");
  });
  it("distinguishes a proxy from raw VKOSPI and reports unknown provenance conservatively", () => {
    const data = {
      notes: [],
      barCoverage: [],
      coverage: [],
      capabilities: { volatilityIndex: true },
      checks: {
        ohlcErrors: 0,
        negativeVolume: 0,
        duplicates: 0,
        futureDates: 0,
        insufficient: 0,
        abnormalMoves: 0,
      },
      volatilityObservation: {
        source: "REALIZED_VOLATILITY_KOSPI",
        date,
        label: "실현변동성 대체 · KOSPI",
      },
    } as unknown as DataStatusPayload;
    const html = renderToStaticMarkup(<KrMarketDataPanel data={data} />);
    expect(html).toContain("실현변동성 대체 · KOSPI");
    expect(html).not.toContain("변동성지수(VKOSPI)");
    delete data.volatilityObservation;
    expect(renderToStaticMarkup(<KrMarketDataPanel data={data} />)).toContain(
      "원본·대체 출처 미확인",
    );
  });
  it("connects formula navigation to an actual section and labels numeric filters", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    expect(read("../src/components/MarketDataPage.tsx")).toContain('to="/operating-rules"');
    expect(read("../src/components/MarketDataPage.tsx")).toContain('hash="v8-formula"');
    expect(read("../src/components/V8FormulaSection.tsx")).toContain('<details id="v8-formula"');
    expect(read("../src/components/ScreenerView.tsx")).toContain("aria-label={label}");
  });
});
