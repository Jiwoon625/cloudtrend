import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/lib/actualPerformance.functions", () => ({ actualPerformanceServer: vi.fn() }));
import { ActualPerformanceReview } from "./ActualPerformanceReview";

describe("reviewed performance input presentation", () => {
  it("starts empty and separates read-only preview from explicit confirmation", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ActualPerformanceReview />
      </QueryClientProvider>,
    );
    expect(html).toContain("실제 성과 자료 대조·확정");
    expect(html).toContain("검사 후 미리보기");
    expect(html).toContain("실제 배정 현금·환율은");
    expect(html).toContain("일별 자동평가에 필요한 실제 원장 연결은 대조 후 결정");
    expect(html).not.toContain("검토한 자료 확정 저장");
    expect(html).not.toContain("100000000");
    expect(html).not.toContain("1339.2");
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
