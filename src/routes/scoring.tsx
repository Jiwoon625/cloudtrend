import { MarketDataContent } from "@/components/MarketDataPage";

import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Database, Play } from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { ManualDataInput } from "@/components/ManualDataInput";
import { Button } from "@/components/ui/button";
import { getManualDataText } from "@/lib/manualDataStore";
import { setScreeningStarted } from "@/lib/screeningRun";

export const Route = createFileRoute("/scoring")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "데이터 관리 | CloudTrend" },
      {
        name: "description",
        content: "CloudTrend 한국·ETF·미국 자료 입력과 수집·검증·계산·게시 상태를 확인합니다.",
      },
      { property: "og:title", content: "데이터 관리 | CloudTrend" },
      { property: "og:description", content: "CloudTrend 데이터 입력과 수집·검증·계산·게시 상태." },
    ],
  }),
  component: ScoringPage,
});

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
