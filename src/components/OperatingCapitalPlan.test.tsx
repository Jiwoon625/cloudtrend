import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/lib/operatingCapitalPlan.functions", () => ({ operatingCapitalPlanServer: vi.fn() }));
import { OperatingCapitalPlanContent } from "./OperatingCapitalPlan";
import { prepareOperatingCapitalPlan } from "@/lib/operatingCapitalPlan";
const plan = prepareOperatingCapitalPlan("12765432", "2026-10-09T12:00:00Z");
describe("private plan presentation", () => {
  it("shows planned shared total without claiming baseline or funded NAV", () => {
    const html = renderToStaticMarkup(<OperatingCapitalPlanContent plan={plan} />);
    expect(html).toContain("총 계획금액 12,765,432원");
    expect(html).toContain("시장 배분 미확정");
    expect(html).toContain("계획금액은 참고용입니다");
    expect(html).toContain("실제 입금·배정한 자금은 현금 내역에 별도로 기록하세요");
    expect(html).not.toContain("수익률 0");
    expect(html).not.toContain("1339.2");
  });
  it("shows no amount when no private plan exists", () => {
    const html = renderToStaticMarkup(<OperatingCapitalPlanContent plan={null} />);
    expect(html).toContain("총 계획금액 미등록");
    expect(html).not.toContain("12,765,432");
  });
  it("does not render a cached amount under loading or failure", () => {
    for (const props of [{ loading: true }, { error: "대조 필요" }]) {
      const html = renderToStaticMarkup(<OperatingCapitalPlanContent plan={plan} {...props} />);
      expect(html).not.toContain("12,765,432");
    }
  });
  it("omits start, archive and implementation commentary from the plan card", () => {
    const html = renderToStaticMarkup(<OperatingCapitalPlanContent plan={plan} />);
    expect(html).toContain('aria-label="운용계획"');
    expect(html).not.toMatch(
      /Notion|10월 12일|신규|원장|자동 동기화|연초|리밸런싱|통합 계약|두 장부/,
    );
    expect(html.match(/<p(?:\s|>)/g)).toHaveLength(3);
  });
  it("formats exact large totals without binary numeric rounding", () => {
    const p = prepareOperatingCapitalPlan("999999999999999999.12345678", "2026-10-09T12:00:00Z");
    expect(renderToStaticMarkup(<OperatingCapitalPlanContent plan={p} />)).toContain(
      "999,999,999,999,999,999.12345678원",
    );
  });
});
