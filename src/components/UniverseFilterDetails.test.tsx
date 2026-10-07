import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScreenerTable } from "./ScreenerTable";
import { ScreenerView } from "./ScreenerView";
import { UniverseFilterDetails } from "./UniverseFilterDetails";
import { UniversePendingSummary } from "./UniversePendingSummary";
import { KospiEntryDetails } from "./KospiEntryDetails";
import { historyEntryStatus, isHistoryOperationalEntry } from "./historyEntryPresentation";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";
import type { SnapshotEntry } from "@/lib/screeningSnapshot";

const state = vi.hoisted(() => ({ showDisqualified: true }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(initial === true ? state.showDisqualified : initial),
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { heldSymbols: [], lastSellDateBySymbol: {} } }),
}));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));

const date = "2026-10-07";
const pendingReason = "현재 시가총액 미확인";
const pendingRow = (overrides: Partial<ScreeningRow> = {}): ScreeningRow =>
  ({
    instrument: {
      symbol: "000001",
      name: "시총 미확인 종목",
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorName: "기타",
      indexMemberships: [],
    },
    snapshot: { close: 70000, volumeRatio20: null, distanceFrom52wHigh: null },
    operatingScore10: 8.5,
    scoreDelta1d: 5,
    priority: { points: 3, maxPoints: 5, availableMaxPoints: 4 },
    technical: { points: 8.5, maxPoints: 10, availableMaxPoints: 10 },
    grade: "C",
    rs20: 3,
    rs60: 1.75,
    marketCap: null,
    sectorPriceLeadership: null,
    hardFilterPassed: false,
    hardFilterStatus: "PENDING",
    pendingRules: [pendingReason],
    dataCompletenessRatio: 1,
    warnings: [],
    failedRules: [],
    exitSignal: null,
    kospi80Onset: false,
    kosdaq80Onset: false,
    ...overrides,
  }) as ScreeningRow;
const table = (row: ScreeningRow) =>
  renderToStaticMarkup(<ScreenerTable rows={[row]} signalDate={date} />);

beforeEach(() => {
  state.showDisqualified = true;
});

describe("missing market-cap judgment presentation", () => {
  it.each([false, true])("shows pending separately from failure in compact=%s", (compact) => {
    const row = pendingRow();
    const before = structuredClone(row);
    const html = renderToStaticMarkup(<UniverseFilterDetails row={row} compact={compact} />);
    expect(html).toContain(`판단 보류: ${pendingReason}`);
    expect(html).not.toContain("실격");
    expect(row).toEqual(before);
  });

  it("retains known failures and the separately missing input", () => {
    const html = renderToStaticMarkup(
      <UniverseFilterDetails
        row={pendingRow({ hardFilterStatus: "FAIL", failedRules: ["거래정지"] })}
      />,
    );
    expect(html).toContain("실격 사유: 거래정지");
    expect(html).toContain(`판단 보류 항목: ${pendingReason}`);
  });

  it("preserves old failure records and hides a passed filter with no pending inputs", () => {
    const row = pendingRow({ failedRules: ["시가총액 기준 미달"], pendingRules: [] });
    delete row.hardFilterStatus;
    expect(renderToStaticMarkup(<UniverseFilterDetails row={row} />)).toContain(
      "실격 사유: 시가총액 기준 미달",
    );
    row.hardFilterPassed = true;
    expect(renderToStaticMarkup(<UniverseFilterDetails row={row} />)).toBe("");
  });

  it("keeps calculable technical score visible and does not dim pending rows as failures", () => {
    const html = table(pendingRow());
    expect(html).toContain("8.5/10");
    expect(html).toContain("판단 보류");
    expect(html).toContain(pendingReason);
    expect(html).not.toContain("실격:");
    expect(html).not.toContain("opacity-60");
    expect(html).not.toContain("신규 진입</");
    expect(html).not.toContain("기술점수 산정 불완전");
  });

  it("shows raw score and calculable maximum when technical inputs are also incomplete", () => {
    const html = table(
      pendingRow({
        operatingScore10: null,
        technical: {
          points: 6.5,
          maxPoints: 10,
          availableMaxPoints: 8.5,
        } as ScreeningRow["technical"],
        dataCompletenessRatio: 0.85,
      }),
    );
    expect(html).toContain("산정 불가");
    expect(html).toContain("원점수 6.5/10.0");
    expect(html).toContain("산정 가능 8.5");
    expect(html).toContain("판단 보류");
  });

  it("counts pending separately and keeps it visible when failed rows are hidden", () => {
    state.showDisqualified = false;
    const pending = pendingRow();
    const passed = pendingRow({
      hardFilterPassed: true,
      hardFilterStatus: "PASS",
      pendingRules: [],
    });
    passed.instrument = { ...passed.instrument, symbol: "000002", name: "통과 종목" };
    const failed = pendingRow({
      hardFilterStatus: "FAIL",
      failedRules: ["거래정지"],
      pendingRules: [],
    });
    failed.instrument = { ...failed.instrument, symbol: "000003", name: "거래정지 종목" };
    const analysis = {
      asOfDate: date,
      rows: [pending, passed, failed],
      marketGate: { status: "NEUTRAL", metCount: 2 },
    } as AnalysisResult;
    const html = renderToStaticMarkup(<ScreenerView mode="STOCK" analysis={analysis} />);
    expect(html).toContain("시총 미확인 종목");
    expect(html).toContain("통과 종목");
    expect(html).not.toContain("거래정지 종목");
    expect(html).toContain("표시 · 통과 1건 / 실격 1건 / 판단 보류 1건");
    expect(html).toContain("판단 보류 (1)");
    expect(html).toContain("진입 준비 (0)");
  });

  it.each(["KOSPI", "KOSDAQ"] as const)(
    "keeps stale %s candidate fields out of entry and confirmation-waiting presets",
    (market) => {
      const row = pendingRow({ kosdaq80Onset: market === "KOSDAQ" });
      row.instrument = { ...row.instrument, market };
      if (market === "KOSPI") {
        row.kospi80Onset = true;
        row.kospiEntry = {
          state: "pending",
          date,
          originDate: date,
          confirmationDate: null,
          rsAccel: 1,
          score: 8.5,
          originScore: 8.5,
          eligible: false,
          issues: [],
          version: "legacy",
        };
      }
      const analysis = {
        asOfDate: date,
        rows: [row],
        marketGate: { status: "NEUTRAL", metCount: 2 },
      } as AnalysisResult;
      const html = renderToStaticMarkup(<ScreenerView mode="STOCK" analysis={analysis} />);
      expect(html).toContain("진입 준비 (0)");
      expect(html).toContain("KOSPI 하루 확인 대기 (0)");
      expect(html).toContain("KOSDAQ Onset (0)");
      if (market === "KOSPI") expect(html).toContain("KOSPI 원시 Onset (1)");
    },
  );

  it("subordinates stored KOSPI confirmation when current eligibility is pending", () => {
    const html = renderToStaticMarkup(
      <KospiEntryDetails
        entry={
          {
            state: "confirmed",
            date,
            originDate: "2026-10-06",
            confirmationDate: date,
            rsAccel: 1,
            score: 8.5,
            originScore: 8,
            eligible: true,
            issues: [],
            version: "legacy",
          } as NonNullable<ScreeningRow["kospiEntry"]>
        }
        showState
        entryJudgmentPending
      />,
    );
    expect(html).toContain("신규 진입 판단 보류");
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("종목 공통 확인 기록 (참고)");
  });

  it("shows pending reasons in the dashboard without claiming failure or an entry", () => {
    const html = renderToStaticMarkup(<UniversePendingSummary reasons={[[pendingReason, 3]]} />);
    expect(html).toContain("주식 판단 보류 사유");
    expect(html).toContain(pendingReason);
    expect(html).toContain("3건");
    expect(html).toContain("기술점수와 산정 가능 여부");
    expect(html).not.toContain("실격");
    expect(renderToStaticMarkup(<UniversePendingSummary />)).toBe("");
  });

  it("does not resurrect a stale KOSDAQ entry from saved status when judgment is pending", () => {
    const entry = {
      symbol: "000001",
      name: "이력 판단 보류 종목",
      instrumentType: "STOCK",
      grade: "C",
      status: "KOSDAQ 80 Onset",
      hardFilterPassed: false,
      hardFilterStatus: "PENDING",
      pendingRules: [pendingReason],
      kosdaq80Onset: true,
      technicalPoints: 8.5,
      priorityPoints: 3,
    } as SnapshotEntry;
    expect(isHistoryOperationalEntry(entry, date)).toBe(false);
    expect(historyEntryStatus(entry)).toBe(`판단 보류 · ${pendingReason}`);
    expect(entry.technicalPoints).toBe(8.5);
  });
});
