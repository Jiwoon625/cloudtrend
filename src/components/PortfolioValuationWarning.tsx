import type { StrategyLedger } from "@/lib/portfolioLedgers";

export function PortfolioValuationWarning({
  strategy,
}: {
  strategy: StrategyLedger | null | undefined;
}) {
  if (!strategy?.valuationReference) return null;
  return (
    <div
      role="alert"
      className="my-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
    >
      <p className="font-medium">종가 결측 · 현재 평가·수익률·종가 신호 미확정</p>
      <p>
        현금과 보유수량은 유지됩니다. 이전 유효가격 또는 매입가의 참고평가는 확정 NAV·수익률이
        아닙니다.
      </p>
      <ul className="mt-1">
        {Object.entries(strategy.valuationReference.marks).map(([symbol, mark]) => (
          <li key={symbol}>
            {symbol} · 참고가격 {mark.price.toLocaleString("ko-KR")}원 · {mark.date}{" "}
            {mark.source === "PREVIOUS_CLOSE" ? "종가" : "매입가"}
          </li>
        ))}
      </ul>
    </div>
  );
}
