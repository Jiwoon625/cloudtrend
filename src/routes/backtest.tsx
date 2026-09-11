import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { BacktestDataInput } from "@/components/BacktestDataInput";
import { PdfExportButton } from "@/components/PdfExportButton";
import { SectorRotationBacktestResults } from "@/components/SectorRotationBacktestResults";
import { StrategyValidationResults } from "@/components/StrategyValidationResults";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getBacktestDataVersionFiles, loadBacktestDataset } from "@/lib/backtestDataStore";
import { createBacktestRunBundle, type BacktestRunIndexEntry } from "@/lib/backtestRunBundle";
import { saveBacktestRun } from "@/lib/backtestRunStore";
import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  DEFAULT_HORIZONS,
  type BacktestParams,
  type BacktestResult,
} from "@/lib/engine/backtestV4";
import { computeLocalBacktest } from "@/lib/localAnalysis";
import {
  getManualDataMeta,
  getManualDataText,
  hydrateManualData,
  type ManualDataMeta,
} from "@/lib/manualDataStore";

export const Route = createFileRoute("/backtest")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Backtest V6 | CloudTrend" },
      {
        name: "description",
        content:
          "CloudTrend V6 최종 후보 전략과 14개 섹터 로테이션의 체류주기·전이·신규 Top4 성과를 검증합니다.",
      },
    ],
  }),
  component: BacktestPage,
});

const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function NumberField({
  value,
  onChange,
  min,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return (
    <Input
      type="number"
      min={min}
      value={value}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className="h-8 text-right text-[12px]"
    />
  );
}

function BacktestPage() {
  const [symbolText, setSymbolText] = useState("");
  const [limit, setLimit] = useState(613);
  const [includeEtf, setIncludeEtf] = useState(false);
  const [roundTripCostBps, setRoundTripCostBps] = useState(0);
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
      const params: BacktestParams = {
        ...DEFAULT_BACKTEST_PARAMS,
        horizons: DEFAULT_HORIZONS,
        roundTripCostBps: Math.max(0, roundTripCostBps),
      };
      const symbols = symbolText
        .split(/[\s,;\n\t]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const execution = {
        symbols,
        limit: Math.max(1, limit),
        includeEtf,
        roundTripCostBps: Math.max(0, roundTripCostBps),
      };
      const payload = computeLocalBacktest(
        symbols,
        params,
        execution.limit,
        includeEtf,
        dedicated?.dataset ?? null,
      );
      const files = dedicated
        ? getBacktestDataVersionFiles()
        : [
            {
              id: "kr.json",
              fileName: getManualDataMeta()?.fileName ?? null,
              bytes: new Blob([getManualDataText() ?? ""]).size,
              savedAt: getManualDataMeta()?.savedAt ?? new Date(0).toISOString(),
            },
          ];
      const bundle = await createBacktestRunBundle(
        payload.result,
        {
          source: dedicated ? "SUPABASE_BACKTEST" : "SUPABASE_KR",
          datasetVersion: dedicated?.dataset.version ?? `manual-${payload.asOfDate}`,
          asOfDate: payload.asOfDate,
          files,
          universe: payload.universe,
        },
        execution,
        import.meta.env["VITE_CLOUDTREND_CODE_VERSION"] || "dev",
        payload.sectorRotationBacktest,
      );
      let savedRun: BacktestRunIndexEntry | null = null;
      let saveError: string | null = null;
      try {
        savedRun = await saveBacktestRun(bundle);
      } catch (error) {
        saveError = error instanceof Error ? error.message : "실행 기록을 저장하지 못했습니다.";
      }
      return { ...payload, savedRun, saveError };
    },
  });

  const result: BacktestResult | undefined = mutation.data?.result;

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">Backtest V6 · 대표전략 검증</h1>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              STRATEGY VALIDATION
            </span>
          </div>
          <p className="mt-1 max-w-4xl text-[12px] leading-relaxed text-muted-foreground">
            피처 배점과 진입 규칙은 고정하고 대표 매매전략의 강건성과 함께, 14개 섹터의
            로테이션 체류주기·그룹 전이·신규 Top4 이후 성과를 같은 장기 데이터로 검증합니다.
          </p>
        </div>
        {result ? <PdfExportButton documentTitle="CloudTrend Backtest V6" /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-4" data-no-print>
          <BacktestDataInput onChanged={setHasBacktestData} />

          <section className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div>
              <h2 className="text-sm font-semibold">고정 검증 설정</h2>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                전략 파라미터 탐색은 종료했습니다. 아래 항목만 데이터 범위·거래비용 확인용으로
                조정합니다. 섹터 로테이션 백테스트는 업로드된 전체 주식 유니버스를 별도로 사용합니다.
              </p>
            </div>

            <div className="rounded-md border border-primary/20 bg-primary/5 p-2 text-[11px] leading-relaxed">
              <p className="font-semibold">고정 기술점수 · 9.5점</p>
              <p className="mt-1 text-muted-foreground">1 / 1 / 1.5 / 1 / 0.5 / 2.5 / 2</p>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Universe 종목 수</Label>
              <NumberField
                value={limit}
                min={1}
                onChange={(n) => setLimit(Math.max(1, Math.round(n)))}
              />
              <p className="text-[10px] text-muted-foreground">
                기본 613개. 종목코드 직접 입력 시 이 값은 무시됩니다.
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">왕복 비용 (bps, 100 = 1%)</Label>
              <NumberField
                value={roundTripCostBps}
                min={0}
                onChange={(n) => setRoundTripCostBps(Math.max(0, n))}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">종목코드 선택 입력</Label>
              <Textarea
                value={symbolText}
                onChange={(e) => setSymbolText(e.target.value)}
                placeholder="비워두면 Universe 자동 사용"
                className="h-16 text-[12px]"
              />
            </div>

            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={includeEtf}
                onChange={(e) => setIncludeEtf(e.target.checked)}
              />
              자동 선정에 ETF 포함
            </label>

            {!hasBacktestData && ready ? (
              meta ? (
                <p className="text-[10px] text-muted-foreground">
                  백테스트 전용 파일이 없으면{" "}
                  <Link to="/scoring" className="underline">
                    데이터·산식
                  </Link>
                  의 저장 데이터를 사용합니다.
                </p>
              ) : (
                <p className="text-[10px] text-warn">
                  백테스트용 장기 데이터를 먼저 업로드해 주세요.
                </p>
              )
            ) : null}

            <Button
              size="sm"
              className="w-full"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || (ready && !meta && !hasBacktestData)}
            >
              {mutation.isPending ? "V6 전략·섹터 검증 계산 중…" : "Backtest V6 실행"}
            </Button>
          </section>
        </aside>

        <main className="space-y-4">
          {mutation.isError ? (
            <div className="rounded-lg border border-warn/40 bg-card p-3 text-[12px] text-warn">
              백테스트 실패: {(mutation.error as Error).message}
            </div>
          ) : null}

          {!result ? (
            <section className="space-y-3 rounded-lg border border-border bg-card p-5 text-[12px]">
              <h2 className="font-semibold">이번 V6에서 확인할 항목</h2>
              <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
                <li>2021~2026 연도별 성과 — ↓30 청산이 특정 시기에만 유효한지</li>
                <li>상승·중립·하락 시장국면별 성과 — 시장환경에 따른 재현성</li>
                <li>MDD·평균손실·MAE 꼬리 — 느슨한 ↓30 청산의 손실 위험</li>
                <li>CAGR·MDD·Sharpe·평균 보유/자금점유 — 40D 보유기간의 포트폴리오 효율</li>
                <li>진입가 -10/-20/-30/-40% 고정 손절 및 ATR14 trailing stop 비교</li>
                <li>섹터 Top4 체류기간·생존율·5D 전이확률·신규 Top4 이후 5/10/20/40D 성과</li>
              </ol>
            </section>
          ) : (
            <>
              <section className="rounded-lg border border-border bg-card p-3 text-[11px]">
                {mutation.data?.savedRun ? (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <p className="text-muted-foreground">실행 ID</p>
                      <p className="font-semibold">{mutation.data.savedRun.id}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">데이터 버전</p>
                      <p className="break-all font-mono text-[10px]">
                        {mutation.data.savedRun.dataVersion}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">코드 버전</p>
                      <p className="break-all font-mono text-[10px]">
                        {mutation.data.savedRun.codeVersion}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">저장 상태</p>
                      <p className="font-semibold text-primary">Supabase 저장 완료</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-warn">
                    백테스트 계산은 완료했지만 실행 기록 저장에 실패했습니다:{" "}
                    {mutation.data?.saveError ?? "원인 불명"}
                  </p>
                )}
              </section>
              <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["대상 종목", `${result.symbolCount.toLocaleString("ko-KR")}개`],
                  ["백테스트 기간", `${result.from} ~ ${result.to}`],
                  ["OOS 시작", result.splitBoundaries.oosStart ?? "—"],
                  ["왕복 비용", `${result.scoreDiagnostics.roundTripCostBps}bps`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-border bg-card p-3">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className="num mt-0.5 text-[12px] font-semibold">{value}</p>
                  </div>
                ))}
              </section>

              <section className="rounded-lg border border-border bg-card p-3">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {BACKTEST_FEATURES.map((f) => (
                    <div key={f.id} className="rounded-md border border-border p-2">
                      <p className="text-[10px] text-muted-foreground">{f.label}</p>
                      <p className="num text-[12px] font-semibold">
                        {result.config.scoreWeights[f.id] ?? f.defaultWeight}점
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  기술점수 합계 {result.config.scoreMaxPoints}점 · 대표 진입 70점 Onset · 하락 청산
                  30점 · 대표 최대보유 40D
                </p>
              </section>

              <StrategyValidationResults
                key={mutation.submittedAt}
                validation={result.strategyValidation}
                horizons={result.horizons}
              />

              {mutation.data?.sectorRotationBacktest ? (
                <SectorRotationBacktestResults result={mutation.data.sectorRotationBacktest} />
              ) : (
                <section className="rounded-lg border border-warn/30 bg-card p-3 text-[11px] text-muted-foreground">
                  섹터 로테이션 백테스트를 계산하지 못했습니다. KOSPI 지수와 120거래일 이상의
                  섹터별 장기 데이터가 포함되어 있는지 확인해 주세요.
                </section>
              )}

              <section className="rounded-lg border border-border bg-card p-3 text-[10px] leading-relaxed text-muted-foreground">
                <p>
                  포트폴리오 지표는 개별 거래 평균과 별개입니다. 각 거래일의 활성 포지션을
                  동일가중하고, 신호가 없는 날은 현금으로 처리합니다. Sharpe는 무위험수익률 0을
                  가정하며 거래일 기준 연율화합니다.
                </p>
                <p className="mt-1">
                  ATR 및 고정 손절은 OHLC 일봉으로 검증하므로 손절선 터치 여부는 확인할 수 있지만
                  실제 장중 체결 슬리피지는 반영하지 않습니다. 갭 하락은 손절선 가격이 아니라 당일
                  시가로 처리합니다.
                </p>
              </section>
            </>
          )}
        </main>
      </div>
    </AppShell>
  );
}
