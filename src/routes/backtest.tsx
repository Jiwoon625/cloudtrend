import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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

import { AppShell } from "@/components/AppShell";
import { BacktestDataInput } from "@/components/BacktestDataInput";
import { PdfExportButton } from "@/components/PdfExportButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { loadBacktestDataset } from "@/lib/backtestDataStore";
import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  DEFAULT_HORIZONS,
  DEFAULT_INTERVAL_CANDIDATES,
  VOLUME_SURGE_MODES,
  type BacktestParams,
  type BacktestResult,
  type BreakdownStat,
  type VolumeSurgeMode,
} from "@/lib/engine/backtestV4";
import { formatCount, formatNumber } from "@/lib/format";
import { computeLocalBacktest } from "@/lib/localAnalysis";
import {
  getManualDataMeta,
  hydrateManualData,
  type ManualDataMeta,
} from "@/lib/manualDataStore";

export const Route = createFileRoute("/backtest")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Backtest V4 | CloudTrend" },
      {
        name: "description",
        content:
          "KOSPI·KOSDAQ 시장수익률 조정, 시장국면, cross-sectional edge, Robust t/95% CI, 연도·시장·OOS 분해를 포함한 CloudTrend V4 피처 백테스트입니다.",
      },
    ],
  }),
  component: BacktestPage,
});

const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "-"
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const rate = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v.toFixed(1)}%`;
const edgeClass = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "text-muted-foreground";
  if (Math.abs(v) < 0.2) return "";
  return v > 0 ? "text-up" : "text-down";
};
const CHART_COLORS = [
  "var(--color-up)",
  "var(--color-info)",
  "var(--color-down)",
  "var(--color-warn)",
  "var(--color-accent, #8b5cf6)",
];

function Card({
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

function BreakdownTable({
  title,
  note,
  rows,
  featureOrder,
}: {
  title: string;
  note: string;
  rows: BreakdownStat[];
  featureOrder: string[];
}) {
  const segments = [...new Set(rows.map((r) => r.segment))];
  return (
    <Card title={title} note={note}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[12px]">
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left">구간</th>
              <th className="px-2 py-1.5 text-left">피처</th>
              <th className="px-2 py-1.5 text-right">표본</th>
              <th className="px-2 py-1.5 text-right">신호</th>
              <th className="px-2 py-1.5 text-right">Raw Edge</th>
              <th className="px-2 py-1.5 text-right">시장조정 Edge</th>
              <th className="px-2 py-1.5 text-right">X-sec 조정 Edge</th>
              <th className="px-2 py-1.5 text-right">Robust t</th>
              <th className="px-2 py-1.5 text-right">95% CI</th>
            </tr>
          </thead>
          <tbody>
            {segments.flatMap((segment) =>
              rows
                .filter((r) => r.segment === segment)
                .sort(
                  (a, b) =>
                    featureOrder.indexOf(a.featureKey) - featureOrder.indexOf(b.featureKey),
                )
                .map((r, i) => (
                  <tr
                    key={`${segment}-${r.featureKey}`}
                    className={i === 0 ? "border-t-2 border-border" : "border-t border-border/50"}
                  >
                    <td className="px-2 py-1.5 font-medium">{i === 0 ? segment : ""}</td>
                    <td className="px-2 py-1.5">{r.featureLabel}</td>
                    <td className="num px-2 py-1.5 text-right">{r.observations.toLocaleString("ko-KR")}</td>
                    <td className="num px-2 py-1.5 text-right">{r.signalCount.toLocaleString("ko-KR")}</td>
                    <td className={`num px-2 py-1.5 text-right ${edgeClass(r.edge)}`}>{pct(r.edge)}</td>
                    <td className={`num px-2 py-1.5 text-right ${edgeClass(r.marketAdjustedEdge)}`}>
                      {pct(r.marketAdjustedEdge)}
                    </td>
                    <td
                      className={`num px-2 py-1.5 text-right font-semibold ${edgeClass(r.marketAdjustedCrossSectionalEdge)}`}
                    >
                      {pct(r.marketAdjustedCrossSectionalEdge)}
                    </td>
                    <td className="num px-2 py-1.5 text-right">
                      {formatNumber(r.robustTStat, 2)}
                    </td>
                    <td className="num whitespace-nowrap px-2 py-1.5 text-right text-muted-foreground">
                      {pct(r.ci95Low)} ~ {pct(r.ci95High)}
                    </td>
                  </tr>
                )),
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * 숫자 입력칸. 입력 중에는 빈 문자열을 그대로 유지해서 마지막 자리를 지웠을 때
 * 강제로 1이나 0으로 바뀌지 않게 한다. 유효한 숫자일 때만 상위 상태를 갱신한다.
 */
function NumberField({
  value,
  onChange,
  step,
  className = "h-8 text-right text-[12px]",
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  className?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((cur) => (Number(cur) === value ? cur : String(value)));
  }, [value]);
  return (
    <Input
      type="number"
      step={step}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next !== "" && Number.isFinite(Number(next))) onChange(Number(next));
      }}
      onBlur={() => {
        if (text === "" || !Number.isFinite(Number(text))) setText(String(value));
      }}
      className={className}
    />
  );
}

function BacktestPage() {
  const [symbolText, setSymbolText] = useState("");
  const [limit, setLimit] = useState(613);
  const [includeEtf, setIncludeEtf] = useState(false);
  const [params, setParams] = useState<BacktestParams>({
    ...DEFAULT_BACKTEST_PARAMS,
    horizons: DEFAULT_HORIZONS,
  });
  const [meta, setMeta] = useState<ManualDataMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [hasBacktestData, setHasBacktestData] = useState(false);
  const [decayFeatures, setDecayFeatures] = useState<string[]>(["NEAR_52W_HIGH"]);
  const [bucketHorizon, setBucketHorizon] = useState(DEFAULT_BACKTEST_PARAMS.horizonDays);
  const [distSide, setDistSide] = useState<"signal" | "nonSignal">("signal");

  useEffect(() => {
    void hydrateManualData().then(() => {
      setMeta(getManualDataMeta());
      setReady(true);
    });
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      await hydrateManualData();
      const dedicated = await loadBacktestDataset();
      return computeLocalBacktest(
        symbolText
          .split(/[\s,;\n\t]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        params,
        limit,
        includeEtf,
        dedicated?.dataset ?? null,
      );
    },
  });

  const result: BacktestResult | undefined = mutation.data?.result;
  const horizons = result?.horizons ?? params.horizons ?? DEFAULT_HORIZONS;
  const featureOrder = BACKTEST_FEATURES.map((f) => f.id);

  const toggleFeature = (id: string) =>
    setParams((p) => ({
      ...p,
      features: p.features.includes(id)
        ? p.features.filter((x) => x !== id)
        : [...p.features, id],
    }));
  const toggleHorizon = (h: number) =>
    setParams((p) => {
      const cur = p.horizons ?? DEFAULT_HORIZONS;
      const next = cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h];
      return { ...p, horizons: next.length ? next.sort((a, b) => a - b) : cur };
    });
  const toggleInterval = (v: number) =>
    setParams((p) => {
      const cur = p.intervalCandidates ?? DEFAULT_INTERVAL_CANDIDATES;
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      return {
        ...p,
        intervalCandidates: next.length ? next.sort((a, b) => a - b) : cur,
      };
    });
  const toggleDecay = (id: string) =>
    setDecayFeatures((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-5),
    );

  /** 종목 수·보유기간·가중치 등 테스트 설정을 기본값으로 되돌린다. */
  const resetSettings = () => {
    setSymbolText("");
    setLimit(613);
    setIncludeEtf(false);
    setParams({ ...DEFAULT_BACKTEST_PARAMS, horizons: DEFAULT_HORIZONS });
  };

  const decayData = useMemo(() => {
    if (!result) return [];
    return horizons.map((h) => {
      const row: Record<string, number | string | null> = { horizon: `${h}일` };
      for (const key of decayFeatures) {
        const fh = result.featureHorizons.find((f) => f.featureKey === key);
        row[key] =
          fh?.metrics.find((m) => m.horizon === h)?.marketAdjustedCrossSectionalEdge ?? null;
      }
      return row;
    });
  }, [result, horizons, decayFeatures]);

  const distRows = useMemo(() => {
    if (!result) return [];
    return result.featureHorizons.map((fh) => ({
      key: fh.featureKey,
      label: fh.featureLabel,
      cells: horizons.map((h) => {
        const d = result.distributions.find(
          (x) => x.featureKey === fh.featureKey && x.horizon === h,
        );
        return { horizon: h, stat: d ? d[distSide] : undefined };
      }),
    }));
  }, [result, horizons, distSide]);

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">피처 영향도 백테스트 V4</h1>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              MARKET ADJUSTED
            </span>
          </div>
          <p className="max-w-4xl text-[12px] text-muted-foreground">
            고정 Universe 장기 일봉에서 미래정보 없이 피처를 판정하고, 종목의 절대수익률과 동일 시장
            (KOSPI/KOSDAQ) 대비 초과수익률을 함께 계산합니다. 날짜별 cross-sectional edge와 Robust
            t/95% CI를 주 지표로 사용합니다.
          </p>
        </div>
        {result ? <PdfExportButton documentTitle="CloudTrend Backtest V4" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4" data-no-print>
          <BacktestDataInput onChanged={setHasBacktestData} />

          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-sm font-semibold">스크리닝 데이터(대체용)</h2>
            {!ready ? (
              <p className="text-[11px] text-muted-foreground">저장된 데이터 확인 중…</p>
            ) : meta ? (
              <p className="text-[11px] text-muted-foreground">
                “데이터·산식” 탭 저장 데이터 · {meta.fileName ?? "붙여넣기"} · {formatCount(meta.chars)}자
              </p>
            ) : (
              <p className="text-[11px] text-warn">
                저장 데이터 없음 · <Link to="/scoring" className="underline">데이터·산식 탭</Link>에서
                CSV를 올려 주세요.
              </p>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">테스트 설정</h2>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={resetSettings}>
                기본값 복원
              </Button>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                종목코드 (미입력 시 업로드 데이터에서 선택)
              </Label>
              <Textarea
                value={symbolText}
                onChange={(e) => setSymbolText(e.target.value)}
                placeholder="비워두면 Universe 자동 사용"
                className="h-16 text-[12px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Universe 종목 수</Label>
                <NumberField value={limit} onChange={(n) => setLimit(Math.max(1, n))} />
                <p className="text-[10px] text-muted-foreground">30억원 기준 Universe는 613 권장</p>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">기준 보유기간</Label>
                <NumberField
                  value={params.horizonDays}
                  onChange={(n) => setParams((p) => ({ ...p, horizonDays: n }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">관측 간격</Label>
                <NumberField
                  value={params.sampleEvery}
                  onChange={(n) => setParams((p) => ({ ...p, sampleEvery: n }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">진입 기준 점수</Label>
                <NumberField
                  value={params.entryScore}
                  onChange={(n) => setParams((p) => ({ ...p, entryScore: n }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">거래량 급증 기준(%)</Label>
                <NumberField
                  step={10}
                  value={params.volumeSurgeRatio}
                  onChange={(n) => setParams((p) => ({ ...p, volumeSurgeRatio: n }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">과열 이격 기준(%)</Label>
                <NumberField
                  value={params.extensionLimit}
                  onChange={(n) => setParams((p) => ({ ...p, extensionLimit: n }))}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Forward horizon</Label>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_HORIZONS.map((h) => (
                  <label key={h} className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={(params.horizons ?? DEFAULT_HORIZONS).includes(h)}
                      onChange={() => toggleHorizon(h)}
                    />
                    {h}D
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">관측간격 민감도</Label>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_INTERVAL_CANDIDATES.map((v) => (
                  <label key={v} className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={(params.intervalCandidates ?? DEFAULT_INTERVAL_CANDIDATES).includes(v)}
                      onChange={() => toggleInterval(v)}
                    />
                    {v}D
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">거래량 급증 판정</Label>
              <select
                value={params.volumeMode ?? "HIGH_CLOSE"}
                onChange={(e) =>
                  setParams((p) => ({ ...p, volumeMode: e.target.value as VolumeSurgeMode }))
                }
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-[12px]"
              >
                {VOLUME_SURGE_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.note}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={includeEtf}
                onChange={(e) => setIncludeEtf(e.target.checked)}
              />
              자동 선정에 ETF 포함
            </label>
            <Button
              size="sm"
              className="w-full"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || (ready && !meta && !hasBacktestData)}
            >
              {mutation.isPending ? "V4 백테스트 계산 중…" : "Backtest V4 실행"}
            </Button>
          </section>

          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-sm font-semibold">피처 선택 및 가중치</h2>
            <p className="text-[11px] text-muted-foreground">
              가중치는 복합점수에만 사용되며 개별 피처 Edge에는 영향을 주지 않습니다.
            </p>
            {BACKTEST_FEATURES.map((f) => {
              const on = params.features.includes(f.id);
              return (
                <div key={f.id} className="rounded-md border border-border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => toggleFeature(f.id)} className="text-left">
                      <span className={`text-[12px] font-medium ${on ? "" : "text-muted-foreground line-through"}`}>
                        {f.label}
                      </span>
                      <p className="text-[10px] text-muted-foreground">{f.description}</p>
                    </button>
                    <NumberField
                      step={0.5}
                      value={params.weights[f.id] ?? f.defaultWeight}
                      onChange={(n) =>
                        setParams((p) => ({ ...p, weights: { ...p.weights, [f.id]: n } }))
                      }
                      className="h-7 w-16 text-right text-[12px]"
                      disabled={!on}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        </div>

        <div className="space-y-4">
          {mutation.isError ? (
            <div className="rounded-lg border border-warn/40 bg-card p-3 text-[12px] text-warn">
              백테스트 실패: {(mutation.error as Error).message}
            </div>
          ) : null}

          {!result ? (
            <div className="rounded-lg border border-border bg-card p-6 text-[12px] text-muted-foreground">
              장기 백테스트 파일에 개별 종목과 KOSPI·KOSDAQ 지수 일봉을 함께 업로드한 뒤 실행하세요.
              613종목 × 약 1,250봉을 기준으로 설계된 V4 엔진입니다.
            </div>
          ) : (
            <>
              <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "관측 표본", value: `${result.observations.toLocaleString("ko-KR")}건` },
                  { label: "대상 종목", value: `${result.symbolCount}개` },
                  { label: "종목당 평균 봉수", value: `${result.avgBars}봉` },
                  { label: "기간", value: `${result.from} ~ ${result.to}` },
                  { label: "종목 평균수익", value: pct(result.baselineAvgReturn) },
                  { label: "시장 평균수익", value: pct(result.baselineMarketReturn) },
                  { label: "시장대비 초과", value: pct(result.baselineMarketAdjustedReturn) },
                  { label: "Overlap", value: `${result.overlapRatio.toFixed(1)}x` },
                ].map((c) => (
                  <div key={c.label} className="rounded-lg border border-border bg-card p-3">
                    <p className="text-[11px] text-muted-foreground">{c.label}</p>
                    <p className={`num text-[13px] font-semibold ${edgeClass(typeof c.value === "string" ? null : c.value)}`}>
                      {c.value}
                    </p>
                  </div>
                ))}
              </section>

              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-[11px] leading-relaxed">
                <b>V4 핵심:</b> 60,000건 자동 축소를 제거했습니다. 시장조정 성과는 KOSPI 종목→KOSPI,
                KOSDAQ 종목→KOSDAQ을 사용합니다. Robust t와 95% CI는 날짜별 시장조정
                cross-sectional edge에 HAC(Newey-West) 보정을 적용합니다.
              </div>

              <Card
                title="핵심 결과 요약"
                note={`기준 ${result.horizonDays}D · OOS 시작 ${result.splitBoundaries.oosStart ?? "-"}`}
              >
                <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {result.summary.strongestAdjustedByHorizon.map((s) => (
                    <div key={s.horizon} className="rounded-md border border-border p-2">
                      <p className="text-[11px] text-muted-foreground">최강 시장조정 X-sec {s.horizon}D</p>
                      <p className="text-[12px] font-semibold">{s.label}</p>
                      <p className={`num text-[12px] ${edgeClass(s.edge)}`}>{pct(s.edge)}</p>
                    </div>
                  ))}
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">모든 horizon 양(+)의 조정 Edge</p>
                    <p className="text-[12px]">
                      {result.summary.stableFeatures.map((x) => x.label).join(", ") || "없음"}
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">OOS 양(+)의 조정 Edge</p>
                    <p className="text-[12px]">
                      {result.summary.oosStableFeatures.map((x) => x.label).join(", ") || "없음"}
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">최고 |Robust t|</p>
                    <p className="text-[12px] font-semibold">{result.summary.highestTStat?.label ?? "-"}</p>
                    <p className="num text-[12px] text-muted-foreground">
                      t={formatNumber(result.summary.highestTStat?.tStat ?? null, 2)} · {result.summary.highestTStat?.horizon ?? "-"}D
                    </p>
                  </div>
                </div>
              </Card>

              <Card
                title="피처별 영향도 V4"
                note="Raw Edge → 시장수익률 차감 Edge → 같은 날짜 종목끼리 비교한 시장조정 Cross-sectional Edge 순으로 해석하세요."
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px] text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호</th>
                        <th className="px-2 py-1.5 text-right">신호 평균</th>
                        <th className="px-2 py-1.5 text-right">중앙값</th>
                        <th className="px-2 py-1.5 text-right">Raw Edge</th>
                        <th className="px-2 py-1.5 text-right">시장조정 Edge</th>
                        <th className="px-2 py-1.5 text-right">Raw X-sec</th>
                        <th className="px-2 py-1.5 text-right">조정 X-sec</th>
                        <th className="px-2 py-1.5 text-right">Robust t</th>
                        <th className="px-2 py-1.5 text-right">95% CI</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.features]
                        .sort(
                          (a, b) =>
                            (b.marketAdjustedCrossSectionalEdge ?? -999) -
                            (a.marketAdjustedCrossSectionalEdge ?? -999),
                        )
                        .map((f) => (
                          <tr key={f.id} className="border-t border-border">
                            <td className="px-2 py-1.5 font-medium">{f.label}</td>
                            <td className="num px-2 py-1.5 text-right">{f.signalCount.toLocaleString("ko-KR")}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(f.avgReturnOn)}</td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">{pct(f.medianReturnOn)}</td>
                            <td className={`num px-2 py-1.5 text-right ${edgeClass(f.edge)}`}>{pct(f.edge)}</td>
                            <td className={`num px-2 py-1.5 text-right ${edgeClass(f.marketAdjustedEdge)}`}>
                              {pct(f.marketAdjustedEdge)}
                            </td>
                            <td className={`num px-2 py-1.5 text-right ${edgeClass(f.crossSectionalEdge)}`}>
                              {pct(f.crossSectionalEdge)}
                            </td>
                            <td className={`num px-2 py-1.5 text-right font-semibold ${edgeClass(f.marketAdjustedCrossSectionalEdge)}`}>
                              {pct(f.marketAdjustedCrossSectionalEdge)}
                            </td>
                            <td className="num px-2 py-1.5 text-right">{formatNumber(f.robustTStat, 2)}</td>
                            <td className="num whitespace-nowrap px-2 py-1.5 text-right text-muted-foreground">
                              {pct(f.ci95Low)} ~ {pct(f.ci95High)}
                            </td>
                            <td className="num px-2 py-1.5 text-right">{rate(f.hitRateOn)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card
                title="Forward Horizon · 시장조정 Cross-sectional Edge"
                note="각 셀의 상단은 시장조정 X-sec Edge, 하단은 Robust t입니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호율</th>
                        {horizons.map((h) => (
                          <th key={h} className="px-2 py-1.5 text-right">{h}D</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.featureHorizons.map((fh) => (
                        <tr key={fh.featureKey} className="border-t border-border">
                          <td className="px-2 py-1.5">{fh.featureLabel}</td>
                          <td className="num px-2 py-1.5 text-right text-muted-foreground">{rate(fh.signalRate)}</td>
                          {horizons.map((h) => {
                            const m = fh.metrics.find((x) => x.horizon === h);
                            return (
                              <td key={h} className="px-2 py-1.5 text-right">
                                <span className={`num font-semibold ${edgeClass(m?.marketAdjustedCrossSectionalEdge)}`}>
                                  {pct(m?.marketAdjustedCrossSectionalEdge)}
                                </span>
                                <span className="num block text-[10px] text-muted-foreground">
                                  t={formatNumber(m?.robustTStat ?? null, 2)} · n={m?.robustObservations ?? 0}일
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card
                title="V4 Feature Edge Decay"
                note="시장조정 Cross-sectional Edge가 보유기간에 따라 유지·확대·소멸되는지 확인합니다."
              >
                <div className="space-y-2 p-3">
                  <div className="flex flex-wrap gap-2">
                    {result.featureHorizons.map((fh) => {
                      const on = decayFeatures.includes(fh.featureKey);
                      return (
                        <button
                          key={fh.featureKey}
                          type="button"
                          onClick={() => toggleDecay(fh.featureKey)}
                          className={`rounded-md border px-2 py-1 text-[11px] ${on ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
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
              </Card>

              <BreakdownTable
                title="시장별 성과"
                note="KOSPI 288 / KOSDAQ 325 등 시장별로 피처의 재현성을 비교합니다."
                rows={result.marketBreakdown}
                featureOrder={featureOrder}
              />
              <BreakdownTable
                title="시장국면별 성과"
                note={`RISK_ON ${result.regimeCounts.RISK_ON.toLocaleString("ko-KR")}건 · NEUTRAL ${result.regimeCounts.NEUTRAL.toLocaleString("ko-KR")}건 · RISK_OFF ${result.regimeCounts.RISK_OFF.toLocaleString("ko-KR")}건. 지수 MA60·일목구름·60D 수익률·KOSPI/KOSDAQ 실현변동성으로 관측시점에만 판정합니다.`}
                rows={result.regimeBreakdown}
                featureOrder={featureOrder}
              />
              <BreakdownTable
                title="연도별 성과"
                note="전체 평균이 특정 한 해의 장세에 의해 만들어졌는지 점검합니다."
                rows={result.yearlyBreakdown}
                featureOrder={featureOrder}
              />
              <BreakdownTable
                title="Development / Validation / OOS"
                note={`시간순 60/20/20 분할 · Development 종료 ${result.splitBoundaries.developmentEnd ?? "-"} · Validation 종료 ${result.splitBoundaries.validationEnd ?? "-"} · OOS 시작 ${result.splitBoundaries.oosStart ?? "-"}`}
                rows={result.splitBreakdown}
                featureOrder={featureOrder}
              />

              <Card title="복합 점수 구간별 Horizon 성과">
                <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
                  {horizons.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => setBucketHorizon(h)}
                      className={`rounded-md border px-2 py-1 text-[11px] ${bucketHorizon === h ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                    >
                      {h}D
                    </button>
                  ))}
                </div>
                <table className="w-full text-[12px]">
                  <thead className="text-[11px] text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left">점수</th>
                      <th className="px-2 py-1.5 text-right">표본</th>
                      <th className="px-2 py-1.5 text-right">평균</th>
                      <th className="px-2 py-1.5 text-right">중앙</th>
                      <th className="px-2 py-1.5 text-right">승률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.bucketHorizons
                      .filter((b) => b.horizon === bucketHorizon)
                      .map((b) => (
                        <tr key={b.label} className="border-t border-border">
                          <td className="px-2 py-1.5">{b.label}</td>
                          <td className="num px-2 py-1.5 text-right">{b.count.toLocaleString("ko-KR")}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(b.avgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(b.medianReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{rate(b.hitRate)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Card>

              <Card
                title={`진입 ${params.entryScore}점 이상 요약`}
                note="V4에서는 중첩 forward-return을 순차 복리로 곱한 cumulativeReturn을 제거했습니다."
              >
                <table className="w-full text-[12px]">
                  <tbody>
                    {[
                      ["표본", `${result.strategy.trades.toLocaleString("ko-KR")}건`],
                      ["평균 수익률", pct(result.strategy.avgReturn)],
                      ["중앙 수익률", pct(result.strategy.medianReturn)],
                      ["승률", rate(result.strategy.hitRate)],
                      ["평균 이익", pct(result.strategy.avgWin)],
                      ["평균 손실", pct(result.strategy.avgLoss)],
                      ["기대값", pct(result.strategy.expectancy)],
                      ["전체 평균 대비", pct(result.strategy.excessVsBaseline)],
                      ["시장대비 초과수익", pct(result.strategy.marketAdjustedAvgReturn)],
                    ].map(([k, v]) => (
                      <tr key={k} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">{k}</td>
                        <td className="num px-3 py-2 text-right font-semibold">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card
                title="진입점수 Threshold 비교"
                note="평균·중앙·승률 외에 각 시장지수 대비 초과수익을 함께 표시합니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">점수</th>
                        {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right">{h}D</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[...new Set(result.entryThresholds.map((e) => e.threshold))].map((th) => {
                        const rows = result.entryThresholds.filter((e) => e.threshold === th);
                        return (
                          <tr key={th} className="border-t border-border">
                            <td className="px-2 py-1.5">{th}점+</td>
                            {horizons.map((h) => {
                              const r = rows.find((x) => x.horizon === h);
                              return (
                                <td key={h} className="px-2 py-1.5 text-right">
                                  <span className="num font-semibold">{pct(r?.avgReturn)}</span>
                                  <span className={`num block text-[10px] ${edgeClass(r?.marketAdjustedAvgReturn)}`}>
                                    시장초과 {pct(r?.marketAdjustedAvgReturn)}
                                  </span>
                                  <span className="num block text-[10px] text-muted-foreground">
                                    n={(r?.count ?? 0).toLocaleString("ko-KR")} · 승률 {rate(r?.winRate)}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card
                title="관측간격 Sensitivity"
                note="V4 장기 데이터 기본 민감도는 5·10·20일입니다. 60,000건 cap으로 관측간격을 몰래 넓히지 않습니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">간격</th>
                        <th className="px-2 py-1.5 text-right">표본</th>
                        <th className="px-2 py-1.5 text-right">진입</th>
                        <th className="px-2 py-1.5 text-right">평균</th>
                        <th className="px-2 py-1.5 text-right">시장초과</th>
                        <th className="px-2 py-1.5 text-right">중앙</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                        <th className="px-2 py-1.5 text-right">Overlap</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.intervalSensitivity.map((s) => (
                        <tr key={s.interval} className="border-t border-border">
                          <td className="px-2 py-1.5">{s.interval}D</td>
                          <td className="num px-2 py-1.5 text-right">{s.observations.toLocaleString("ko-KR")}</td>
                          <td className="num px-2 py-1.5 text-right">{s.entrySignals.toLocaleString("ko-KR")}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(s.avgReturn)}</td>
                          <td className={`num px-2 py-1.5 text-right ${edgeClass(s.marketAdjustedAvgReturn)}`}>
                            {pct(s.marketAdjustedAvgReturn)}
                          </td>
                          <td className="num px-2 py-1.5 text-right">{pct(s.medianReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{rate(s.winRate)}</td>
                          <td className="num px-2 py-1.5 text-right">{s.overlapRatio.toFixed(1)}x</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {[
                { title: "과열 이격 Sensitivity", rows: result.extensionSensitivity },
                { title: "거래량 기준 Sensitivity", rows: result.volumeSensitivity },
              ].map((block) => (
                <Card key={block.title} title={block.title} note="셀: 시장조정 Cross-sectional Edge / Robust t">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead className="text-[11px] text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left">기준</th>
                          <th className="px-2 py-1.5 text-right">신호율</th>
                          {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right">{h}D</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows.map((r) => (
                          <tr key={r.threshold} className="border-t border-border">
                            <td className="px-2 py-1.5">
                              {r.threshold}% {r.lowDiscrimination ? <span className="text-warn">· 변별력 부족</span> : null}
                            </td>
                            <td className="num px-2 py-1.5 text-right">{rate(r.signalRate)}</td>
                            {horizons.map((h) => {
                              const m = r.metrics.find((x) => x.horizon === h);
                              return (
                                <td key={h} className="px-2 py-1.5 text-right">
                                  <span className={`num font-semibold ${edgeClass(m?.marketAdjustedCrossSectionalEdge)}`}>
                                    {pct(m?.marketAdjustedCrossSectionalEdge)}
                                  </span>
                                  <span className="num block text-[10px] text-muted-foreground">
                                    t={formatNumber(m?.robustTStat ?? null, 2)}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}

              <Card
                title="Feature Correlation"
                note="boolean 피처를 0/1로 변환한 Pearson 상관. |r| ≥ 0.7은 중복 가능성 경고입니다."
              >
                <div className="overflow-x-auto p-3">
                  <table className="text-[11px]">
                    <thead>
                      <tr>
                        <th className="px-1 py-1 text-left" />
                        {result.correlation.labels.map((l, i) => <th key={l} className="px-1 py-1 text-right">{i + 1}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {result.correlation.matrix.map((row, i) => (
                        <tr key={result.correlation.ids[i]}>
                          <td className="whitespace-nowrap px-1 py-1">{i + 1}. {result.correlation.labels[i]}</td>
                          {row.map((v, j) => (
                            <td
                              key={j}
                              className={`num px-1 py-1 text-right ${v !== null && i !== j && Math.abs(v) >= 0.7 ? "font-semibold text-warn" : ""}`}
                            >
                              {v === null ? "-" : v.toFixed(2)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Return Distribution" note="평균이 소수의 급등 종목에 좌우되는지 분위수로 확인합니다.">
                <div className="flex gap-2 border-b border-border p-2">
                  {(["signal", "nonSignal"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      onClick={() => setDistSide(side)}
                      className={`rounded-md border px-2 py-1 text-[11px] ${distSide === side ? "border-primary bg-primary/10" : "border-border"}`}
                    >
                      {side === "signal" ? "신호" : "미신호"}
                    </button>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px] text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">보유</th>
                        <th className="px-2 py-1.5 text-right">n</th>
                        <th className="px-2 py-1.5 text-right">평균</th>
                        <th className="px-2 py-1.5 text-right">P5</th>
                        <th className="px-2 py-1.5 text-right">P25</th>
                        <th className="px-2 py-1.5 text-right">중앙</th>
                        <th className="px-2 py-1.5 text-right">P75</th>
                        <th className="px-2 py-1.5 text-right">P95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {distRows.flatMap((row) =>
                        row.cells.map((c, i) => (
                          <tr key={`${row.key}-${c.horizon}`} className={i === 0 ? "border-t-2 border-border" : "border-t border-border/50"}>
                            <td className="px-2 py-1.5">{i === 0 ? row.label : ""}</td>
                            <td className="num px-2 py-1.5 text-right">{c.horizon}D</td>
                            <td className="num px-2 py-1.5 text-right">{c.stat?.count ?? 0}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(c.stat?.mean)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(c.stat?.p5)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(c.stat?.p25)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(c.stat?.median)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(c.stat?.p75)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(c.stat?.p95)}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

              <section className="rounded-lg border border-border bg-card p-3">
                <h2 className="mb-1 text-sm font-semibold">V4 해석 시 주의</h2>
                <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {[...(mutation.data?.notes ?? []), ...result.notes].map((n) => <li key={n}>· {n}</li>)}
                  <li>· cumulativeReturn은 제거했습니다. 이 화면은 포트폴리오 NAV가 아니라 피처 설명력 검증입니다.</li>
                  <li>· 수수료·세금·슬리피지가 없는 forward-return 분석입니다.</li>
                  <li>· 표본 종목: {mutation.data?.universe.length ?? 0}개</li>
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
