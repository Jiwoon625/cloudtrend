import {
  OPERATING_BACKTESTS,
  formatBacktestRatio,
  formatBacktestPercentagePoints,
  isBenchmarkComparisonReady,
  isOperatingBacktestReleaseReady,
  isPortfolioAnnualReturnsReady,
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
  const annual = summary.portfolioAnnualReturns;
  const annualReady = ready && isPortfolioAnnualReturnsReady(annual, summary.book);
  const benchmark = summary.benchmarkComparison;
  const benchmarkReady = ready && isBenchmarkComparisonReady(summary);
  const metrics = [
    ["매매 평균수익률", summary.meanReturn],
    ["매매 중앙값", summary.medianReturn],
    ["계좌 MDD", summary.mdd],
  ] as const;
  const portfolioMetrics = [
    [
      "포트폴리오 평균수익률",
      annualReady && annual?.meanReturn !== null ? formatBacktestRatio(annual!.meanReturn!) : "—",
    ],
    [
      "포트폴리오 중앙값",
      annualReady && annual?.medianReturn !== null
        ? formatBacktestRatio(annual!.medianReturn!)
        : "—",
    ],
    [
      "전체기간 지수 대비",
      benchmarkReady ? formatBacktestPercentagePoints(benchmark!.excessReturn) : "—",
    ],
  ] as const;

  return (
    <section aria-label={`${market} 백테스트 성과`} className="space-y-3 border-t pt-3">
      <div className="space-y-1">
        <p className="font-medium">백테스트 전체기간 성과</p>
        <p className="text-xs text-muted-foreground">{summary.scopeLabel}</p>
        <p className="text-xs text-muted-foreground">연초 예산 연구 기준 · 운영 엔진 연결 전</p>
      </div>
      <dl aria-label="개별매매 수익률과 계좌 최대낙폭" className="grid grid-cols-3 gap-2">
        {metrics.map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col rounded-md bg-muted/50 px-1 py-2 sm:px-2"
          >
            <dt className="min-h-8 text-[11px] leading-4 text-muted-foreground">{label}</dt>
            <dd className="mt-auto whitespace-nowrap pt-1 text-[11px] font-semibold tabular-nums min-[360px]:text-xs sm:text-sm">
              {ready && value !== null ? formatBacktestRatio(value) : "—"}
            </dd>
          </div>
        ))}
      </dl>
      <dl aria-label="포트폴리오 성과" className="grid grid-cols-3 gap-2">
        {portfolioMetrics.map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col rounded-md bg-muted/50 px-1 py-2 sm:px-2"
          >
            <dt className="min-h-8 text-[11px] leading-4 text-muted-foreground">{label}</dt>
            <dd className="mt-auto whitespace-nowrap pt-1 text-[11px] font-semibold tabular-nums min-[360px]:text-xs sm:text-sm">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {annualReady && annual ? (
        <p className="text-xs text-muted-foreground">
          포트폴리오 평균·중앙값: {annual.years[0]!.year}–{annual.years.at(-1)!.year} 연간수익률 ·
          부분연도 제외
        </p>
      ) : null}
      {benchmarkReady && benchmark ? (
        <p className="text-xs text-muted-foreground">
          지수 대비: {benchmark.label} · 전체기간 누적수익률 차이(%p)
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">동일기간 지수 비교 검증 후 표시합니다.</p>
      )}
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
              <p>
                포트폴리오 평균과 중앙값은 비용 차감 후 계좌의 완전한 달력연도별 수익률을 등가중
                집계합니다. 시작·종료 부분연도는 제외하며 복리 연평균수익률이 아닙니다.
              </p>
              {benchmarkReady && benchmark ? (
                <>
                  <p>
                    지수 대비는 {benchmark.startDate}–{benchmark.endDate} 동안 포트폴리오
                    누적수익률에서 {benchmark.label} 누적수익률을 뺀 퍼센트포인트 차이입니다.
                    연간수익률 평균·중앙값과 달리 부분연도를 포함한 전체 연구기간을 비교합니다.
                  </p>
                  <p>{benchmark.limitation}</p>
                </>
              ) : null}
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
