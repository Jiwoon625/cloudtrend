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
    expect(html).toContain("현금이나 성과 NAV가 아닙니다");
    expect(html).toContain("각각 기록하며 두 장부의 금액을 합산하지 않습니다");
    expect(html).toContain("ETF 운용분 평가자산 × 기존 변동성 비중");
    expect(html).toContain("기존 보유 리밸런싱 없음");
    expect(html).toContain("연초 자동평가는 활성화되지 않았습니다");
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
  it("preserves boundary, duplicate funding and no-autosync warnings", () => {
    const html = renderToStaticMarkup(<OperatingCapitalPlanContent plan={plan} />);
    expect(html).toContain("Notion 종목마스터·거래내역");
    expect(html).toContain("자동 동기화하지 않습니다");
    expect(html).toContain("기존 보유 매도 예정은 체결로 기록하지 않습니다");
    expect(html).toContain("시작현금과 이후 입금에 한 번만 반영");
  });
  it("formats exact large totals without binary numeric rounding", () => {
    const p = prepareOperatingCapitalPlan("999999999999999999.12345678", "2026-10-09T12:00:00Z");
    expect(renderToStaticMarkup(<OperatingCapitalPlanContent plan={p} />)).toContain(
      "999,999,999,999,999,999.12345678원",
    );
  });
});
