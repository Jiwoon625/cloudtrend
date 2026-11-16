import { MarketDataContent } from "@/components/MarketDataPage";

import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Database, Play } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { ManualDataInput } from "@/components/ManualDataInput";
import { Button } from "@/components/ui/button";
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

  const onDataChanged = () => {
    setScreeningStarted(false);
    queryClient.removeQueries({ queryKey: ["market-analysis"] });
    void queryClient.invalidateQueries({ queryKey: ["portfolio-ledgers"] });
    queryClient.removeQueries({ queryKey: ["data-status"] });
    queryClient.removeQueries({ queryKey: ["instrument"] });
  };

  const openResults = () => {
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

      <section className="mb-4 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Drive v7 수집·게시</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          한국·ETF는 Colab에서 자료를 수집하고 Drive 실행기에서 계산·게시합니다. 게시가 완료되면 이
          사이트에서 저장 결과와 차트를 확인할 수 있습니다. 사이트를 열 때 자료수집이나 전체
          스크리닝을 다시 실행하지 않습니다.
        </p>
        <Button size="sm" className="mt-3 gap-1.5" onClick={openResults}>
          <Play className="size-3.5" /> 저장 결과 보기
        </Button>
      </section>

      <section className="mb-4 overflow-hidden rounded-lg border border-border bg-card">
        <header className="flex items-center gap-1.5 border-b border-border bg-surface-strong px-3 py-2">
          <Database className="size-4 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">직접 파일 입력 · 기존 경로</h2>
            <p className="text-[11px] text-muted-foreground">
              CSV/JSON 또는 붙여넣기로 입력합니다. 업로드 데이터는 계정의 Supabase 원천데이터와
              연결되어 기기 간 공유됩니다.
            </p>
          </div>
        </header>
        <div className="space-y-3 p-3">
          <ManualDataInput onChanged={onDataChanged} />
          <p className="text-[11px] text-muted-foreground">
            Drive v7 게시 결과를 확인하는 경우에는 이 화면에 원자료를 다시 입력할 필요가 없습니다.
          </p>
        </div>
      </section>

      <MarketDataContent />
    </AppShell>
  );
}
