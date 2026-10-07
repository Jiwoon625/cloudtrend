import type { PortfolioLedgerViewState } from "@/lib/portfolioFreshness";
import { buildKrPendingEntryPreview } from "@/lib/portfolioPendingEntries";
import { formatKstDateTime } from "@/lib/format";

/** Small authenticated dashboard projection; model expectations never alter actual positions. */
export function PortfolioFreshnessSummary({
  state,
  screeningDate,
  pending,
  error,
}: {
  state: PortfolioLedgerViewState | null;
  screeningDate: string;
  pending: boolean;
  error: boolean;
}) {
  const strategy = state?.document.strategy;
  const failed = error || state?.strategyRefresh?.status === "FAILED";
  const preview = buildKrPendingEntryPreview(strategy, {
    actualExecutions: state?.document.executions ?? [],
  });
  const portfolioDate = strategy?.summary.latestDate;
  return (
    <div className="mt-3 border-t border-border pt-2 text-[11px]" aria-label="포트폴리오 갱신 상태">
      <p
        className={failed ? "text-destructive" : "text-muted-foreground"}
        role={failed ? "alert" : undefined}
      >
        {failed
          ? "포트폴리오 조회 실패 · 최신 상태 미확인"
          : pending
            ? "포트폴리오 확인 중…"
            : !strategy
              ? "포트폴리오 계산 결과 없음"
              : portfolioDate === screeningDate
                ? `스크리닝 ${screeningDate} · 포트폴리오 시세 기준일 일치`
                : `스크리닝 ${screeningDate} · 포트폴리오 시세 ${portfolioDate ?? "미확인"}`}
      </p>
      {strategy ? (
        <p className="mt-1 text-muted-foreground">
          모델 계산 {formatKstDateTime(strategy.calculatedAt)} · 입력이 같으면 저장 결과 재사용
        </p>
      ) : null}
      {preview.rows.length ? (
        <>
          <p className="mt-2 font-medium">
            모델 진입 예정 {preview.rows.length}종목 · 오늘 {preview.todayCount}종목
          </p>
          <ul className="mt-1 space-y-1">
            {preview.rows.map((row) => (
              <li key={row.key}>
                <span className="font-medium">{row.name}</span> · {row.label}
                <span className="block text-muted-foreground">{row.actualLabel}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">
            시가 미확인 · 예정 종목은 실제 보유·체결 수에 포함하지 않습니다
          </p>
        </>
      ) : null}
    </div>
  );
}
