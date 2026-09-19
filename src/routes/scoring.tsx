import { StrategyDescription } from "@/components/StrategyDescription";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Database, Play, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { ManualDataInput } from "@/components/ManualDataInput";
import { Button } from "@/components/ui/button";
import {
  VF_FEATURE_WEIGHTS,
  VF_ETF_PL_KOSPI_OVERHEAT_THRESHOLD,
  VF_MODEL_LABEL,
  VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
} from "@/lib/engine/vfConfig";
import { getManualDataText } from "@/lib/manualDataStore";
import { syncPortfolioFromHistory } from "@/lib/portfolioStore";
import { setScreeningStarted } from "@/lib/screeningRun";

export const Route = createFileRoute("/scoring")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "데이터 입력 및 V8 Final 산식 | CloudTrend" },
      {
        name: "description",
        content:
          "CloudTrend V8 Final 10점 기술점수, KOSPI / KOSDAQ 8.0 Onset·Exit 규칙과 우선점수 구조를 확인하고 스크리닝 데이터를 입력합니다.",
      },
      { property: "og:title", content: "데이터 입력 및 V8 Final 산식 | CloudTrend" },
      { property: "og:description", content: "검증 완료된 V8 Final 운영모델과 데이터 입력 화면." },
    ],
  }),
  component: ScoringPage,
});

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border bg-surface-strong px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {desc ? <p className="text-[11px] text-muted-foreground">{desc}</p> : null}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

const FEATURES = [
  ["일목 구름 상단 위", VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD, "종가 > 일목 구름 상단"],
  ["이동평균 정배열", VF_FEATURE_WEIGHTS.MA_ALIGNED, "MA20 > MA60 > MA120"],
  ["전환선 > 기준선", VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN, "일목 모멘텀 confirmation"],
  ["볼린저밴드 상단 돌파", VF_FEATURE_WEIGHTS.BB_BREAKOUT, "Head Fake면 미충족"],
  ["Volume Surge", VF_FEATURE_WEIGHTS.VOLUME_SURGE, "20D 평균 대비 거래량 ≥150% + CLV ≥0.70"],
  ["52주 신고가 근접", VF_FEATURE_WEIGHTS.NEAR_52W_HIGH, "52주 고점 대비 -10% 이내"],
  ["외국인 20D 순매수+", VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE, "최근 20거래일 누적 순매수 > 0"],
  [
    "Sector Price Leadership",
    VF_FEATURE_WEIGHTS.SECTOR_PRICE_LEADERSHIP,
    `KOSPI: ETF PL < ${VF_ETF_PL_KOSPI_OVERHEAT_THRESHOLD} 우선 (없으면 Stock PL < ${VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD}) · KOSDAQ: Stock PL < ${VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD}이면 +0.5`,
  ],
] as const;

function ScoringPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [hasData, setHasData] = useState(() => (getManualDataText() ?? "").trim().length > 0);

  const onDataChanged = (ok: boolean) => {
    setHasData(ok);
    setScreeningStarted(false);
    queryClient.removeQueries({ queryKey: ["market-analysis"] });
    queryClient.removeQueries({ queryKey: ["data-status"] });
    queryClient.removeQueries({ queryKey: ["instrument"] });
    if (ok) void syncPortfolioFromHistory().catch(() => undefined);
  };

  const startScreening = () => {
    setScreeningStarted(true);
    void navigate({ to: "/" });
  };

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">데이터 입력 및 {VF_MODEL_LABEL} 산식</h1>
        <p className="text-[12px] text-muted-foreground">
          장기 3-FOS 검증으로 확정한 10점 기술점수와 KOSPI / KOSDAQ 운영규칙을 사용합니다. 운영
          배점은 고정되어 있으며 화면에서 직접 변경하지 않습니다.
        </p>
      </div>

      <section className="mb-4 overflow-hidden rounded-lg border border-border bg-card">
        <header className="flex items-center gap-1.5 border-b border-border bg-surface-strong px-3 py-2">
          <Database className="size-4 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">1. 시세 데이터 입력</h2>
            <p className="text-[11px] text-muted-foreground">
              CSV/JSON 또는 붙여넣기로 입력합니다. 업로드 데이터는 계정의 Supabase 원천데이터와
              연결되어 기기 간 공유됩니다.
            </p>
          </div>
        </header>
        <div className="space-y-3 p-3">
          <ManualDataInput onChanged={onDataChanged} />
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button size="sm" className="gap-1.5" onClick={startScreening} disabled={!hasData}>
              <Play className="size-3.5" /> 스크리닝 시작
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {hasData
                ? "V8 Final 10점 점수와 명시적 KOSPI / KOSDAQ 8.0 Onset / Exit 신호를 계산합니다."
                : "먼저 데이터를 입력하고 데이터 적용을 눌러 주세요."}
            </span>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="2. V8 Final 기술점수 — 10.0점"
          desc="주식은 아래 원점수 합계를 그대로 사용하며 결측 시 남은 피처로 재정규화하지 않습니다."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                  <th className="pb-2">피처</th>
                  <th className="pb-2 text-right">배점</th>
                  <th className="pb-2 pl-3">판정</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map(([name, points, rule]) => (
                  <tr key={name} className="border-b border-border last:border-0">
                    <td className="py-2 font-medium">{name}</td>
                    <td className="num py-2 text-right font-semibold">{points.toFixed(1)}</td>
                    <td className="py-2 pl-3 text-muted-foreground">{rule}</td>
                  </tr>
                ))}
                <tr className="border-t border-border font-semibold">
                  <td className="pt-2">합계</td>
                  <td className="num pt-2 text-right">10.0</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 rounded-md border border-border bg-surface p-2 text-[11px] leading-relaxed text-muted-foreground">
            Sector PL 데이터가 없는 경우에는 해당 슬롯을 0점으로 처리합니다. 나머지 핵심 피처 중
            하나라도 NO_DATA이면 운영 기술점수는{" "}
            <strong className="text-foreground">산정 불가</strong>로 처리하며, 8.0 Onset을 만들기
            위해 분모를 줄여 재환산하지 않습니다.
          </p>
        </Section>

        <Section
          title="3. KOSPI / KOSDAQ 최종 운영규칙"
          desc="시장 Gate와 분리된 V8 Final 명시적 신호입니다."
        >
          <div className="space-y-2 text-[12px]">
            <StrategyDescription />
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-surface p-2">
                <p className="num font-semibold">30</p>
                <p className="text-[10px] text-muted-foreground">최대 종목</p>
              </div>
              <div className="rounded-md bg-surface p-2">
                <p className="num font-semibold">3.33%</p>
                <p className="text-[10px] text-muted-foreground">균등 슬롯</p>
              </div>
              <div className="rounded-md bg-surface p-2">
                <p className="num font-semibold">0.30%</p>
                <p className="text-[10px] text-muted-foreground">왕복 비용 가정</p>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="4. 우선점수 — 최대 5점"
          desc="기술점수와 분리해 같은 진입후보 안에서 우선순위를 정하는 보조 점수입니다."
        >
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded-md border border-border p-2">
              <strong>지수 편입 2점</strong>
              <p className="text-[11px] text-muted-foreground">KOSPI200 / KOSDAQ150 / KRX300</p>
            </div>
            <div className="rounded-md border border-border p-2">
              <strong>규모 1점</strong>
              <p className="text-[11px] text-muted-foreground">시가총액 기준</p>
            </div>
            <div className="rounded-md border border-border p-2">
              <strong>상대성과 1점</strong>
              <p className="text-[11px] text-muted-foreground">당일 벤치마크 대비</p>
            </div>
            <div className="rounded-md border border-border p-2">
              <strong>Sector Rotation 0~1점</strong>
              <p className="text-[11px] text-muted-foreground">Rotation Score 0~100 비례</p>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            외국인 20D 순매수와 52주 신고가 근접은 이미 10점 기술점수에 포함되므로 우선점수에서는
            중복 가점하지 않습니다.
          </p>
        </Section>

        <Section
          title="5. Market Gate"
          desc="시장 상태는 참고정보로 표시하되 KOSPI / KOSDAQ 8.0 Onset을 차단하거나 관망 라벨로 덮어쓰지 않습니다."
        >
          <div className="flex gap-2 text-[12px]">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="leading-relaxed text-muted-foreground">
              KOSPI MA60·일목 구름, 변동성, 외국인 5일 수급으로 Risk-On / Neutral / Risk-Off를 계속
              표시합니다. 다만 V8 Final 진입·Exit는 기술점수 신호에서 독립적으로 계산합니다.
            </p>
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
