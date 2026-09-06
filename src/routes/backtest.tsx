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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  DEFAULT_HORIZONS,
  DEFAULT_INTERVAL_CANDIDATES,
  VOLUME_SURGE_MODES,
  type BacktestParams,
  type BacktestResult,
  type VolumeSurgeMode,
} from "@/lib/engine/backtest";
import { formatCount, formatNumber } from "@/lib/format";
import { BacktestDataInput } from "@/components/BacktestDataInput";
import { PdfExportButton } from "@/components/PdfExportButton";

import { loadBacktestDataset } from "@/lib/backtestDataStore";
import { computeLocalBacktest } from "@/lib/localAnalysis";
import { getManualDataMeta, hydrateManualData, type ManualDataMeta } from "@/lib/manualDataStore";

export const Route = createFileRoute("/backtest")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "피처 영향도 백테스트 | CloudTrend" },
      {
        name: "description",
        content:
          "직접 업로드한 일봉 데이터로 일목 구름, 볼린저 돌파, 거래량 급증, 외국인 순매수 등 피처가 이후 수익률에 미친 영향을 보유기간(5·10·20·40·60일)별로 검증합니다.",
      },
      { property: "og:title", content: "피처 영향도 백테스트 | CloudTrend" },
      {
        property: "og:description",
        content:
          "보유기간별 edge, edge decay, 점수 구간·진입 임계값·관측간격·임계값 민감도, 피처 상관행렬까지 한 번에 계산합니다.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BacktestPage,
});

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const rate = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `${v.toFixed(1)}%`;
const edgeClass = (v: number | null | undefined) => {
  if (v === null || v === undefined) return "text-muted-foreground";
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

function BacktestPage() {
  const [symbolText, setSymbolText] = useState("");
  const [limit, setLimit] = useState(30);
  const [includeEtf, setIncludeEtf] = useState(false);
  const [params, setParams] = useState<BacktestParams>({
    ...DEFAULT_BACKTEST_PARAMS,
    horizons: DEFAULT_HORIZONS,
  });
  const [meta, setMeta] = useState<ManualDataMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [hasBacktestData, setHasBacktestData] = useState(false);
  const [decayFeatures, setDecayFeatures] = useState<string[]>(["MA_ALIGNED"]);
  const [bucketHorizon, setBucketHorizon] = useState(20);
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

  const toggleFeature = (id: string) =>
    setParams((p) => ({
      ...p,
      features: p.features.includes(id) ? p.features.filter((x) => x !== id) : [...p.features, id],
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
      return { ...p, intervalCandidates: next.length ? next.sort((a, b) => a - b) : cur };
    });
  const toggleDecay = (id: string) =>
    setDecayFeatures((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-5),
    );

  const decayData = useMemo(() => {
    if (!result) return [];
    return horizons.map((h) => {
      const row: Record<string, number | string | null> = { horizon: `${h}일` };
      for (const key of decayFeatures) {
        const fh = result.featureHorizons.find((f) => f.featureKey === key);
        row[key] = fh?.metrics.find((m) => m.horizon === h)?.edge ?? null;
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
          <h1 className="text-xl font-bold tracking-tight">피처 영향도 백테스트</h1>
          <p className="text-[12px] text-muted-foreground">
            각 거래일을 관측 시점으로 삼아 피처 신호 유무를 기록하고(미래 데이터 미사용), 보유기간
            5·10·20·40·60일 후 수익률을 동시에 비교합니다. 신호가 있을 때와 없을 때의 평균 수익률
            차이(edge)가 클수록 그 피처의 설명력이 높습니다.
          </p>
        </div>
        {result ? (
          <PdfExportButton
            documentTitle="CloudTrend 백테스트 결과"
            onBeforePrint={() => {
              // PDF에는 가장 기본이 되는 그래프(기본 피처·20일 보유기간)를 담는다.
              setDecayFeatures(["MA_ALIGNED"]);
              setBucketHorizon(20);
              setDistSide("signal");

            }}
          />
        ) : null}
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
                “데이터·산식” 탭에서 저장한 데이터 · {meta.fileName ?? "붙여넣기"} ·{" "}
                {formatCount(meta.chars)}자
              </p>
            ) : (
              <p className="text-[11px] text-warn">
                저장된 데이터가 없습니다.{" "}
                <Link to="/scoring" className="underline">
                  데이터·산식 탭
                </Link>
                에서 CSV를 업로드하거나 붙여넣어 주세요.
              </p>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-3">
            <h2 className="text-sm font-semibold">테스트 대상</h2>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                종목코드 (미입력 시 업로드한 데이터 중 거래대금 상위 종목 자동 선정)
              </Label>
              <Textarea
                value={symbolText}
                onChange={(e) => setSymbolText(e.target.value)}
                placeholder="005930 000660 373220"
                className="h-20 text-[12px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">자동 선정 종목 수</Label>
                <Input
                  type="number"
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value) || 1)}
                  className="h-8 text-right text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">기준 보유기간(거래일)</Label>
                <Input
                  type="number"
                  value={params.horizonDays}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, horizonDays: Number(e.target.value) || 1 }))
                  }
                  className="h-8 text-right text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">관측 간격(거래일)</Label>
                <Input
                  type="number"
                  value={params.sampleEvery}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, sampleEvery: Number(e.target.value) || 1 }))
                  }
                  className="h-8 text-right text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">진입 기준 점수</Label>
                <Input
                  type="number"
                  value={params.entryScore}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, entryScore: Number(e.target.value) || 0 }))
                  }
                  className="h-8 text-right text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">거래량 급증 기준(%)</Label>
                <Input
                  type="number"
                  step={10}
                  value={params.volumeSurgeRatio}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, volumeSurgeRatio: Number(e.target.value) || 100 }))
                  }
                  className="h-8 text-right text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">과열 이격 기준(%)</Label>
                <Input
                  type="number"
                  value={params.extensionLimit}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, extensionLimit: Number(e.target.value) || 1 }))
                  }
                  className="h-8 text-right text-[12px]"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                동시 분석 보유기간(거래일)
              </Label>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_HORIZONS.map((h) => (
                  <label key={h} className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={(params.horizons ?? DEFAULT_HORIZONS).includes(h)}
                      onChange={() => toggleHorizon(h)}
                    />
                    {h}일
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                관측간격 민감도 테스트 값
              </Label>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_INTERVAL_CANDIDATES.map((v) => (
                  <label key={v} className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={(params.intervalCandidates ?? DEFAULT_INTERVAL_CANDIDATES).includes(
                        v,
                      )}
                      onChange={() => toggleInterval(v)}
                    />
                    {v}일
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">거래량 급증 판정 방식</Label>
              <select
                value={params.volumeMode ?? "SIMPLE"}
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
              자동 선정에 ETF도 포함
            </label>
            <p className="text-[11px] text-muted-foreground">
              업로드하거나 붙여넣은 일봉을 그대로 사용합니다. 더 긴 기간을 보려면 일봉 개수를 늘려
              다시 업로드해 주세요.
            </p>
            <Button
              size="sm"
              className="w-full"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || (ready && !meta && !hasBacktestData)}
            >
              {mutation.isPending ? "백테스트 실행 중…" : "백테스트 실행"}
            </Button>
          </section>

          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-sm font-semibold">피처 선택 및 가중치</h2>
            <p className="text-[11px] text-muted-foreground">
              가중치는 복합 점수(0~100)를 만들 때만 사용됩니다. 개별 edge 계산은 가중치와
              무관합니다.
            </p>
            {BACKTEST_FEATURES.map((f) => {
              const on = params.features.includes(f.id);
              return (
                <div key={f.id} className="rounded-md border border-border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => toggleFeature(f.id)} className="text-left">
                      <span
                        className={`text-[12px] font-medium ${on ? "" : "text-muted-foreground line-through"}`}
                      >
                        {f.label}
                      </span>
                      <p className="text-[11px] text-muted-foreground">{f.description}</p>
                    </button>
                    <Input
                      type="number"
                      step={0.5}
                      value={params.weights[f.id] ?? f.defaultWeight}
                      onChange={(e) =>
                        setParams((p) => ({
                          ...p,
                          weights: { ...p.weights, [f.id]: Number(e.target.value) || 0 },
                        }))
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
              좌측에서 대상과 조건을 정한 뒤 “백테스트 실행”을 누르면 결과가 표시됩니다.
              “데이터·산식” 탭에서 업로드하거나 붙여넣은 일봉 데이터를 그대로 사용합니다.
            </div>
          ) : (
            <>
              {/* 1. 백테스트 설정 요약 */}
              <section className="grid gap-2 sm:grid-cols-4">
                {[
                  { label: "관측 표본", value: `${result.observations.toLocaleString("ko-KR")}건` },
                  { label: "대상 종목", value: `${result.symbolCount}개` },
                  { label: "종목당 평균 봉수", value: `${result.avgBars}봉` },
                  {
                    label: `기간 (기준 ${result.horizonDays}일 보유)`,
                    value: `${result.from} ~ ${result.to}`,
                  },
                  { label: "관측 간격", value: `${params.sampleEvery}거래일` },
                  { label: "관측 그리드", value: `${result.baseInterval}거래일` },
                  {
                    label: "거래량 판정",
                    value:
                      VOLUME_SURGE_MODES.find((m) => m.id === result.volumeMode)?.label ??
                      "단순 거래량",
                  },
                  {
                    label: "Overlap Ratio",
                    value: `${result.overlapRatio.toFixed(1)}x`,
                  },
                ].map((c) => (
                  <div key={c.label} className="rounded-lg border border-border bg-card p-3">
                    <p className="text-[11px] text-muted-foreground">{c.label}</p>
                    <p className="num text-[13px] font-semibold">{c.value}</p>
                  </div>
                ))}
              </section>

              <div className="rounded-lg border border-warn/40 bg-card p-3 text-[11px] text-warn">
                현재 설정에서는 동일한 가격 구간이 최대 약 {Math.round(result.overlapRatio)}개
                관측치에 중복 반영될 수 있습니다(보유기간 {result.horizonDays}일 ÷ 관측간격{" "}
                {params.sampleEvery}일). 표시되는 t값은 이 중첩을 고려하지 않은 naive t-stat입니다.
              </div>

              {/* 2. 핵심 결과 */}
              <Card
                title="핵심 결과 요약"
                note={`전체 표본 평균 ${pct(result.baselineAvgReturn)} (기준 ${result.horizonDays}일 보유)`}
              >
                <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {result.summary.strongestByHorizon.map((s) => (
                    <div key={s.horizon} className="rounded-md border border-border p-2">
                      <p className="text-[11px] text-muted-foreground">
                        가장 강한 {s.horizon}D 피처
                      </p>
                      <p className="text-[12px] font-semibold">{s.label}</p>
                      <p className={`num text-[12px] ${edgeClass(s.edge)}`}>{pct(s.edge)}</p>
                    </div>
                  ))}
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">가장 강한 음(-)의 edge</p>
                    <p className="text-[12px] font-semibold">
                      {result.summary.worstFeature?.label ?? "-"}
                    </p>
                    <p className={`num text-[12px] ${edgeClass(result.summary.worstFeature?.edge)}`}>
                      {pct(result.summary.worstFeature?.edge)} ({result.summary.worstFeature?.horizon}
                      D)
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">최고 |t| 피처</p>
                    <p className="text-[12px] font-semibold">
                      {result.summary.highestTStat?.label ?? "-"}
                    </p>
                    <p className="num text-[12px] text-muted-foreground">
                      t={formatNumber(result.summary.highestTStat?.tStat ?? null, 2)} (
                      {result.summary.highestTStat?.horizon}D)
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">
                      가장 안정적 (모든 기간 edge &gt; 0)
                    </p>
                    <p className="text-[12px]">
                      {result.summary.stableFeatures.map((s) => s.label).join(", ") || "없음"}
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">
                      변별력 부족 (신호율 ≥95% 또는 ≤5%)
                    </p>
                    <p className="text-[12px]">
                      {result.summary.lowDiscriminationFeatures
                        .map((s) => `${s.label} ${s.signalRate.toFixed(0)}%`)
                        .join(", ") || "없음"}
                    </p>
                  </div>
                </div>
              </Card>

              <Card
                title="피처별 영향도"
                note={`edge = (신호 있을 때 평균 수익률) − (없을 때 평균 수익률). 기준 보유기간 ${result.horizonDays}일`}
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호</th>
                        <th className="px-2 py-1.5 text-right">신호 시 평균</th>
                        <th className="px-2 py-1.5 text-right">신호 시 중앙</th>
                        <th className="px-2 py-1.5 text-right">미신호 평균</th>
                        <th className="px-2 py-1.5 text-right">미신호 중앙</th>
                        <th className="px-2 py-1.5 text-right">edge</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                        <th className="px-2 py-1.5 text-right">t값</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.features]
                        .sort((a, b) => (b.edge ?? -999) - (a.edge ?? -999))
                        .map((f) => (
                          <tr key={f.id} className="border-t border-border">
                            <td className="px-2 py-1.5">{f.label}</td>
                            <td className="num px-2 py-1.5 text-right">
                              {f.signalCount.toLocaleString("ko-KR")}
                            </td>
                            <td className="num px-2 py-1.5 text-right">{pct(f.avgReturnOn)}</td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">
                              {pct(f.medianReturnOn)}
                            </td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">
                              {pct(f.avgReturnOff)}
                            </td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">
                              {pct(f.medianReturnOff)}
                            </td>
                            <td
                              className={`num px-2 py-1.5 text-right font-semibold ${edgeClass(f.edge)}`}
                            >
                              {pct(f.edge)}
                            </td>
                            <td className="num px-2 py-1.5 text-right">{rate(f.hitRateOn)}</td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">
                              {formatNumber(f.tStat, 2)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* 3. 피처별 Forward Horizon 분석 */}
              <Card
                title="피처별 Forward Horizon 분석"
                note="각 셀은 edge(신호−미신호 평균 수익률)와 naive t값입니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호율</th>
                        {horizons.map((h) => (
                          <th key={h} className="px-2 py-1.5 text-right">
                            {h}일 Edge
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.featureHorizons.map((fh) => (
                        <tr key={fh.featureKey} className="border-t border-border">
                          <td className="px-2 py-1.5">{fh.featureLabel}</td>
                          <td className="num px-2 py-1.5 text-right text-muted-foreground">
                            {rate(fh.signalRate)}
                          </td>
                          {horizons.map((h) => {
                            const m = fh.metrics.find((x) => x.horizon === h);
                            return (
                              <td key={h} className="px-2 py-1.5 text-right">
                                <span className={`num font-semibold ${edgeClass(m?.edge)}`}>
                                  {pct(m?.edge)}
                                </span>
                                <span className="num block text-[10px] text-muted-foreground">
                                  t={formatNumber(m?.tStat ?? null, 2)}
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

              {/* 4. Feature Edge Decay */}
              <Card
                title="Feature Edge Decay"
                note="보유기간이 길어질 때 edge가 커지는지(중기형), 사라지는지(단기형), 반전되는지 확인합니다."
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
                  <div style={{ height: 300 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={decayData}>
                        <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" />
                        <XAxis dataKey="horizon" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} unit="%" />
                        <Tooltip
                          formatter={(v: number | string, name: string) => [
                            typeof v === "number" ? `${v.toFixed(2)}%` : "-",
                            result.featureHorizons.find((f) => f.featureKey === name)
                              ?.featureLabel ?? name,
                          ]}
                        />
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
                  <p className="text-[11px] text-muted-foreground">
                    선택한 피처: {decayFeatures.length}개 (최대 5개)
                  </p>
                </div>
              </Card>

              {/* Edge / Holding Period */}
              <Card
                title="Edge / Holding Period (자본 효율 참고)"
                note="Edge / Holding Period는 서로 다른 예측기간의 자본 효율을 비교하기 위한 참고지표이며 연환산 수익률이 아닙니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        {horizons.map((h) => (
                          <th key={h} className="px-2 py-1.5 text-right">
                            {h}D
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.featureHorizons.map((fh) => (
                        <tr key={fh.featureKey} className="border-t border-border">
                          <td className="px-2 py-1.5">{fh.featureLabel}</td>
                          {horizons.map((h) => {
                            const m = fh.metrics.find((x) => x.horizon === h);
                            return (
                              <td
                                key={h}
                                className={`num px-2 py-1.5 text-right ${edgeClass(m?.edgePerDay ? m.edgePerDay * 10 : null)}`}
                              >
                                {m?.edgePerDay === null || m?.edgePerDay === undefined
                                  ? "-"
                                  : `${m.edgePerDay >= 0 ? "+" : ""}${m.edgePerDay.toFixed(3)}%p/day`}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* 5. 복합 점수 구간별 Horizon 성과 */}
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
                      <th className="px-2 py-1.5 text-left">점수 구간</th>
                      <th className="px-2 py-1.5 text-right">표본</th>
                      <th className="px-2 py-1.5 text-right">평균 수익</th>
                      <th className="px-2 py-1.5 text-right">중앙값</th>
                      <th className="px-2 py-1.5 text-right">승률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.bucketHorizons
                      .filter((b) => b.horizon === (horizons.includes(bucketHorizon) ? bucketHorizon : horizons[0]))
                      .map((b) => (
                        <tr key={b.label} className="border-t border-border">
                          <td className="px-2 py-1.5">{b.label}</td>
                          <td className="num px-2 py-1.5 text-right">
                            {b.count.toLocaleString("ko-KR")}
                          </td>
                          <td className="num px-2 py-1.5 text-right">{pct(b.avgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right text-muted-foreground">
                            {pct(b.medianReturn)}
                          </td>
                          <td className="num px-2 py-1.5 text-right">{rate(b.hitRate)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Card>

              {/* 진입 기준 전략 요약 (기존) */}
              <Card title={`진입 기준 ${params.entryScore}점 이상 전략 (기준 보유기간)`}>
                <table className="w-full text-[12px]">
                  <tbody>
                    {[
                      ["매매 표본", `${result.strategy.trades.toLocaleString("ko-KR")}건`],
                      ["평균 수익률", pct(result.strategy.avgReturn)],
                      ["중앙 수익률", pct(result.strategy.medianReturn ?? null)],
                      ["승률", rate(result.strategy.hitRate)],
                      ["평균 수익(이익 건)", pct(result.strategy.avgWin)],
                      ["평균 손실(손실 건)", pct(result.strategy.avgLoss)],
                      ["기대값", pct(result.strategy.expectancy)],
                      ["전체 평균 대비 초과", pct(result.strategy.excessVsBaseline)],
                    ].map(([k, v]) => (
                      <tr key={k} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">{k}</td>
                        <td className="num px-3 py-2 text-right font-semibold">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* 6. 진입점수 Threshold 비교 */}
              <Card
                title="진입점수 Threshold 비교"
                note="각 임계값 이상 관측치의 평균 수익률 / 중앙값 / 승률 (괄호는 전체 표본 대비 초과)"
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">진입점수</th>
                        <th className="px-2 py-1.5 text-right">표본</th>
                        {horizons.map((h) => (
                          <th key={h} className="px-2 py-1.5 text-right">
                            {h}D
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...new Set(result.entryThresholds.map((e) => e.threshold))].map((th) => {
                        const rows = result.entryThresholds.filter((e) => e.threshold === th);
                        const first = rows.find((r) => r.horizon === result.horizonDays) ?? rows[0];
                        return (
                          <tr key={th} className="border-t border-border">
                            <td className="px-2 py-1.5">{th}점 이상</td>
                            <td className="num px-2 py-1.5 text-right">
                              {(first?.count ?? 0).toLocaleString("ko-KR")}
                            </td>
                            {horizons.map((h) => {
                              const r = rows.find((x) => x.horizon === h);
                              return (
                                <td key={h} className="px-2 py-1.5 text-right">
                                  <span className="num font-semibold">{pct(r?.avgReturn)}</span>
                                  <span className="num block text-[10px] text-muted-foreground">
                                    중앙 {pct(r?.medianReturn)} · 승률 {rate(r?.winRate)}
                                  </span>
                                  <span
                                    className={`num block text-[10px] ${edgeClass(r?.edgeVsAll)}`}
                                  >
                                    초과 {pct(r?.edgeVsAll)}
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

              {/* 7. 관측간격 Sensitivity */}
              <Card
                title="관측간격 Sensitivity"
                note={`기준 보유기간 ${result.horizonDays}일 · 진입 ${params.entryScore}점 이상 신호 기준. 관측간격은 t 시점 샘플링 빈도만 바꾸며 피처 계산식은 동일합니다.`}
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">관측간격</th>
                        <th className="px-2 py-1.5 text-right">관측 표본</th>
                        <th className="px-2 py-1.5 text-right">진입 신호</th>
                        <th className="px-2 py-1.5 text-right">평균 수익</th>
                        <th className="px-2 py-1.5 text-right">중앙값</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                        <th className="px-2 py-1.5 text-right">Edge</th>
                        <th className="px-2 py-1.5 text-right">중첩</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.intervalSensitivity.map((s) => (
                        <tr key={s.interval} className="border-t border-border">
                          <td className="px-2 py-1.5">{s.interval}일</td>
                          <td className="num px-2 py-1.5 text-right">
                            {s.observations.toLocaleString("ko-KR")}
                          </td>
                          <td className="num px-2 py-1.5 text-right">
                            {s.entrySignals.toLocaleString("ko-KR")}
                          </td>
                          <td className="num px-2 py-1.5 text-right">{pct(s.avgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right text-muted-foreground">
                            {pct(s.medianReturn)}
                          </td>
                          <td className="num px-2 py-1.5 text-right">{rate(s.winRate)}</td>
                          <td
                            className={`num px-2 py-1.5 text-right font-semibold ${edgeClass(s.edge)}`}
                          >
                            {pct(s.edge)}
                          </td>
                          <td className="num px-2 py-1.5 text-right text-muted-foreground">
                            {s.overlapRatio.toFixed(1)}x
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-border px-3 py-2 text-[11px] text-warn">
                  보유기간보다 관측간격이 짧기 때문에 forward return 관측치가 서로 중첩될 수
                  있습니다. t-stat은 참고용으로 해석하세요.
                </p>
              </Card>

              {/* 8·9. 임계값 민감도 */}
              {(
                [
                  {
                    key: "ext",
                    title: "과열 이격 Sensitivity",
                    note: "MA20 대비 이격률이 기준 미만이면 신호(과열 아님)로 판정합니다.",
                    rows: result.extensionSensitivity,
                    unit: "%",
                  },
                  {
                    key: "vol",
                    title: "거래량 기준 Sensitivity",
                    note: `20일 평균 거래량 대비 비율 기준 · 판정 방식: ${VOLUME_SURGE_MODES.find((m) => m.id === result.volumeMode)?.label}`,
                    rows: result.volumeSensitivity,
                    unit: "%",
                  },
                ] as const
              ).map((block) => (
                <Card key={block.key} title={block.title} note={block.note}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead className="text-[11px] text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left">기준</th>
                          <th className="px-2 py-1.5 text-right">Signal 비율</th>
                          {horizons.map((h) => (
                            <th key={h} className="px-2 py-1.5 text-right">
                              {h}D Edge
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows.map((r) => (
                          <tr key={r.threshold} className="border-t border-border">
                            <td className="px-2 py-1.5">
                              {r.threshold}
                              {block.unit}
                              {r.lowDiscrimination ? (
                                <span className="ml-1 rounded bg-warn/15 px-1 text-[10px] text-warn">
                                  변별력 부족
                                </span>
                              ) : null}
                            </td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">
                              {rate(r.signalRate)}
                            </td>
                            {horizons.map((h) => {
                              const m = r.metrics.find((x) => x.horizon === h);
                              return (
                                <td key={h} className="px-2 py-1.5 text-right">
                                  <span className={`num font-semibold ${edgeClass(m?.edge)}`}>
                                    {pct(m?.edge)}
                                  </span>
                                  <span className="num block text-[10px] text-muted-foreground">
                                    승률 {rate(m?.winRate)} · t=
                                    {formatNumber(m?.tStat ?? null, 2)}
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

              {/* 10. Feature Correlation */}
              <Card
                title="Feature Correlation (중복 측정 점검)"
                note="boolean 피처를 0/1로 바꿔 계산한 Pearson 상관계수. |r| ≥ 0.7이면 중복 가능성이 있으나 자동으로 제거하지는 않습니다."
              >
                <div className="overflow-x-auto p-3">
                  <table className="text-[11px]">
                    <thead>
                      <tr>
                        <th className="px-1 py-1 text-left" />
                        {result.correlation.labels.map((l, i) => (
                          <th key={l} className="px-1 py-1 text-right text-muted-foreground">
                            {i + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.correlation.matrix.map((row, i) => (
                        <tr key={result.correlation.ids[i]}>
                          <td className="whitespace-nowrap px-1 py-1">
                            {i + 1}. {result.correlation.labels[i]}
                          </td>
                          {row.map((v, j) => {
                            const dup = v !== null && i !== j && Math.abs(v) >= 0.7;
                            return (
                              <td
                                key={j}
                                className={`num px-1 py-1 text-right ${dup ? "font-semibold text-warn" : v !== null && Math.abs(v) >= 0.4 ? "" : "text-muted-foreground"}`}
                              >
                                {v === null ? "-" : v.toFixed(2)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* 11. Return Distribution */}
              <Card
                title="Return Distribution (극단값 점검)"
                note="평균 edge가 소수의 급등 종목 때문인지 분위수로 확인합니다."
              >
                <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
                  <select
                    value={distFeature}
                    onChange={(e) => setDistFeature(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
                  >
                    {result.featureHorizons.map((fh) => (
                      <option key={fh.featureKey} value={fh.featureKey}>
                        {fh.featureLabel}
                      </option>
                    ))}
                  </select>
                  <select
                    value={distHorizon}
                    onChange={(e) => setDistHorizon(Number(e.target.value))}
                    className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
                  >
                    {horizons.map((h) => (
                      <option key={h} value={h}>
                        {h}일 보유
                      </option>
                    ))}
                  </select>
                </div>
                <table className="w-full text-[12px]">
                  <thead className="text-[11px] text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left">구분</th>
                      <th className="px-2 py-1.5 text-right">표본</th>
                      <th className="px-2 py-1.5 text-right">평균</th>
                      <th className="px-2 py-1.5 text-right">5%</th>
                      <th className="px-2 py-1.5 text-right">25%</th>
                      <th className="px-2 py-1.5 text-right">중앙</th>
                      <th className="px-2 py-1.5 text-right">75%</th>
                      <th className="px-2 py-1.5 text-right">95%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["신호", dist?.signal],
                        ["미신호", dist?.nonSignal],
                      ] as const
                    ).map(([label, d]) => (
                      <tr key={label} className="border-t border-border">
                        <td className="px-2 py-1.5">{label}</td>
                        <td className="num px-2 py-1.5 text-right">
                          {(d?.count ?? 0).toLocaleString("ko-KR")}
                        </td>
                        <td className="num px-2 py-1.5 text-right font-semibold">
                          {pct(d?.mean)}
                        </td>
                        <td className="num px-2 py-1.5 text-right">{pct(d?.p5)}</td>
                        <td className="num px-2 py-1.5 text-right">{pct(d?.p25)}</td>
                        <td className="num px-2 py-1.5 text-right">{pct(d?.median)}</td>
                        <td className="num px-2 py-1.5 text-right">{pct(d?.p75)}</td>
                        <td className="num px-2 py-1.5 text-right">{pct(d?.p95)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* 12. 해석 시 주의사항 */}
              <section className="rounded-lg border border-border bg-card p-3">
                <h2 className="mb-1 text-sm font-semibold">해석 시 주의</h2>
                <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {[...(mutation.data?.notes ?? []), ...result.notes].map((n) => (
                    <li key={n}>· {n}</li>
                  ))}
                  <li>
                    · Edge / Holding Period는 서로 다른 예측기간의 자본 효율을 비교하기 위한
                    참고지표이며 연환산 수익률이 아닙니다.
                  </li>
                  <li>· 표시된 t값은 관측 구간 중첩을 보정하지 않은 naive t-stat입니다.</li>
                  <li>· 표본 종목: {mutation.data?.universe.map((u) => u.symbol).join(", ")}</li>
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
