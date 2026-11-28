import { MarketDataContent } from "@/components/MarketDataPage";
import { useQueryClient } from "@tanstack/react-query";

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/scoring")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "데이터 관리 | CloudTrend" },
      {
        name: "description",
        content: "CloudTrend 한국·ETF·미국 수집·검증·계산·게시 상태를 확인합니다.",
      },
      { property: "og:title", content: "데이터 관리 | CloudTrend" },
      { property: "og:description", content: "CloudTrend 수집·검증·계산·게시 상태." },
    ],
  }),
  component: ScoringPage,
});

function ScoringPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const openResults = async () => {
    await queryClient.invalidateQueries({ queryKey: ["portfolio-ledgers"] });
    await queryClient.invalidateQueries({ queryKey: ["domestic-position-context"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-operations"] });
    void navigate({ to: "/" });
  };

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">데이터 관리</h1>
        <p className="text-[12px] text-muted-foreground">
          한국·ETF·미국 수집·검증·계산·게시 상태를 한 곳에서 관리합니다.
        </p>
      </div>

      <section className="mb-4 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Drive v7 수집·게시</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          한국·ETF는 Colab에서 자료를 수집하고 Drive 실행기에서 계산·게시합니다. 게시가 완료되면 이
          사이트에서 저장 결과와 차트를 확인할 수 있습니다. 원자료 수동 입력 없이 자동화된 게시
          결과를 확인합니다. 사이트를 열 때 자료수집이나 전체 스크리닝을 다시 실행하지 않습니다.
        </p>
        <Button size="sm" className="mt-3 gap-1.5" onClick={openResults}>
          <Play className="size-3.5" /> 저장 결과 보기
        </Button>
      </section>

      <MarketDataContent />
    </AppShell>
  );
}
