import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../src/components/AppShell";
import { Route as PositionSizingRoute } from "../src/routes/position-sizing";
vi.mock("@/lib/analysisQuery", () => ({
  analysisQueryOptions: {},
  isAnalysisPayload: () => false,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: null }) }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  redirect: (options: unknown) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
describe("final consolidated navigation", () => {
  it("uses the requested exact ten-tab order with one portfolio and one data status destination", () => {
    const html = renderToStaticMarkup(
      <AppShell>
        <p>content</p>
      </AppShell>,
    );
    const labels = [
      "데이터/산식",
      "대시보드",
      "포트폴리오",
      "주식스크리너",
      "ETF스크리너",
      "US스크리너",
      "섹터",
      "스크리닝 이력",
      "Shadow",
      "데이터상태",
    ];
    const positions = labels.map((text) => html.indexOf(`>${text}</a>`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).not.toContain('href="/us/portfolio"');
    expect(html).not.toContain('href="/us"');
    expect(html).not.toContain('href="/position-sizing"');
    expect(html).toContain('aria-label="주 메뉴"');
  });
  it("keeps the old position-sizing bookmark safe without showing the removed calculator", () => {
    expect(
      (PositionSizingRoute.options as unknown as { beforeLoad: () => void }).beforeLoad,
    ).toThrow(expect.objectContaining({ to: "/portfolio", replace: true }));
  });
});
