import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KrxReviewReferenceDetails } from "./KrxReviewReferenceDetails";
import { selectKrxReviewReference } from "@/lib/krxReviewReference";

describe("KRX reference presentation", () => {
  it("labels actual prior dates, per-field dates and missing facts explicitly", () => {
    const reference = selectKrxReviewReference(
      [{ date: "2026-10-08", source: "KRX_ETF", values: { nav: 10000, tradingValue: 0 } }],
      "2026-10-12",
    );
    const html = renderToStaticMarkup(<KrxReviewReferenceDetails reference={reference} etf />);
    expect(html).toContain("직전 KRX 참고값");
    expect(html).toContain("기준일 2026-10-08");
    expect(html).toContain("0원 · 2026-10-08 (직전 참고)");
    expect(html).toContain("미수신 / 기준일 미확인");
    expect(html).toContain("당일 자격·점수·진입 판단에 대입하지 않습니다");
    expect(html).not.toContain("2026-10-12 (당일)");
  });
  it("replaces the reference date on current arrival and handles legacy caches", () => {
    const reference = selectKrxReviewReference(
      [{ date: "2026-10-12", source: "KRX_STOCK", values: { marketCap: 1e11, listedShares: 100 } }],
      "2026-10-12",
    );
    const html = renderToStaticMarkup(<KrxReviewReferenceDetails reference={reference} />);
    expect(html).toContain("기준일 2026-10-12");
    expect(html).toContain("(당일)");
    expect(html).not.toContain("직전 KRX 참고값");
    expect(renderToStaticMarkup(<KrxReviewReferenceDetails />)).toContain("미수신 / 기준일 미확인");
  });
});
