import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { loadUsPortfolioTrades, type UsPortfolioTradeRecord } from "@/lib/usProspectiveCloud";

const labels: Record<string, string> = {
  A0_QUARTER_PRIMARY: "A0 · β Anchor",
  A2_QUARTER_SHADOW: "A2",
  B3_BETA_SHADOW: "B3 Beta",
  SPY_BENCHMARK: "SPY",
};

export function UsModelTradeTable({
  trades,
  title = "모델 체결 원장",
}: {
  trades: UsPortfolioTradeRecord[];
  title?: string;
}) {
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border border-border bg-card">
      <div className="border-b p-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-[10px] text-muted-foreground">
          선택한 모델의 prospective 체결만 표시합니다. 실제 투자 내역은 통합 포트폴리오 탭에서
          별도로 관리합니다.
        </p>
      </div>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="모델 체결 원장 표">
        <table className="w-full min-w-[1000px] text-[10px]">
          <thead>
            <tr className="border-b text-muted-foreground [&>th]:px-2 [&>th]:py-2">
              <th>전략</th>
              <th>신호일</th>
              <th>체결일</th>
              <th>종목</th>
              <th>Side</th>
              <th>사유</th>
              <th>상태</th>
              <th className="text-right">모델가격</th>
              <th className="text-right">모델수량</th>
              <th>모델비용 USD</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.trade_key} className="border-b last:border-0 [&>td]:px-2 [&>td]:py-2">
                <td>{labels[t.strategy_id] ?? t.strategy_id}</td>
                <td>{t.signal_date}</td>
                <td>{t.execution_date ?? "-"}</td>
                <td className="font-medium">{t.symbol}</td>
                <td>{t.side}</td>
                <td>{t.reason}</td>
                <td>{t.status}</td>
                <td className="num text-right">
                  {t.model_price ? `$${t.model_price.toFixed(2)}` : "-"}
                </td>
                <td className="num text-right">{t.model_shares ?? "-"}</td>
                <td className="num text-right">${Number(t.fee_usd).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {trades.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">
            선택한 전략의 모델 체결 기록이 없습니다.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Reference-only A0 model fills beside actual-account controls. Never writes actual executions. */
export function UsModelExecutionJournal() {
  const query = useQuery({
    queryKey: ["us-portfolio-trades"],
    queryFn: () => loadUsPortfolioTrades(800),
    staleTime: 60_000,
    retry: false,
  });
  const trades = (query.data ?? []).filter(
    (trade) =>
      trade.strategy_id === "A0_QUARTER_PRIMARY" &&
      (trade.status === "EXECUTED" || trade.status === "PARTIAL"),
  );
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          실제 매수·매도 기록 시 참고하는 A0 모델 원장입니다. 실제 주문이나 체결 기록을 만들지
          않습니다.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          A0 원장 새로고침
        </Button>
      </div>
      {query.isError ? (
        <p role="alert" className="rounded border border-destructive p-3 text-sm">
          A0 모델 체결 조회 실패 · 기록 0건을 뜻하지 않습니다. 새로고침해 주세요.
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          A0 모델 체결을 불러오는 중입니다.
        </p>
      ) : null}
      {query.data ? <UsModelTradeTable trades={trades} title="A0 모델 체결 원장" /> : null}
      <p className="text-xs text-muted-foreground">
        최근 조회된 모델 체결만 표시합니다. 보유·성과·세금 비교와 이전 모델 기록은 Shadow에서
        확인합니다.
      </p>
    </div>
  );
}
