import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HISTORICAL_TECHNICAL_MAX } from "@/lib/engine/scoring";
import { getCachedInstrumentChart, INSTRUMENT_CHART_VERSION } from "@/lib/screeningCache";
import type { InstrumentChartRange } from "@/lib/engine/instrumentChart";
import type { AnalysisPayload } from "@/lib/market.functions";
import { formatPrice } from "@/lib/format";
import {
  Bar,
  Brush,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function InstrumentCharts({
  symbol,
  payload,
  revision,
}: {
  symbol: string;
  payload: AnalysisPayload;
  revision: number;
}) {
  const [range, setRange] = useState<InstrumentChartRange>("120");
  const [visible, setVisible] = useState({ technical: true });
  const query = useQuery({
    queryKey: ["instrument-chart", INSTRUMENT_CHART_VERSION, symbol, revision, range],
    queryFn: () => getCachedInstrumentChart(symbol, range, payload),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const chart = query.data?.chart ?? [];
  const history = query.data?.history ?? [];
  const snap = payload.analysis.rows.find((row) => row.instrument.symbol === symbol)!.snapshot;
  return (
    <>
      <section className="mt-5 rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">가격 · 지표 차트 (일봉)</h2>
          <div className="flex flex-wrap gap-1">
            {(["120", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
                className={`rounded border px-2 py-0.5 text-[11px] ${range === value ? "border-primary/40 bg-info-soft text-info" : "border-border text-muted-foreground"}`}
              >
                {value === "120" ? "최근 120거래일" : "전체 기간"}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={visible.technical}
              onClick={() => setVisible((v) => ({ ...v, technical: !v.technical }))}
              className={`rounded border px-2 py-0.5 text-[11px] ${visible.technical ? "border-primary/40 bg-info-soft text-info" : "border-border text-muted-foreground"}`}
            >
              기술점수 (10점)
            </button>
          </div>
        </div>
        {query.isPending ? (
          <div
            className="flex h-[420px] items-center justify-center text-sm text-muted-foreground"
            role="status"
          >
            차트 데이터를 불러오는 중입니다…
          </div>
        ) : query.isError ? (
          <div className="p-4" role="alert">
            <p>차트를 불러오지 못했습니다.</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              다시 시도
            </Button>
          </div>
        ) : !chart.length ? (
          <p className="p-4">표시할 차트 데이터가 없습니다.</p>
        ) : (
          <div className="h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart}>
                <CartesianGrid stroke="var(--color-grid)" vertical={false} />
                <XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={40} />
                <YAxis
                  yAxisId="price"
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 10 }}
                  width={70}
                  tickFormatter={(v: number) => v.toLocaleString("ko-KR")}
                />
                <YAxis yAxisId="volume" orientation="right" hide />
                {visible.technical ? (
                  <YAxis
                    yAxisId="technical"
                    orientation="right"
                    domain={[0, HISTORICAL_TECHNICAL_MAX]}
                    ticks={[0, 2, 4, 6, 8, 10]}
                    width={48}
                    tick={{ fontSize: 10, fill: "#f97316" }}
                    tickFormatter={(v: number) => `${v}점`}
                  />
                ) : null}
                <Tooltip
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    fontSize: 11,
                  }}
                  formatter={(v, name, item) => {
                    if (item.dataKey === "historicalTechnicalPoints") {
                      const s = item.payload.historicalTechnical;
                      return [
                        <span>
                          {Number(v).toFixed(1)} / {s.rawMaxPoints}점
                          <br />
                          산정 가능 배점 {s.availableMaxPoints} / {s.rawMaxPoints}점
                          {s.missingRules.length > 0 ? (
                            <>
                              <br />
                              자료 부족: {s.missingRules.join(", ")}
                            </>
                          ) : null}
                        </span>,
                        name,
                      ];
                    }
                    return typeof v === "number" ? v.toLocaleString("ko-KR") : v;
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar
                  yAxisId="volume"
                  dataKey="volume"
                  fill="var(--color-grid)"
                  isAnimationActive={false}
                  name="거래량"
                />
                <Line
                  yAxisId="price"
                  dataKey="close"
                  stroke="var(--color-foreground)"
                  dot={false}
                  strokeWidth={1.6}
                  isAnimationActive={false}
                  name="종가"
                />
                {visible.technical ? (
                  <Line
                    yAxisId="technical"
                    dataKey="historicalTechnicalPoints"
                    name="기술점수 (V8 Final · 10점)"
                    type="linear"
                    stroke="#f97316"
                    strokeWidth={2.5}
                    strokeDasharray="6 3"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ) : null}
                <Brush
                  dataKey="tradeDate"
                  height={22}
                  travellerWidth={8}
                  stroke="var(--color-border)"
                  fill="var(--color-surface)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          기본은 최근 120거래일입니다. 이전 구간은 전체 기간을 선택한 뒤 하단 막대로 확인하세요.
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          오른쪽 축은 V8 Final 기술점수 0~10점입니다. 52주 신고가, 외국인 20일 순매수와 Sector Price
          Leadership 0.5점 슬롯을 포함하며, 핵심 피처가 결측인 날짜는 남은 항목으로 재정규화하지
          않고 선을 비워 둡니다.
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          ATR 손절선 참고: {formatPrice(snap.close - 1.8 * (snap.atr14 ?? 0))} (진입가 기준 1.8 ATR)
          · 52주 신고가 {formatPrice(snap.high52w)}
        </p>
      </section>

      {history.length > 0 ? (
        <>
          <section className="mt-5 rounded-lg border border-border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">최근 60거래일 기술점수 추이 (10점)</h2>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={history}>
                  <CartesianGrid stroke="var(--color-grid)" vertical={false} />
                  <XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis
                    domain={[0, HISTORICAL_TECHNICAL_MAX]}
                    ticks={[0, 2, 4, 6, 8, 10]}
                    tick={{ fontSize: 10 }}
                    width={30}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      fontSize: 11,
                    }}
                  />
                  <Line
                    dataKey="technicalPoints"
                    stroke="var(--color-chart-1)"
                    dot={false}
                    name="기술점수"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
