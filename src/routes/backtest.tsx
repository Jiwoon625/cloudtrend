import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { BacktestDataInput } from "@/components/BacktestDataInput";
import { BacktestV5Results } from "@/components/BacktestV5Results";
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
      { title: "Backtest V5 | CloudTrend" },
      {
        name: "description",
        content:
          "Score Threshold Onset, Rank IC, Top 5, 5·10분위 Top-Bottom Alpha와 V4 시장조정 검증을 함께 제공하는 CloudTrend V5 백테스트입니다.",
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
        <table className="w-full min-w-[920px] text-[12px]">
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left">구간</th>
              <th className="px-2 py-1.5 text-left">피처</th>
              <th className="px-2 py-1.5 text-right">표본</th>
              <th className="px-2 py-1.5 text-right">신호</th>
              <th className="px-2 py-1.5 text-right">Raw Edge</th>
              <th className="px-2 py-1.5 text-right">시장조정 Edge</th>
              <th className="px-2 py-1.5 text-right">Raw X-sec</th>
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
                    <td className={`num px-2 py-1.5 text-right ${edgeClass(r.crossSectionalEdge)}`}>
                      {pct(r.crossSectionalEdge)}
                    </td>
                    <td className={`num px-2 py-1.5 text-right font-semibold ${edgeClass(r.marketAdjustedCrossSectionalEdge)}`}>
                      {pct(r.marketAdjustedCrossSectionalEdge)}
                    </td>
                    <td className="num px-2 py-1.5 text-right">{formatNumber(r.robustTStat, 2)}</td>
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

  const resetSettings = () => {
    setSymbolText("");
    setLimit(613);
    setIncludeEtf(false);
    setParams({ ...DEFAULT_BACKTEST_PARAMS, horizons: DEFAULT_HORIZONS });
  };

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">피처·랭킹 백테스트 V5</h1>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              VALIDATION
            </span>
          </div>
          <p className="max-w-4xl text-[12px] text-muted-foreground">
            V4의 시장조정·Signal Onset·Robust t 검증에 Score Threshold Onset, 30D Rank IC,
            날짜별 Top 5와 5·10분위 Top-Bottom Alpha를 추가합니다.
          </p>
        </div>
        {result ? <PdfExportButton documentTitle="CloudTrend Backtest V5" /> : null}
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
                저장 데이터 없음 · <Link to="/scoring" className="underline">데이터·산식 탭</Link>에서 CSV를 올려 주세요.
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
              <Label className="text-[11px] text-muted-foreground">종목코드 (미입력 시 업로드 데이터에서 선택)</Label>
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
                <NumberField value={params.horizonDays} onChange={(n) => setParams((p) => ({ ...p, horizonDays: n }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">관측 간격</Label>
                <NumberField value={params.sampleEvery} onChange={(n) => setParams((p) => ({ ...p, sampleEvery: n }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">진입 기준 점수</Label>
                <NumberField value={params.entryScore} onChange={(n) => setParams((p) => ({ ...p, entryScore: n }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">거래량 급증 기준(%)</Label>
                <NumberField step={10} value={params.volumeSurgeRatio} onChange={(n) => setParams((p) => ({ ...p, volumeSurgeRatio: n }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">과열 이격 기준(%)</Label>
                <NumberField value={params.extensionLimit} onChange={(n) => setParams((p) => ({ ...p, extensionLimit: n }))} />
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
              <p className="text-[10px] text-muted-foreground">Rank IC/Top 5/Quantile 분석은 30D가 선택되어 있어야 계산됩니다.</p>
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
                onChange={(e) => setParams((p) => ({ ...p, volumeMode: e.target.value as VolumeSurgeMode }))}
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
              <input type="checkbox" checked={includeEtf} onChange={(e) => setIncludeEtf(e.target.checked)} />
              자동 선정에 ETF 포함
            </label>
            <Button
              size="sm"
              className="w-full"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || (ready && !meta && !hasBacktestData)}
            >
              {mutation.isPending ? "V5 백테스트 계산 중…" : "Backtest V5 실행"}
            </Button>
          </section>

          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-sm font-semibold">피처 선택 및 가중치</h2>
            <p className="text-[11px] text-muted-foreground">
              체크 해제는 Leave-One-Feature-Out 테스트에, 가중치 변경은 Weight Sensitivity에 사용할 수 있습니다.
            </p>
            {BACKTEST_FEATURES.map((f) => {
              const on = params.features.includes(f.id);
              return (
                <div key={f.id} className="rounded-md border border-border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => toggleFeature(f.id)} className="text-left">
                      <span className={`text-[12px] font-medium ${on ? "" : "text-muted-foreground line-through"}`}>{f.label}</span>
                      <p className="text-[10px] text-muted-foreground">{f.description}</p>
                    </button>
                    <NumberField
                      step={0.5}
                      value={params.weights[f.id] ?? f.defaultWeight}
                      onChange={(n) => setParams((p) => ({ ...p, weights: { ...p.weights, [f.id]: n } }))}
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
              613종목 × 약 1,250봉을 기준으로 설계된 V5 검증 엔진입니다.
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
                    <p className="num text-[13px] font-semibold">{c.value}</p>
                  </div>
                ))}
              </section>

              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-[11px] leading-relaxed">
                <b>V5:</b> V4의 피처별 Signal Onset과 시장조정 X-sec/HAC 구조를 유지합니다. 복합점수는 상태값을 사용하며,
                별도로 Score Threshold Onset과 30D ranking 성능을 검증합니다.
              </div>

              <Card title="실행 설정" note="PDF에도 동일한 설정 스냅샷이 저장됩니다.">
                <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded-md border border-border p-2 text-[11px]">
                    기준 {result.config.horizonDays}D · 관측 {result.config.sampleEvery}D · 진입 {result.config.entryScore}점
                  </div>
                  <div className="rounded-md border border-border p-2 text-[11px]">
                    Onset {result.config.scoreOnsetThresholds.join("/")}점
                  </div>
                  <div className="rounded-md border border-border p-2 text-[11px]">
                    Rank {result.config.rankingHorizon}D · Top {result.config.topSelectionCount} · {result.config.rankingQuantileBuckets.join("/")}분위
                  </div>
                  {result.config.features.map((id) => (
                    <div key={id} className="rounded-md border border-border p-2 text-[11px]">
                      {BACKTEST_FEATURES.find((f) => f.id === id)?.label ?? id} · weight {result.config.weights[id] ?? 0}
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="핵심 결과 요약" note={`기준 ${result.horizonDays}D · OOS 시작 ${result.splitBoundaries.oosStart ?? "-"}`}>
                <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {result.summary.strongestAdjustedByHorizon.map((s) => (
                    <div key={s.horizon} className="rounded-md border border-border p-2">
                      <p className="text-[11px] text-muted-foreground">최강 시장조정 X-sec {s.horizon}D</p>
                      <p className="text-[12px] font-semibold">{s.label}</p>
                      <p className={`num text-[12px] ${edgeClass(s.edge)}`}>{pct(s.edge)}</p>
                    </div>
                  ))}
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">모든 horizon 양(+) 조정 Edge</p>
                    <p className="text-[12px]">{result.summary.stableFeatures.map((x) => x.label).join(", ") || "없음"}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-[11px] text-muted-foreground">OOS 양(+) 조정 Edge</p>
                    <p className="text-[12px]">{result.summary.oosStableFeatures.map((x) => x.label).join(", ") || "없음"}</p>
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

              <Card title="Baseline · Horizon 전체" note="PDF 저장 시 선택 상태와 무관하게 모든 horizon을 남깁니다.">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">보유</th>
                        <th className="px-2 py-1.5 text-right">n</th>
                        <th className="px-2 py-1.5 text-right">종목 평균</th>
                        <th className="px-2 py-1.5 text-right">중앙</th>
                        <th className="px-2 py-1.5 text-right">시장 평균</th>
                        <th className="px-2 py-1.5 text-right">시장초과</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.baselineByHorizon.map((r) => (
                        <tr key={r.horizon} className="border-t border-border">
                          <td className="px-2 py-1.5">{r.horizon}D</td>
                          <td className="num px-2 py-1.5 text-right">{r.count.toLocaleString("ko-KR")}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(r.avgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(r.medianReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(r.marketAvgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.marketAdjustedAvgReturn)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="피처별 영향도" note="피처 자체 설명력은 5D 관측 그리드의 false→true Signal Onset 기준입니다.">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1180px] text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호</th>
                        <th className="px-2 py-1.5 text-right">미신호</th>
                        <th className="px-2 py-1.5 text-right">신호 평균</th>
                        <th className="px-2 py-1.5 text-right">미신호 평균</th>
                        <th className="px-2 py-1.5 text-right">신호 중앙</th>
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
                        .sort((a, b) => (b.marketAdjustedCrossSectionalEdge ?? -999) - (a.marketAdjustedCrossSectionalEdge ?? -999))
                        .map((f) => (
                          <tr key={f.id} className="border-t border-border">
                            <td className="px-2 py-1.5 font-medium">{f.label}</td>
                            <td className="num px-2 py-1.5 text-right">{f.signalCount.toLocaleString("ko-KR")}</td>
                            <td className="num px-2 py-1.5 text-right">{f.noSignalCount.toLocaleString("ko-KR")}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(f.avgReturnOn)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(f.avgReturnOff)}</td>
                            <td className="num px-2 py-1.5 text-right">{pct(f.medianReturnOn)}</td>
                            <td className={`num px-2 py-1.5 text-right ${edgeClass(f.edge)}`}>{pct(f.edge)}</td>
                            <td className={`num px-2 py-1.5 text-right ${edgeClass(f.marketAdjustedEdge)}`}>{pct(f.marketAdjustedEdge)}</td>
                            <td className={`num px-2 py-1.5 text-right ${edgeClass(f.crossSectionalEdge)}`}>{pct(f.crossSectionalEdge)}</td>
                            <td className={`num px-2 py-1.5 text-right font-semibold ${edgeClass(f.marketAdjustedCrossSectionalEdge)}`}>{pct(f.marketAdjustedCrossSectionalEdge)}</td>
                            <td className="num px-2 py-1.5 text-right">{formatNumber(f.robustTStat, 2)}</td>
                            <td className="num whitespace-nowrap px-2 py-1.5 text-right">{pct(f.ci95Low)} ~ {pct(f.ci95High)}</td>
                            <td className="num px-2 py-1.5 text-right">{rate(f.hitRateOn)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Forward Horizon · 시장조정 Cross-sectional Edge" note="각 셀은 조정 X-sec Edge / Robust t / 날짜 표본수입니다.">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호율</th>
                        {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right">{h}D</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {result.featureHorizons.map((fh) => (
                        <tr key={fh.featureKey} className="border-t border-border">
                          <td className="px-2 py-1.5">{fh.featureLabel}</td>
                          <td className="num px-2 py-1.5 text-right">{rate(fh.signalRate)}</td>
                          {horizons.map((h) => {
                            const m = fh.metrics.find((x) => x.horizon === h);
                            return (
                              <td key={h} className="px-2 py-1.5 text-right">
                                <span className={`num font-semibold ${edgeClass(m?.marketAdjustedCrossSectionalEdge)}`}>{pct(m?.marketAdjustedCrossSectionalEdge)}</span>
                                <span className="num block text-[10px] text-muted-foreground">t={formatNumber(m?.robustTStat ?? null, 2)} · n={m?.robustObservations ?? 0}</span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <BreakdownTable title="시장별 성과" note="KOSPI/KOSDAQ에서 피처 재현성을 비교합니다." rows={result.marketBreakdown} featureOrder={featureOrder} />
              <BreakdownTable title="시장국면별 성과" note={`RISK_ON ${result.regimeCounts.RISK_ON.toLocaleString("ko-KR")}건 · NEUTRAL ${result.regimeCounts.NEUTRAL.toLocaleString("ko-KR")}건 · RISK_OFF ${result.regimeCounts.RISK_OFF.toLocaleString("ko-KR")}건`} rows={result.regimeBreakdown} featureOrder={featureOrder} />
              <BreakdownTable title="연도별 성과" note="특정 한 해가 전체 평균을 지배하는지 점검합니다." rows={result.yearlyBreakdown} featureOrder={featureOrder} />
              <BreakdownTable title="Development / Validation / OOS" note={`시간순 60/20/20 · OOS 시작 ${result.splitBoundaries.oosStart ?? "-"}`} rows={result.splitBreakdown} featureOrder={featureOrder} />

              <Card title="복합 점수 구간별 Horizon 성과" note="기존 선택형 표를 전체 horizon 표로 바꿔 PDF에도 모든 값이 남습니다.">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-[11px]">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">점수</th>
                        <th className="px-2 py-1.5 text-right">보유</th>
                        <th className="px-2 py-1.5 text-right">n</th>
                        <th className="px-2 py-1.5 text-right">평균</th>
                        <th className="px-2 py-1.5 text-right">중앙</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.bucketHorizons.map((b, i) => (
                        <tr key={`${b.label}-${b.horizon}`} className={i === 0 || result.bucketHorizons[i - 1]?.label !== b.label ? "border-t-2 border-border" : "border-t border-border/50"}>
                          <td className="px-2 py-1.5">{i === 0 || result.bucketHorizons[i - 1]?.label !== b.label ? b.label : ""}</td>
                          <td className="num px-2 py-1.5 text-right">{b.horizon}D</td>
                          <td className="num px-2 py-1.5 text-right">{b.count.toLocaleString("ko-KR")}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(b.avgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(b.medianReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{rate(b.hitRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title={`진입 ${params.entryScore}점 이상 요약`} note="현재 점수 상태 기준. Score Onset과 구분해서 해석합니다.">
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

              <Card title="진입점수 Threshold 비교" note="상태값 기준 threshold. Score Threshold Onset 표와 함께 비교하세요.">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] text-[11px]">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">점수</th>
                        <th className="px-2 py-1.5 text-right">보유</th>
                        <th className="px-2 py-1.5 text-right">n</th>
                        <th className="px-2 py-1.5 text-right">평균</th>
                        <th className="px-2 py-1.5 text-right">시장초과</th>
                        <th className="px-2 py-1.5 text-right">전체대비</th>
                        <th className="px-2 py-1.5 text-right">중앙</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                        <th className="px-2 py-1.5 text-right">평균이익</th>
                        <th className="px-2 py-1.5 text-right">평균손실</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.entryThresholds.map((r, i) => (
                        <tr key={`${r.threshold}-${r.horizon}`} className={i === 0 || result.entryThresholds[i - 1]?.threshold !== r.threshold ? "border-t-2 border-border" : "border-t border-border/50"}>
                          <td className="px-2 py-1.5">{i === 0 || result.entryThresholds[i - 1]?.threshold !== r.threshold ? `${r.threshold}점+` : ""}</td>
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
              </Card>

              <BacktestV5Results result={result} />

              <Card title="관측간격 Sensitivity" note="대표 보유기간에 대해 5·10·20D 관측간격 강건성을 비교합니다.">
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
                        <th className="px-2 py-1.5 text-right">전체대비</th>
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
                          <td className="num px-2 py-1.5 text-right font-semibold">{pct(s.marketAdjustedAvgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(s.medianReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">{rate(s.winRate)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(s.edge)}</td>
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
                <Card key={block.title} title={block.title} note="모든 HorizonMetric 상세값은 PDF의 전체 결과 원본에도 저장됩니다.">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left">기준</th>
                          <th className="px-2 py-1.5 text-right">신호율</th>
                          {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right">{h}D 조정 X-sec / t</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows.map((r) => (
                          <tr key={r.threshold} className="border-t border-border">
                            <td className="px-2 py-1.5">{r.threshold}% {r.lowDiscrimination ? <span className="text-warn">· 변별력 부족</span> : null}</td>
                            <td className="num px-2 py-1.5 text-right">{rate(r.signalRate)}</td>
                            {horizons.map((h) => {
                              const m = r.metrics.find((x) => x.horizon === h);
                              return <td key={h} className="num px-2 py-1.5 text-right">{pct(m?.marketAdjustedCrossSectionalEdge)} / {formatNumber(m?.robustTStat ?? null, 2)}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}

              <Card title="Feature Correlation" note="상태형 boolean 피처를 0/1로 변환한 Pearson 상관. |r| ≥ 0.7은 중복 가능성 경고입니다.">
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
                            <td key={j} className={`num px-1 py-1 text-right ${v !== null && i !== j && Math.abs(v) >= 0.7 ? "font-semibold text-warn" : ""}`}>
                              {v === null ? "-" : v.toFixed(2)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Return Distribution · 신호/미신호 전체" note="기존 선택형 UI 대신 양쪽 분포를 모두 출력하여 PDF 누락을 없앴습니다.">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1120px] text-[11px]">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-left">구분</th>
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
                      {result.distributions.flatMap((d) => ([
                        { key: "signal", label: "신호", stat: d.signal },
                        { key: "nonSignal", label: "미신호", stat: d.nonSignal },
                      ] as const).map((side, i) => (
                        <tr key={`${d.featureKey}-${d.horizon}-${side.key}`} className={i === 0 ? "border-t-2 border-border" : "border-t border-border/50"}>
                          <td className="px-2 py-1.5">{i === 0 ? d.featureLabel : ""}</td>
                          <td className="px-2 py-1.5">{side.label}</td>
                          <td className="num px-2 py-1.5 text-right">{d.horizon}D</td>
                          <td className="num px-2 py-1.5 text-right">{side.stat.count}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(side.stat.mean)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(side.stat.p5)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(side.stat.p25)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(side.stat.median)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(side.stat.p75)}</td>
                          <td className="num px-2 py-1.5 text-right">{pct(side.stat.p95)}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <section className="rounded-lg border border-border bg-card p-3">
                <h2 className="mb-1 text-sm font-semibold">V5 해석 시 주의</h2>
                <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {[...(mutation.data?.notes ?? []), ...result.notes].map((n) => <li key={n}>· {n}</li>)}
                  <li>· cumulativeReturn은 사용하지 않습니다. forward-return 기반 설명력/랭킹 검증입니다.</li>
                  <li>· 사용자가 정한 가정에 따라 수수료·세금·슬리피지는 반영하지 않습니다.</li>
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
