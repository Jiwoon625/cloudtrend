import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EtfScreener } from "./EtfScreener";
import { EtfAssessmentDetails } from "./EtfAssessmentDetails";
import { etfPartialEvidence } from "@/lib/etfPartialEvidence";
import { ETF_POLICY, type EtfStrategySnapshot } from "@/lib/engine/etfStrategy";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";

const state = vi.hoisted(() => ({ filter: "equity" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(initial === "equity" ? state.filter : initial),
  };
});

beforeEach(() => {
  state.filter = "equity";
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const date = "2026-10-07";
function row(overrides: Partial<EtfStrategySnapshot> = {}): ScreeningRow {
  return {
    instrument: {
      symbol: "360750",
      name: "부분 판단 ETF",
      instrumentType: "ETF",
      sectorName: "시장대표",
    },
    snapshot: { tradeDate: date, close: 10000 },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      previousDate: "2026-10-06",
      score: null,
      previousScore: 83,
      technical: 80,
      priority: 0,
      health: null,
      environment: 50,
      environmentSource: "own_index_lag1",
      eligible: false,
      dataStatus: "krx_batch_pending",
      krxReferenceDate: "2026-10-06",
      onset: false,
      rawOnset: false,
      entryState: "none",
      originDate: null,
      confirmationDate: null,
      confirmationIssues: [],
      region: "US",
      sector: "MARKET_IDX",
      annualVolatility: 0.2,
      entryWeight: null,
      averageTradingValue20: null,
      underlyingClose: null,
      underlyingMa60: null,
      exit: null,
      issues: ["KRX 시총·20일 거래대금 필요"],
      ...overrides,
    },
  } as ScreeningRow;
}
const render = (input: ScreeningRow) =>
  renderToStaticMarkup(
    <EtfScreener analysis={{ asOfDate: date, rows: [input] } as AnalysisResult} />,
  );
const cells = (html: string) =>
  [...html.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)].map((match) => match[1]!.replace(/<[^>]+>/g, ""));

describe("ETF available-evidence screen", () => {
  it.each(["equity", "partial", "missing", "all"])(
    "keeps complete-data failure exclusions while exposing pending evidence in %s",
    (filter) => {
      state.filter = filter;
      const ready = row({
        eligible: true,
        dataStatus: "ready",
        issues: [],
        health: 100,
        score: 72.5,
      });
      ready.instrument = { ...ready.instrument, name: "계산 완료 ETF" };
      const failed = row({
        dataStatus: "incomplete",
        issues: ["수정주가 출처·120일 이력 확인 필요"],
      });
      failed.instrument = {
        ...failed.instrument,
        symbol: "069500",
        name: "확정 데이터 부적격 ETF",
      };
      const readyFailed = row({ dataStatus: "ready", eligible: false, issues: [] });
      readyFailed.instrument = {
        ...readyFailed.instrument,
        symbol: "229200",
        name: "저장 ready 부적격 ETF",
      };
      const pending = row();
      pending.instrument = { ...pending.instrument, symbol: "133690", name: "KRX 대상 대기 ETF" };
      const outside = row({ issues: ["주식형·커버드콜 ETF 전략 대상 아님"] });
      outside.instrument = {
        ...outside.instrument,
        symbol: "114800",
        name: "KRX 비대상 대기 ETF",
        isInverse: true,
      };
      const html = renderToStaticMarkup(
        <EtfScreener
          analysis={
            {
              asOfDate: date,
              rows: [ready, failed, readyFailed, pending, outside],
            } as AnalysisResult
          }
        />,
      );
      const names = cells(html)
        .filter((_, index) => index % 14 === 0)
        .join(" ");
      expect(names.includes("계산 완료 ETF")).toBe(filter === "equity" || filter === "all");
      expect(names.includes("확정 데이터 부적격 ETF")).toBe(
        filter === "missing" || filter === "all",
      );
      expect(names.includes("저장 ready 부적격 ETF")).toBe(
        filter === "missing" || filter === "all",
      );
      expect(names).toContain("KRX 대상 대기 ETF");
      expect(names.includes("KRX 비대상 대기 ETF")).toBe(filter !== "equity");
    },
  );

  it("shares explicit partial-evidence semantics with dashboard and portfolio views", () => {
    const evidence = etfPartialEvidence(row(), date);
    const before = structuredClone(evidence);
    const html = renderToStaticMarkup(<EtfAssessmentDetails evidence={evidence} />).replace(
      /<[^>]+>/g,
      "",
    );
    expect(html).toContain("KRX 자료 대기 · M0·진입·청산 확정 보류");
    expect(html).toContain("기술 50/62.5 · Priority 0/7.5");
    expect(html).toContain("Health 산정 불가/15 · 환경 7.5/15");
    expect(html).toContain("기초지수 MA60 판단 미확인");
    expect(evidence).toEqual(before);
  });

  it("shows a KRX-pending target in the initial view with known values and explicit missing values", () => {
    const input = row();
    const before = structuredClone(input);
    const html = render(input);
    const values = cells(html);
    expect(html).toContain("부분 판단 ETF");
    expect(html).toContain("전략 대상 · 부분 판단 포함");
    expect(html).toContain("KRX 대기 1건");
    expect(html).toContain("통상 다음 영업일 오전 8시(KST)");
    expect(values[1]).toContain("산정 불가");
    expect(values[2]).toContain("83");
    expect(values[2]).toContain("2026-10-06 · 과거 참고");
    expect(values[3]).toBe("50");
    expect(values[4]).toBe("0");
    expect(values[5]).toContain("산정 불가");
    expect(values[6]).toBe("7.5");
    expect(values[7]).toContain("기초지수 MA60 판단 미확인");
    expect(values[8]).toBe("미확인");
    expect(values[9]).toBe("20%");
    expect(values[10]).toBe("미확인");
    expect(values[12]).toBe("—");
    expect(html).not.toContain("신규 신호 1건");
    expect(input).toEqual(before);
  });

  it("never renders missing ETF strategy components as actual zero scores", () => {
    state.filter = "all";
    const input = row();
    delete input.etfStrategy;
    const html = render(input);
    const values = cells(html);
    expect(values.slice(1, 7)).toEqual(Array(6).fill("산정 불가"));
    expect(html).toContain("기준일 자료 미확인 · 재계산 필요");
    expect(html).toContain("환경 출처 미확인");
  });

  it("shows the underlying observation without turning KRX waiting into an exit", () => {
    const html = render(row({ underlyingClose: 90, underlyingMa60: 100 }));
    expect(html).toContain("관측 근거: 기초지수 MA60 하회");
    expect(html).toContain("KRX 자료 대기 · 신호 판단 보류");
    expect(html).toContain("부분 근거만 표시 · M0·진입·청산 확정 대기");
    expect(html).not.toContain("다음 시가 청산</strong>");
  });

  it("marks legacy or stale saved records unverified without a misleading current batch banner", () => {
    state.filter = "all";
    const html = render(row({ date: "2026-10-06", technical: 100, health: 100, score: 95 }));
    expect(cells(html).slice(1, 7)).toEqual(Array(6).fill("산정 불가"));
    expect(html).toContain("저장 기준일 2026-10-06");
    expect(html).not.toContain("KRX 금액·기초지수 자료가 일괄 미수신 상태입니다");
  });
});
