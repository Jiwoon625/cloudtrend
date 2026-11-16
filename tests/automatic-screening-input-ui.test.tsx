import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), clicks: [] as Array<() => void> }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => mocks.navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/MarketDataPage", () => ({
  MarketDataContent: () => <section>게시 상태 fixture</section>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => {
    if (onClick) mocks.clicks.push(onClick);
    return <button>{children}</button>;
  },
}));
vi.mock("@/lib/cloud", () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock("@/lib/scoringConfigStore", () => ({ getActiveScoringConfig: vi.fn() }));
vi.mock("@/lib/underlyingIndexDiagnostics.functions", () => ({
  compareOperationalIndexServer: vi.fn(),
  readUnderlyingIndexDiagnosticsServer: vi.fn(),
}));
import { UnderlyingIndexDiagnosticsPanel } from "../src/components/UnderlyingIndexDiagnosticsPanel";
import { Route } from "../src/routes/scoring";
import { AnalysisRequired } from "../src/components/AnalysisRequired";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.clicks = [];
});
it("shows publication status and saved results without manual input or cache-reset actions", () => {
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
    .component;
  const html = renderToStaticMarkup(<Page />);
  expect(html).toContain("게시 상태 fixture");
  expect(html).toContain("저장 결과 보기");
  expect(html).not.toMatch(
    /type="file"|textarea|직접 파일 입력|여러 파일 추가|전체 삭제|붙여넣은 데이터/,
  );
  expect(mocks.clicks).toHaveLength(1);
  mocks.clicks[0]!();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  const source = readFileSync("src/routes/scoring.tsx", "utf8");
  expect(source).not.toMatch(
    /manualDataStore|ManualDataInput|removeQueries|setScreeningStarted|rebuildScreening/,
  );
});
it("empty and loading views describe reading automatic publications, not manual input", () => {
  for (const loading of [false, true]) {
    const html = renderToStaticMarkup(<AnalysisRequired loading={loading} />);
    expect(html).toContain("게시");
    expect(html).not.toMatch(/붙여넣|업로드|데이터 입력|스크리닝 시작/);
  }
});
it("removes all legacy screening-input widgets but retains source ingestion and trading contracts", () => {
  for (const path of [
    "src/components/ManualDataInput.tsx",
    "src/components/us/UsDataInput.tsx",
    "src/components/us/UsFetchGuide.tsx",
  ])
    expect(existsSync(path)).toBe(false);
  for (const path of [
    "src/lib/manualDataStore.ts",
    "src/routes/api.gpt.upload.ts",
    "src/routes/mcp.ts",
    "src/lib/newActualPortfolio.server.ts",
  ])
    expect(existsSync(path)).toBe(true);
});

it("retains underlying-index diagnostics but removes its manual JSON installation path", () => {
  const html = renderToStaticMarkup(<UnderlyingIndexDiagnosticsPanel />);
  expect(html).toContain("기초지수 비교 계산");
  expect(html).toContain("운영 MA60 신호 영향 비교");
  expect(html).not.toMatch(/type="file"|검증된 전용 자료 연결|검증자료만 연결/);
  expect(readFileSync("src/components/UnderlyingIndexDiagnosticsPanel.tsx", "utf8")).not.toMatch(
    /installUnderlyingIndexArtifactServer|compressedFile|setOriginalFile/,
  );
});
