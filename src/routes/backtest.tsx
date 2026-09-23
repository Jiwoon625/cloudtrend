import { createFileRoute } from "@tanstack/react-router";
import { Database } from "lucide-react";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/backtest")({
  head: () => ({
    meta: [
      { title: "Backtest Research | CloudTrend" },
      {
        name: "description",
        content: "CloudTrend 장기 백테스트는 Google Drive 데이터와 Google Colab 연구 노트북에서 수행합니다.",
      },
    ],
  }),
  component: BacktestResearchPage,
});

function BacktestResearchPage() {
  return (
    <AppShell>
      <section className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Database className="size-5" />
          <h1 className="text-xl font-bold tracking-tight">백테스트 연구 환경</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          장기 백테스트 원천데이터와 연구 결과는 Google Drive의 CloudTrend 한국시장·미국시장 폴더에
          보관하며, 계산은 Google Colab에서 수행합니다. Supabase는 스크리닝·포트폴리오·이력 같은
          운영 데이터에만 사용합니다.
        </p>
        <div className="mt-5 rounded-md border border-border bg-surface p-3 text-xs leading-relaxed text-muted-foreground">
          GitHub는 운영 점수·진입/청산 규칙과 코드 버전을 관리합니다. 확정된 연구 결과만 Production
          전략엔진에 반영하며, GitHub Actions에서는 장기 백테스트를 실행하지 않습니다.
        </div>
      </section>
    </AppShell>
  );
}
