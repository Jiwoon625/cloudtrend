import { formatNumber } from "@/lib/format";
import type { BacktestResult } from "@/lib/engine/backtestV4";

const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "-"
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const rate = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v.toFixed(1)}%`;

const ic = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(3);

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border bg-surface-strong px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function BacktestV5Results({ result }: { result: BacktestResult }) {
  const featureLabel = new Map(result.features.map((f) => [f.id, f.label]));

  return (
    <>
      <Panel
        title="Score Threshold Onset"
        note="score[t-1] < threshold && score[t] >= threshold. 점수가 이미 높은 상태를 반복 집계하지 않고 최초 상향 돌파 이벤트만 비교합니다."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">진입 이벤트</th>
                <th className="px-2 py-1.5 text-right">보유</th>
                <th className="px-2 py-1.5 text-right">n</th>
                <th className="px-2 py-1.5 text-right">평균</th>
                <th className="px-2 py-1.5 text-right">시장초과</th>
                <th className="px-2 py-1.5 text-right">전체 대비</th>
                <th className="px-2 py-1.5 text-right">중앙</th>
                <th className="px-2 py-1.5 text-right">승률</th>
                <th className="px-2 py-1.5 text-right">평균 이익</th>
                <th className="px-2 py-1.5 text-right">평균 손실</th>
              </tr>
            </thead>
            <tbody>
              {result.scoreOnsets.map((r, i) => (
                <tr
                  key={`${r.threshold}-${r.horizon}`}
                  className={
                    i === 0 || result.scoreOnsets[i - 1]?.threshold !== r.threshold
                      ? "border-t-2 border-border"
                      : "border-t border-border/50"
                  }
                >
                  <td className="px-2 py-1.5 font-medium">
                    {i === 0 || result.scoreOnsets[i - 1]?.threshold !== r.threshold
                      ? `${r.threshold}점 돌파`
                      : ""}
                  </td>
                  <td className="num px-2 py-1.5 text-right">{r.horizon}D</td>
                  <td className="num px-2 py-1.5 text-right">{r.count.toLocaleString("ko-KR")}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.marketAdjustedAvgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.edgeVsAll)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.medianReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{rate(r.winRate)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgWin)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgLoss)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={`Score Ranking · ${result.rankIcSummary.horizon}D`}
        note="매 관측일의 종목별 score와 forward return의 Spearman Rank IC를 계산합니다. 시장조정 IC를 우선 해석합니다."
      >
        <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["평균 Raw Rank IC", ic(result.rankIcSummary.avgRawRankIc)],
            ["평균 시장조정 Rank IC", ic(result.rankIcSummary.avgMarketAdjustedRankIc)],
            ["시장조정 IC 양(+) 날짜", rate(result.rankIcSummary.marketAdjustedPositiveRate)],
            ["Rank IC 관측일", `${result.rankIcSummary.dates.toLocaleString("ko-KR")}일`],
            [`Top ${result.topSelection.topN} 평균`, pct(result.topSelection.avgReturn)],
            [`Top ${result.topSelection.topN} 시장초과`, pct(result.topSelection.marketAdjustedAvgReturn)],
            [`Top ${result.topSelection.topN} 중앙`, pct(result.topSelection.medianReturn)],
            [`Top ${result.topSelection.topN} 승률`, rate(result.topSelection.winRate)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground">{label}</p>
              <p className="num text-[13px] font-semibold">{value}</p>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">구분</th>
                <th className="px-2 py-1.5 text-right">날짜</th>
                <th className="px-2 py-1.5 text-right">Top 평균</th>
                <th className="px-2 py-1.5 text-right">Bottom 평균</th>
                <th className="px-2 py-1.5 text-right">Raw Spread</th>
                <th className="px-2 py-1.5 text-right">Top 시장초과</th>
                <th className="px-2 py-1.5 text-right">Bottom 시장초과</th>
                <th className="px-2 py-1.5 text-right">Top-Bottom Alpha</th>
                <th className="px-2 py-1.5 text-right">Robust t</th>
                <th className="px-2 py-1.5 text-right">95% CI</th>
              </tr>
            </thead>
            <tbody>
              {result.quantileSpreads.map((q) => (
                <tr key={q.bucketCount} className="border-t border-border">
                  <td className="px-2 py-1.5 font-medium">
                    {q.bucketCount === 5 ? "5분위" : q.bucketCount === 10 ? "10분위" : `${q.bucketCount}분위`}
                  </td>
                  <td className="num px-2 py-1.5 text-right">{q.dates.toLocaleString("ko-KR")}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(q.topAvgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(q.bottomAvgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(q.rawSpread)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(q.topMarketAdjustedAvgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(q.bottomMarketAdjustedAvgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{pct(q.marketAdjustedSpread)}</td>
                  <td className="num px-2 py-1.5 text-right">{formatNumber(q.robustTStat, 2)}</td>
                  <td className="num whitespace-nowrap px-2 py-1.5 text-right">
                    {pct(q.ci95Low)} ~ {pct(q.ci95High)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={`날짜별 Top ${result.topSelection.topN} 종목 성과`}
        note={`${result.topSelection.horizon}D forward return. 각 관측일에 score 상위 종목을 동일가중으로 선택한 결과이며 NAV 복리수익률이 아닙니다.`}
      >
        <div className="max-h-[420px] overflow-auto print:max-h-none print:overflow-visible">
          <table className="w-full min-w-[820px] text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">날짜</th>
                <th className="px-2 py-1.5 text-left">종목</th>
                <th className="px-2 py-1.5 text-right">평균점수</th>
                <th className="px-2 py-1.5 text-right">평균수익</th>
                <th className="px-2 py-1.5 text-right">시장수익</th>
                <th className="px-2 py-1.5 text-right">시장초과</th>
              </tr>
            </thead>
            <tbody>
              {result.topSelection.dateReturns.map((r) => (
                <tr key={r.date} className="border-t border-border/60">
                  <td className="px-2 py-1.5">{r.date}</td>
                  <td className="px-2 py-1.5">{r.symbols.join(", ")}</td>
                  <td className="num px-2 py-1.5 text-right">{formatNumber(r.avgScore, 1)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.benchmarkAvgReturn)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.marketAdjustedAvgReturn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="날짜별 Rank IC"
        note="PDF 저장 시에도 모든 날짜가 출력됩니다. 화면에서는 스크롤 영역으로 표시합니다."
      >
        <div className="max-h-[360px] overflow-auto print:max-h-none print:overflow-visible">
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">날짜</th>
                <th className="px-2 py-1.5 text-right">종목수</th>
                <th className="px-2 py-1.5 text-right">Raw Rank IC</th>
                <th className="px-2 py-1.5 text-right">시장조정 Rank IC</th>
              </tr>
            </thead>
            <tbody>
              {result.rankIcByDate.map((r) => (
                <tr key={r.date} className="border-t border-border/60">
                  <td className="px-2 py-1.5">{r.date}</td>
                  <td className="num px-2 py-1.5 text-right">{r.observations.toLocaleString("ko-KR")}</td>
                  <td className="num px-2 py-1.5 text-right">{ic(r.rawRankIc)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{ic(r.marketAdjustedRankIc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className="print-only rounded-lg border border-border bg-card p-3">
        <h2 className="mb-2 text-sm font-semibold">V5 실행 설정</h2>
        <table className="mb-4 w-full text-[10px]">
          <tbody>
            <tr className="border-b border-border">
              <td className="px-2 py-1">기준 보유기간 / 관측간격</td>
              <td className="px-2 py-1 text-right">{result.config.horizonDays}D / {result.config.sampleEvery}D</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-2 py-1">Forward horizons</td>
              <td className="px-2 py-1 text-right">{result.config.horizons.join(", ")}D</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-2 py-1">진입 기준 / Score Onset</td>
              <td className="px-2 py-1 text-right">{result.config.entryScore}점 / {result.config.scoreOnsetThresholds.join(", ")}점</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-2 py-1">Ranking</td>
              <td className="px-2 py-1 text-right">{result.config.rankingHorizon}D · Top {result.config.topSelectionCount} · {result.config.rankingQuantileBuckets.join("/")}분위</td>
            </tr>
            {result.config.features.map((id) => (
              <tr key={id} className="border-b border-border/60">
                <td className="px-2 py-1">{featureLabel.get(id) ?? id}</td>
                <td className="num px-2 py-1 text-right">weight {result.config.weights[id] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 className="mb-1 text-sm font-semibold">전체 결과 원본</h2>
        <p className="mb-2 text-[9px] text-muted-foreground">
          화면의 선택형 표에서 숨겨질 수 있는 horizon/분포/민감도 값을 포함해 BacktestResult 전체를 PDF 부록에 남깁니다.
        </p>
        <pre className="print-json text-[7px] leading-tight">{JSON.stringify(result, null, 2)}</pre>
      </section>
    </>
  );
}
