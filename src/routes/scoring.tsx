import { MarketDataContent } from "@/components/MarketDataPage";
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
import { setScreeningStarted } from "@/lib/screeningRun";

export const Route = createFileRoute("/scoring")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "데이터 입력 및 V8 Final 산식 | CloudTrend" },
      {
        name: "description",
        content:
          "CloudTrend V8 Final 10점 기술점수, KOSPI 하루 확인·RSAccel·하락장 신규진입 차단과 KOSDAQ 원신호·Exit 규칙과 우선점수 구조를 확인하고 스크리닝 데이터를 입력합니다.",
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
    void queryClient.invalidateQueries({ queryKey: ["portfolio-ledgers"] });
    queryClient.removeQueries({ queryKey: ["data-status"] });
    queryClient.removeQueries({ queryKey: ["instrument"] });
  };

  const startScreening = () => {
    setScreeningStarted(true);
    void navigate({ to: "/" });
  };

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">데이터 관리</h1>
        <p className="text-[12px] text-muted-foreground">
          한국·ETF·미국 자료 입력, 수집·검증·계산·게시 상태를 한 곳에서 관리합니다.
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
                ? "저장된 활성 자료를 분석하고 결과·계산 근거·실행 이력을 갱신합니다."
                : "먼저 데이터를 입력하고 데이터 적용을 눌러 주세요."}
            </span>
          </div>
        </div>
      </section>

      <MarketDataContent />
    </AppShell>
  );
}
