import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useScoringConfig } from "@/lib/scoringConfigStore";
import { instrumentChartQueryRevision, useInstrumentChartOwner } from "@/lib/instrumentChartCache";
import {
  getCachedEtfInstrumentChart,
  getCachedEtfInstrumentPrices,
  ETF_INSTRUMENT_CHART_VERSION,
} from "@/lib/screeningCache";
import type { EtfInstrumentChartBundle } from "@/lib/engine/etfInstrumentChart";
import type { InstrumentChartRange } from "@/lib/engine/instrumentChart";
import type { AnalysisPayload } from "@/lib/marketPayload";
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

const tooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  fontSize: 11,
};
const numberLabel = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export function EtfUnderlyingTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: EtfInstrumentChartBundle["underlying"][number] }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded border border-border bg-card p-2 text-[11px]">
      <p>
        {point.tradeDate} · {point.name ?? "당시 지수명 미확인"}
      </p>
      <p>기초지수 종가 {point.close === null ? "미관측" : numberLabel(point.close)}</p>
      <p>MA60 {point.ma60 === null ? "미관측" : numberLabel(point.ma60)}</p>
      {point.identityBreak ? (
        <p className="text-muted-foreground">지수명 변경·미확인 구간</p>
      ) : null}
    </div>
  );
}

export function EtfChartLoadingStatus({
  phase,
  range,
}: {
  phase: "owner" | "prices" | "m0";
  range: InstrumentChartRange;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="text-xs text-muted-foreground" role="status">
      <p>
        {phase === "owner"
          ? "차트 접근 권한 확인 중…"
          : phase === "prices"
            ? "ETF 가격·거래량을 불러오는 중…"
            : "가격·거래량 표시 완료 · M0·기초지수 준비 중…"}
      </p>
      <p className="mt-1" aria-hidden="true">
        {elapsed}초 경과
      </p>
      {elapsed >= 15 ? (
        <p className="mt-1">응답이 지연되고 있습니다. 자료 확인이 끝나면 차트에 반영됩니다.</p>
      ) : range === "all" ? (
        <p className="mt-1">전체 관측 기간을 처음 불러올 때는 시간이 더 걸릴 수 있습니다.</p>
      ) : null}
    </div>
  );
}

export default function EtfInstrumentCharts({
  symbol,
  payload,
  renderSummary,
}: {
  symbol: string;
  payload: AnalysisPayload;
  renderSummary?: (bundle: EtfInstrumentChartBundle | undefined) => ReactNode;
}) {
  const [range, setRange] = useState<InstrumentChartRange>("120");
  const [showM0, setShowM0] = useState(true);
  const [config] = useScoringConfig();
  const { owner, authError, retryOwner } = useInstrumentChartOwner();
  const revision = instrumentChartQueryRevision(payload);
  const priceQuery = useQuery({
    queryKey: [
      "etf-instrument-chart",
      ETF_INSTRUMENT_CHART_VERSION,
      owner,
      symbol,
      revision,
      config,
      range,
      "prices",
    ],
    queryFn: () => getCachedEtfInstrumentPrices(symbol, range, payload),
    enabled: owner !== null,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  const query = useQuery({
    queryKey: [
      "etf-instrument-chart",
      ETF_INSTRUMENT_CHART_VERSION,
      owner,
      symbol,
      revision,
      config,
      range,
      "m0",
    ],
    queryFn: () => getCachedEtfInstrumentChart(symbol, range, payload),
    enabled: owner !== null,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  // Query keys isolate owner, payload, configuration and range. Never carry a previous owner's data.
  const bundle = owner && !authError ? query.data : undefined;
  const chart =
    (bundle?.chart.length ? bundle.chart : undefined) ??
    (owner && !authError ? priceQuery.data?.chart : undefined) ??
    [];
  const underlying = (bundle?.underlying ?? [])
    .filter(
      (point) =>
        !!bundle?.underlyingAsOfDate &&
        point.tradeDate <= bundle.underlyingAsOfDate &&
        (!bundle.underlyingFirstDate || point.tradeDate >= bundle.underlyingFirstDate),
    )
    .map((point) => ({ ...point, plotClose: point.identityBreak ? null : point.close }));
  const loading = query.isFetching || priceQuery.isFetching || (!owner && !authError);
  const progressKey = `${owner}:${symbol}:${revision}:${range}`;
  const retry = () => {
    if (authError) {
      retryOwner();
      return;
    }
    void priceQuery.refetch();
    void query.refetch();
  };
  const etfAsOfDate = bundle?.asOfDate ?? payload.analysis.asOfDate;
  const underlyingAsOfDate = bundle?.underlyingAsOfDate;
  return (
    <>
      {renderSummary?.(bundle)}
      <section
        className="min-w-0 rounded-lg border border-border bg-card p-3 sm:p-4"
        aria-label="ETF 가격·M0·기초지수 차트"
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">가격 · 거래량 · M0 총점</h2>
          <div className="flex flex-wrap gap-1" role="group" aria-label="차트 표시 설정">
            {(["120", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
                className={`rounded border px-2 py-1 text-[11px] ${range === value ? "border-primary/40 bg-info-soft text-info" : "border-border text-muted-foreground"}`}
              >
                {value === "120" ? "최근 120거래일" : "전체 기간"}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={showM0}
              onClick={() => setShowM0((visible) => !visible)}
              className={`rounded border px-2 py-1 text-[11px] ${showM0 ? "border-primary/40 bg-info-soft text-info" : "border-border text-muted-foreground"}`}
            >
              M0 총점 (100점)
            </button>
          </div>
        </div>
        {!chart.length && loading ? (
          <div className="flex h-48 items-center justify-center">
            <EtfChartLoadingStatus
              key={progressKey}
              phase={owner ? "prices" : "owner"}
              range={range}
            />
          </div>
        ) : !chart.length && (authError || query.isError || priceQuery.isError) ? (
          <div className="space-y-2 py-4 text-xs" role="alert">
            <p>ETF 차트를 불러오지 못했습니다.</p>
            <p className="text-muted-foreground">
              {authError ?? query.error?.message ?? priceQuery.error?.message}
            </p>
            <Button variant="outline" size="sm" onClick={retry}>
              다시 시도
            </Button>
          </div>
        ) : !chart.length ? (
          <p className="py-4 text-xs text-muted-foreground">표시할 ETF 가격 자료가 없습니다.</p>
        ) : (
          <div className="h-[300px] min-w-0 sm:h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chart}
                accessibilityLayer
                margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
              >
                <CartesianGrid stroke="var(--color-grid)" vertical={false} />
                <XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={45} />
                <YAxis
                  yAxisId="price"
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 10 }}
                  width={58}
                  tickFormatter={numberLabel}
                />
                <YAxis yAxisId="volume" hide domain={[0, (dataMax: number) => dataMax * 5]} />
                {showM0 ? (
                  <YAxis
                    yAxisId="m0"
                    orientation="right"
                    domain={[0, 100]}
                    ticks={[0, 20, 40, 60, 80, 100]}
                    width={39}
                    tick={{ fontSize: 10, fill: "#f97316" }}
                    tickFormatter={(value: number) => `${value}점`}
                  />
                ) : null}
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value, name, item) =>
                    item.dataKey === "m0Score"
                      ? [`${Number(value).toFixed(1)} / 100점`, name]
                      : typeof value === "number"
                        ? numberLabel(value)
                        : value
                  }
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
                  strokeWidth={1.6}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                  name="ETF 종가"
                />
                {showM0 ? (
                  <Line
                    yAxisId="m0"
                    dataKey="m0Score"
                    name="M0 총점 (100점)"
                    type="linear"
                    stroke="#f97316"
                    strokeWidth={2}
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
        {chart.length > 0 && query.isFetching && !bundle ? (
          <div className="mt-2">
            <EtfChartLoadingStatus key={`${progressKey}:m0`} phase="m0" range={range} />
          </div>
        ) : null}
        {chart.length > 0 && query.isError ? (
          <div role="alert" className="mt-2 space-y-2 text-xs">
            <p>M0·기초지수 자료를 불러오지 못했습니다. {query.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              M0·기초지수 다시 시도
            </Button>
          </div>
        ) : null}
        {chart.length > 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            오른쪽 축은 구성요소를 합산한 M0 총점(100점)입니다. 과거 M0는 날짜별 원자료로 계산하며,
            미확정·결측 구간은 비워 둡니다.
          </p>
        ) : null}
        {bundle ? (
          <div className="mt-4 border-t border-border pt-3" aria-label="실제 기초지수와 MA60">
            <h3 className="text-sm font-semibold">기초지수 · MA60</h3>
            {underlying.length > 0 && underlyingAsOfDate ? (
              <>
                <p className="mt-1 break-words text-[11px] text-muted-foreground">
                  기초지수 (최근 관측: {bundle.underlyingName ?? "지수명 미확인"})
                  {bundle.underlyingSource
                    ? ` · 출처 ${bundle.underlyingSource === "KRX_ETF" ? "KRX 관측" : bundle.underlyingSource}`
                    : ""}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  ETF 기준일 {etfAsOfDate} · 기초지수 최종 관측 {underlyingAsOfDate}
                  {underlyingAsOfDate < etfAsOfDate ? " (ETF보다 이전)" : ""}
                </p>
                <div className="mt-2 h-[230px] min-w-0 sm:h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={underlying}
                      accessibilityLayer
                      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid stroke="var(--color-grid)" vertical={false} />
                      <XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={45} />
                      <YAxis
                        domain={["auto", "auto"]}
                        tick={{ fontSize: 10 }}
                        width={58}
                        tickFormatter={numberLabel}
                      />
                      <Tooltip content={<EtfUnderlyingTooltip />} filterNull={false} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        dataKey="plotClose"
                        name="기초지수 종가"
                        stroke="var(--color-foreground)"
                        strokeWidth={1.6}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                      <Line
                        dataKey="ma60"
                        name="MA60"
                        stroke="var(--color-chart-1)"
                        strokeWidth={1.6}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
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
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {range === "all" ? "전체 관측 기간" : "표시 기간"}{" "}
                  {range === "all"
                    ? (bundle.underlyingFirstDate ?? underlying[0]?.tradeDate)
                    : underlying[0]?.tradeDate}{" "}
                  ~ {underlyingAsOfDate}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  지수명 변경·미확인 또는 결측 구간에서는 MA60을 비워 둡니다.
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                실제 기초지수 시계열이 없어 차트를 표시할 수 없습니다.
              </p>
            )}
          </div>
        ) : null}
        <p className="mt-2 text-[11px] text-muted-foreground">
          두 차트에 같은 기간을 적용합니다. 전체 기간을 선택하면 최초 관측부터 확인할 수 있습니다.
        </p>
      </section>
    </>
  );
}
