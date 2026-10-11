import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IntegratedAllocationShadowContent } from "./IntegratedAllocationShadowPanel";
import { createIntegratedAllocationShadow } from "@/lib/integratedAllocationShadow";
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/lib/integratedAllocationShadow.functions", () => ({
  integratedAllocationShadowServer: vi.fn(),
}));
const hash = `sha256:${"a".repeat(64)}` as const;
describe("integrated allocation Shadow display", () => {
  it("separates new calendar-month O1 from its historical initial seed and research", async () => {
    const ledger = await createIntegratedAllocationShadow("O1", { codeHash: hash });
    const html = renderToStaticMarkup(<IntegratedAllocationShadowContent ledger={ledger} />);
    expect(html).toContain("3,000만원");
    expect(html.match(/33.33%/g)).toHaveLength(3);
    expect(html).toContain("부분월");
    expect(html).toContain("원본 O1 연구 성과와 구분");
    expect(html).toContain("첫 세션 대기");
    expect(html).not.toContain("독립 기준 장부의 수요");
  });
  it("uses actual calendar-date range for the history, leaving latest holdings explicitly scoped", async () => {
    const ledger = await createIntegratedAllocationShadow("S07", { codeHash: hash });
    const record = {
      id: "a",
      type: "SESSION" as const,
      date: "2026-10-13",
      sourceHash: hash,
      fills: [
        {
          market: "K" as const,
          symbol: "A",
          side: "BUY" as const,
          quantity: "1",
          price: "100",
          grossKrw: "100",
          feeKrw: "0.15",
          reason: "test",
        },
      ],
      cancelledBuys: [],
      transfers: [],
      issues: [],
    };
    ledger.receipts.push({ id: "a", inputHash: hash, record });
    const excluded = renderToStaticMarkup(
      <IntegratedAllocationShadowContent
        ledger={ledger}
        period={{ from: "2026-10-14", to: "2026-10-15" }}
      />,
    );
    expect(excluded).toContain("선택 기간 기록 없음");
    expect(excluded).not.toContain("A BUY");
    const included = renderToStaticMarkup(
      <IntegratedAllocationShadowContent
        ledger={ledger}
        period={{ from: "2026-10-13", to: "2026-10-13" }}
      />,
    );
    expect(included).toContain("A BUY 1주");
    expect(included).toContain("최신 완료 세션 기준");
    expect(included).toContain("60/20/20 정적 초기배분");
  });
});
