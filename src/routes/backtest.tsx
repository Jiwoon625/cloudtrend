import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  type BacktestParams,
} from "@/lib/engine/backtest";
import { formatCount, formatNumber } from "@/lib/format";
import { BacktestDataInput } from "@/components/BacktestDataInput";
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
          "직접 업로드한 일봉 데이터로 일목 구름, 볼린저 돌파, 거래량 급증, 외국인 순매수 등 피처가 이후 수익률에 미친 영향을 종목·보유기간별로 검증합니다.",
      },
      { property: "og:title", content: "피처 영향도 백테스트 | CloudTrend" },
      {
        property: "og:description",
        content: "피처별 평균 수익률 차이(edge), 승률, 복합 점수 구간별 성과를 계산합니다.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BacktestPage,
});

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function BacktestPage() {
  const [symbolText, setSymbolText] = useState("");
  const [limit, setLimit] = useState(30);
  const [includeEtf, setIncludeEtf] = useState(false);
  const [params, setParams] = useState<BacktestParams>(DEFAULT_BACKTEST_PARAMS);
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

  const result = mutation.data?.result;
  const toggleFeature = (id: string) =>
    setParams((p) => ({
      ...p,
      features: p.features.includes(id) ? p.features.filter((x) => x !== id) : [...p.features, id],
    }));

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">피처 영향도 백테스트</h1>
        <p className="text-[12px] text-muted-foreground">
          각 거래일을 관측 시점으로 삼아 피처 신호 유무를 기록하고, 보유기간 후 수익률을 비교합니다.
          신호가 있을 때와 없을 때의 평균 수익률 차이(edge)가 클수록 그 피처의 설명력이 높습니다.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
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
                <Label className="text-[11px] text-muted-foreground">보유기간(거래일)</Label>
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
              <section className="grid gap-2 sm:grid-cols-4">
                {[
                  { label: "관측 표본", value: `${result.observations.toLocaleString("ko-KR")}건` },
                  { label: "대상 종목", value: `${result.symbolCount}개` },
                  { label: "종목당 평균 봉수", value: `${result.avgBars}봉` },
                  {
                    label: `기간 (${result.horizonDays}일 보유)`,
                    value: `${result.from} ~ ${result.to}`,
                  },
                ].map((c) => (
                  <div key={c.label} className="rounded-lg border border-border bg-card p-3">
                    <p className="text-[11px] text-muted-foreground">{c.label}</p>
                    <p className="num text-[13px] font-semibold">{c.value}</p>
                  </div>
                ))}
              </section>

              <section className="overflow-hidden rounded-lg border border-border bg-card">
                <header className="border-b border-border bg-surface-strong px-3 py-2">
                  <h2 className="text-sm font-semibold">피처별 영향도</h2>
                  <p className="text-[11px] text-muted-foreground">
                    edge = (신호 있을 때 평균 수익률) − (없을 때 평균 수익률). 전체 표본 평균{" "}
                    {pct(result.baselineAvgReturn)}
                  </p>
                </header>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">피처</th>
                        <th className="px-2 py-1.5 text-right">신호</th>
                        <th className="px-2 py-1.5 text-right">신호 시 수익</th>
                        <th className="px-2 py-1.5 text-right">미신호 시</th>
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
                              {pct(f.avgReturnOff)}
                            </td>
                            <td
                              className={`num px-2 py-1.5 text-right font-semibold ${(f.edge ?? 0) > 0 ? "text-up" : (f.edge ?? 0) < 0 ? "text-down" : ""}`}
                            >
                              {pct(f.edge)}
                            </td>
                            <td className="num px-2 py-1.5 text-right">
                              {f.hitRateOn === null ? "-" : `${f.hitRateOn.toFixed(1)}%`}
                            </td>
                            <td className="num px-2 py-1.5 text-right text-muted-foreground">
                              {formatNumber(f.tStat, 2)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="overflow-hidden rounded-lg border border-border bg-card">
                  <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
                    복합 점수 구간별 성과
                  </h2>
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">점수 구간</th>
                        <th className="px-2 py-1.5 text-right">표본</th>
                        <th className="px-2 py-1.5 text-right">평균 수익</th>
                        <th className="px-2 py-1.5 text-right">승률</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.buckets.map((b) => (
                        <tr key={b.label} className="border-t border-border">
                          <td className="px-2 py-1.5">{b.label}</td>
                          <td className="num px-2 py-1.5 text-right">
                            {b.count.toLocaleString("ko-KR")}
                          </td>
                          <td className="num px-2 py-1.5 text-right">{pct(b.avgReturn)}</td>
                          <td className="num px-2 py-1.5 text-right">
                            {b.hitRate === null ? "-" : `${b.hitRate.toFixed(1)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section className="overflow-hidden rounded-lg border border-border bg-card">
                  <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
                    진입 기준 {params.entryScore}점 이상 전략
                  </h2>
                  <table className="w-full text-[12px]">
                    <tbody>
                      {[
                        ["매매 표본", `${result.strategy.trades.toLocaleString("ko-KR")}건`],
                        ["평균 수익률", pct(result.strategy.avgReturn)],
                        [
                          "승률",
                          result.strategy.hitRate === null
                            ? "-"
                            : `${result.strategy.hitRate.toFixed(1)}%`,
                        ],
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
                </section>
              </div>

              <section className="rounded-lg border border-border bg-card p-3">
                <h2 className="mb-1 text-sm font-semibold">해석 시 주의</h2>
                <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {(mutation.data?.notes ?? []).map((n) => (
                    <li key={n}>· {n}</li>
                  ))}
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
