import { createFileRoute } from "@tanstack/react-router";
import { Github } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/backtest")({
  head: () => ({
    meta: [
      { title: "Backtest | CloudTrend" },
      {
        name: "description",
        content: "CloudTrend 백테스트는 GitHub Actions에서만 실행합니다.",
      },
    ],
  }),
  component: BacktestRetiredPage,
});

function BacktestRetiredPage() {
  return (
    <AppShell>
      <section className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Github className="size-5" />
          <h1 className="text-xl font-bold tracking-tight">백테스트 실행 위치 변경</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          브라우저에서 장기 백테스트 데이터를 내려받아 계산하는 기능은 종료했습니다. 장기 원천데이터는
          Supabase의 등록 원천파일을 그대로 사용하고, 백테스트 계산과 결과 저장은 GitHub Actions에서만
          수행합니다.
        </p>
        <div className="mt-5 rounded-md border border-border bg-surface p-3 text-xs leading-relaxed text-muted-foreground">
          GitHub Actions의 <strong className="text-foreground">CloudTrend analysis</strong> 워크플로에서
          실행 대상을 <strong className="text-foreground">backtest</strong>로 선택해 실행합니다.
        </div>
        <Button asChild className="mt-5">
          <a
            href="https://github.com/Jiwoon625/cloudtrend/actions/workflows/cloudtrend-analysis.yml"
            target="_blank"
            rel="noreferrer"
          >
            GitHub Actions 열기
          </a>
        </Button>
      </section>
    </AppShell>
  );
}
