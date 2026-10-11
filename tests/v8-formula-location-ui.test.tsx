import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Route as ScoringRoute } from "../src/routes/scoring";
import { Route as OperatingRulesRoute } from "../src/routes/operating-rules";
import { V8FormulaSection } from "../src/components/V8FormulaSection";
import { VF_FEATURE_WEIGHTS, VF_MODEL_LABEL } from "../src/lib/engine/vfConfig";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/MarketDataPage", () => ({
  MarketDataContent: () => <section>자료 상태</section>,
}));
vi.mock("@/components/ManualDataInput", () => ({
  ManualDataInput: () => <div>입력 화면</div>,
}));
vi.mock("@/components/OperatingBacktestMetrics", () => ({
  OperatingBacktestMetrics: () => null,
}));
vi.mock("@/lib/manualDataStore", () => ({ getManualDataText: () => null }));
vi.mock("@/lib/screeningRun", () => ({ setScreeningStarted: vi.fn() }));

function renderRoute(route: unknown) {
  const Page = (route as { options: { component: React.ComponentType } }).options.component;
  return renderToStaticMarkup(<Page />);
}

describe("V8 formula location", () => {
  it("places one collapsed formula section after all operating and experimental rules", () => {
    const html = renderRoute(OperatingRulesRoute);
    expect(html.match(/계산 산식/g)).toHaveLength(1);
    expect(html).toContain(`계산 산식 · ${VF_MODEL_LABEL}`);
    expect(html.indexOf("계산 산식")).toBeGreaterThan(html.indexOf("실험규칙 상세"));
    expect(html).toMatch(/<details[^>]*><summary/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("기술점수 구성요소");
  });

  it("removes formulas from data management while preserving input and data status", () => {
    const html = renderRoute(ScoringRoute);
    expect(html).toContain("데이터 관리");
    expect(html).toContain("입력 화면");
    expect(html).toContain("자료 상태");
    expect(html).toContain("스크리닝 시작");
    expect(html).not.toContain("계산 산식");
    expect(html).not.toContain("기술점수 구성요소");
  });

  it("keeps all eight original formula rows with engine-defined weights", () => {
    const html = renderToStaticMarkup(<V8FormulaSection />);
    const rows = [...html.matchAll(/<tr class="border-t">(.*?)<\/tr>/g)];
    expect(rows).toHaveLength(8);
    const weights = rows.map(([, row]) => Number(row.match(/<td>([^<]+)<\/td>/)?.[1]));
    expect(weights).toEqual([
      VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD,
      VF_FEATURE_WEIGHTS.MA_ALIGNED,
      VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN,
      VF_FEATURE_WEIGHTS.BB_BREAKOUT,
      VF_FEATURE_WEIGHTS.VOLUME_SURGE,
      VF_FEATURE_WEIGHTS.NEAR_52W_HIGH,
      VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,
      VF_FEATURE_WEIGHTS.SECTOR_PRICE_LEADERSHIP,
    ]);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBe(10);
    expect(html).toContain("Sector Price Leadership");
    expect(html).toContain("Volume Surge");
  });
});
