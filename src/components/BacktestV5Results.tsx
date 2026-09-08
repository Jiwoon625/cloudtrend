import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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

const CHART_COLORS = [
  "var(--color-up)",
  "var(--color-info)",
  "var(--color-down)",
  "var(--color-warn)",
  "var(--color-accent, #8b5cf6)",
];

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
  const defaultDecay = ["NEAR_52W_HIGH", "BOLLINGER_BREAKOUT", "MA_ALIGNMENT"].filter((id) =>
    result.featureHorizons.some((f) => f.featureKey === id),
  );
  const [decayFeatures, setDecayFeatures] = useState<string[]>(defaultDecay);

  const toggleDecay = (id: string) =>
    setDecayFeatures((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-5),
    );

  const decayData = useMemo(
    () =>
      result.horizons.map((h) => {
        const row: Record<string, string | number | null> = { horizon: `${h}D` };
        for (const key of decayFeatures) {
          const feature = result.featureHorizons.find((f) => f.featureKey === key);
          row[key] =
            feature?.metrics.find((m) => m.horizon === h)?.marketAdjustedCrossSectionalEdge ?? null;
        }
        return row;
      }),
    [result, decayFeatures],
  );

  const thresholdChartData = useMemo(() => {
    const horizon = result.rankIcSummary.horizon;
    const thresholds = [...new Set(result.scoreOnsets.map((r) => r.threshold))].sort((a, b) => a - b);
    return thresholds.map((threshold) => ({
      threshold: `${threshold}점`,
      onset:
        result.scoreOnsets.find((r) => r.threshold === threshold && r.horizon === horizon)
          ?.marketAdjustedAvgReturn ?? null,
      state:
        result.entryThresholds.find((r) => r.threshold === threshold && r.horizon === horizon)
          ?.marketAdjustedAvgReturn ?? null,
    }));
  }, [result]);

  return (
    <>
      <Panel
        title="Feature Edge Decay"
        note="V4에서 사용하던 그래프를 복구했습니다. 시장조정 Cross-sectional Edge가 보유기간에 따라 유지·확대·소멸되는지 확인합니다."
      >
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap gap-2" data-no-print>
            {result.featureHorizons.map((fh) => {
              const on = decayFeatures.includes(fh.featureKey);
              return (
                <button
                  key={fh.featureKey}
                  type="button"
                  onClick={() => toggleDecay(fh.featureKey)}
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    on
                      ? "border-primary bg-primary/10"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {fh.featureLabel}
                </button>
              );
            })}
          </div>
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={decayData}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" />
                <XAxis dataKey="horizon" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="%" />
                <Tooltip />
                <ReferenceLine y={0} stroke="var(--color-border)" />
                {decayFeatures.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={result.featureHorizons.find((f) => f.featureKey === key)?.featureLabel ?? key}
                    stroke={CHART_COLORS[i % CHART_COLORS.length]}
                    strokeWidth={2}
                    dot
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Panel>

      <Panel
        title={`Score Threshold · ${result.rankIcSummary.horizon}D`}
        note="점수가 이미 threshold 이상인 상태(State)와 아래에서 처음 상향 돌파한 Onset의 시장초과수익률을 비교합니다."
      >
        <div className="p-3" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={thresholdChartData}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" />
              <XAxis dataKey="threshold" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} unit="%" />
              <Tooltip />
              <ReferenceLine y={0} stroke="var(--color-border)" />
              <Line
                type="monotone"
                dataKey="state"
                name="State 시장초과"
                stroke="var(--color-info)"
                strokeWidth={2}
                dot
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="onset"
                name="Onset 시장초과"
                stroke="var(--color-up)"
                strokeWidth={2}
                dot
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

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
                    {q.bucketCount === 5
                      ? "5분위"
                      : q.bucketCount === 10
                        ? "10분위"
                        : `${q.bucketCount}분위`}
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

      <div data-no-print>
        <Panel
          title={`날짜별 Top ${result.topSelection.topN} 종목 성과`}
          note={`${result.topSelection.horizon}D forward return. 화면에서는 상세 확인용으로 유지하고 PDF에는 포함하지 않습니다.`}
        >
          <div className="max-h-[420px] overflow-auto">
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
      </div>

      <div data-no-print>
        <Panel
          title="날짜별 Rank IC"
          note="화면 상세 확인용입니다. 313페이지 수준의 PDF 팽창을 막기 위해 날짜별 원시 행은 PDF에서 제외합니다."
        >
          <div className="max-h-[360px] overflow-auto">
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
      </div>
    </>
  );
}
