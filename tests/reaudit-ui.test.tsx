import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsScreenerPage } from "../src/routes/us.screener";
const query = vi.hoisted(() => ({ failed: true }));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
vi.mock("@/lib/usProspectiveCloud", () => ({ loadUsProspectiveCache: vi.fn() }));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/UsRecoveryNotice", () => ({ UsRecoveryNotice: () => null }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "domestic-position-context"
      ? {
          isSuccess: false,
          isError: query.failed,
          isPending: !query.failed,
          data: undefined,
          refetch: vi.fn(),
        }
      : {
          data: { analysis: { rows: [], date: "2026-10-12", ruleVersion: "synthetic" } },
          isPending: false,
          isError: false,
        },
}));
describe("US holdings availability", () => {
  it("shows an explicit failed holdings lookup with retry instead of pretending holdings are empty", () => {
    query.failed = true;
    const html = renderToStaticMarkup(<UsScreenerPage />);
    expect(html).toContain("보유 자료 조회 실패 · 보유 및 청산 판정 미확인");
    expect(html).toContain("다시 시도");
    expect(html).toContain('role="alert"');
  });
  it("distinguishes loading from failure", () => {
    query.failed = false;
    const html = renderToStaticMarkup(<UsScreenerPage />);
    expect(html).toContain("보유 자료 확인 중 · 청산 판정 대기");
    expect(html).not.toContain("보유 자료 조회 실패");
  });
});
