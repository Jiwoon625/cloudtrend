import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EtfScreener } from "./EtfScreener";
import { EtfAssessmentDetails } from "./EtfAssessmentDetails";
import { etfPartialEvidence } from "@/lib/etfPartialEvidence";
import { ETF_POLICY, type EtfStrategySnapshot } from "@/lib/engine/etfStrategy";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";

const state = vi.hoisted(() => ({
  filter: "equity",
  minimums: { score: 0, environment: 0, tradingValue: 0 },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(
        initial === "equity"
          ? state.filter
          : typeof initial === "object" && initial !== null && "tradingValue" in initial
            ? state.minimums
            : initial,
      ),
  };
});

beforeEach(() => {
  state.filter = "equity";
  state.minimums = { score: 0, environment: 0, tradingValue: 0 };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const date = "2026-11-04";
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
      previousDate: "2026-11-03",
      score: null,
      previousScore: 83,
      technical: 80,
      priority: 0,
      health: null,
      environment: 50,
      environmentSource: "own_index_lag1",
      eligible: false,
      dataStatus: "krx_batch_pending",
      krxReferenceDate: "2026-11-03",
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
        .filter((_, index) => index % 12 === 0)
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
    expect(values[2]).toContain("2026-11-03 · 과거 참고");
    expect(values[3]).toBe("50");
    expect(values[4]).toBe("0");
    expect(values[5]).toContain("산정 불가");
    expect(values[6]).toBe("7.5");
    expect(values[7]).toContain("기초지수 MA60 판단 미확인");
    expect(values[8]).toBe("미확인");
    expect(values[9]).toBe("20%");
    expect(values[10]).toBe("미확인");
    expect(values).toHaveLength(12);
    expect(html).not.toContain("주문가격");
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
    const html = render(row({ date: "2026-11-03", technical: 100, health: 100, score: 95 }));
    expect(cells(html).slice(1, 7)).toEqual(Array(6).fill("산정 불가"));
    expect(html).toContain("저장 기준일 2026-11-03");
    expect(html).not.toContain("KRX 금액·기초지수 자료가 일괄 미수신 상태입니다");
  });
});

it("keeps saved M0 and turnover minimums from hiding explicit KRX review, and reapplies them on return", () => {
  state.minimums = { score: 80, environment: 0, tradingValue: 10 };
  state.filter = "partial";
  expect(cells(render(row())).join(" ")).toContain("부분 판단 ETF");
  expect(render(row())).toContain("필터값은 유지");
  state.filter = "equity";
  expect(cells(render(row())).join(" ")).not.toContain("부분 판단 ETF");
  state.filter = "partial";
  state.minimums.environment = 10;
  expect(cells(render(row())).join(" ")).not.toContain("부분 판단 ETF");
});

it("distinguishes all three confirmed stage counts from an unconfirmed KRX result", () => {
  const html = render(row()).replace(/<[^>]+>/g, "");
  expect(html).toContain("당일 원신호 · 확인된 0종목 · 판단 미확정 1종목");
  expect(html).toContain("하루 확인 대기 · 확인된 0종목 · 자료 판단 보류 1종목");
  expect(html).toContain("진입 준비 · 확인된 보유 확인 대기 · 자료 판단 보류 1종목");
});

it("keeps raw and technical filters separate and applies the same technical scope as dashboard", () => {
  const good = row();
  const missing = row({ issues: ["기술점수 이력 부족"] });
  missing.instrument = { ...missing.instrument, symbol: "133690", name: "기술미확인" };
  const old = row({ originDate: "2026-10-08", entryState: "data_pending" });
  old.instrument = { ...old.instrument, symbol: "360750", name: "시작전원신호" };
  const renderRows = () =>
    renderToStaticMarkup(
      <EtfScreener
        analysis={{ asOfDate: date, rows: [good, missing, old] } as AnalysisResult}
        positionContext={{ heldSymbols: [], lastSellDateBySymbol: {} }}
      />,
    );
  state.filter = "raw";
  let html = renderRows();
  expect(cells(html)).toHaveLength(0);
  state.filter = "technical";
  state.minimums = { score: 80, environment: 0, tradingValue: 10 };
  html = renderRows();
  expect(cells(html)).toHaveLength(12);
  expect(html).toContain("부분 판단 ETF");
  expect(html).not.toContain("기술미확인");
  expect(html).not.toContain("시작전원신호");
});

it("does not show an empty technical reference scope as confirmed zero when holdings are unknown", () => {
  state.filter = "technical";
  const html = render(row());
  expect(html).toContain("미보유 기술조건 참고");
  expect(html).toContain("미확인/1종목");
});
