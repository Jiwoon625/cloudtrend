import {
  OPERATING_BACKTESTS,
  formatBacktestRatio,
  isOperatingBacktestReleaseReady,
  type OperatingBacktestRelease,
} from "@/lib/operatingBacktests";

export function OperatingBacktestMetrics({
  market,
  release = OPERATING_BACKTESTS,
}: {
  market: string;
  release?: OperatingBacktestRelease;
}) {
  const summary = release.books.find((book) => book.markets.includes(market));
  if (!summary) return null;
  const ready = isOperatingBacktestReleaseReady(release);
  const metrics = [
    ["평균수익률", summary.meanReturn],
    ["중앙값", summary.medianReturn],
    ["MDD", summary.mdd],
  ] as const;

  return (
    <section aria-label={`${market} 백테스트 성과`} className="space-y-3 border-t pt-3">
      <div className="space-y-1">
        <p className="font-medium">백테스트 전체기간 성과</p>
        <p className="text-xs text-muted-foreground">{summary.scopeLabel}</p>
        <p className="text-xs text-muted-foreground">연초 예산 연구 기준 · 운영 엔진 연결 전</p>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        {metrics.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-md bg-muted/50 px-2 py-2">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-semibold tabular-nums">
              {ready && value !== null ? formatBacktestRatio(value) : "—"}
            </dd>
          </div>
        ))}
      </dl>
      {ready ? (
        <>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {summary.startDate}–{summary.endDate} · {summary.currency} 기준
            </p>
            <p>
              청산완료 매매 {summary.closedTradeCount?.toLocaleString("ko-KR")}건 · 비용 차감 후
              평균·중앙값 · MDD는 전체 계좌
            </p>
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">검증 기준·주요 한계</summary>
            <div className="mt-2 space-y-2 leading-relaxed">
              <p>연구 정책: {summary.policyLabel}</p>
              <p className="break-all">
                기준 버전: {release.policyFamily} · {summary.policyVersion}
              </p>
              <p>
                연초 예산 연구 기준의 과거 검증입니다. 위 운영규칙의 현행 배분 설명과 구분하며, 운영
                엔진 연결 전입니다.
              </p>
              <p>{summary.returnDefinition}</p>
              <p>
                모델 가정 청산 {summary.proxyClosedTradeCount?.toLocaleString("ko-KR")}건 포함 ·
                미청산 {summary.excludedOpenPositionCount?.toLocaleString("ko-KR")}개 포지션 제외
              </p>
              <p>MDD는 미청산 보유분 평가를 포함한 전체기간 계좌 평가자산의 최대낙폭입니다.</p>
              <ul className="list-disc space-y-1 pl-4">
                {summary.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
              <p>과거 검증 결과이며 미래 수익을 보장하지 않습니다.</p>
            </div>
          </details>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          전체 시장의 청산완료 매매 수익률과 계좌 최대낙폭 검증 후 표시합니다.
        </p>
      )}
    </section>
  );
}
