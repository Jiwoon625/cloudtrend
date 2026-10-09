import { createFileRoute } from "@tanstack/react-router";
import { Database } from "lucide-react";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/backtest")({
  head: () => ({
    meta: [
      { title: "Backtest Research | CloudTrend" },
      {
        name: "description",
        content:
          "CloudTrend 연구는 Colab과 GitHub Actions 워크플로를 사용하며 원천과 결과를 별도로 보존합니다.",
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
          연구별로 Google Colab과 GitHub Actions를 사용합니다. CM 자산배분 연구는 저장소의
          CMresearchengine 워크플로에서 실행하고 private Supabase Storage에 입력·체크포인트·결과를
          보존합니다. Google Drive의 원천·연구 자료도 유지합니다.
        </p>
        <div className="mt-5 rounded-md border border-border bg-surface p-3 text-xs leading-relaxed text-muted-foreground">
          GitHub는 운영 점수·진입/청산 규칙과 코드 버전을 관리합니다. 확정된 연구 결과만 Production
          전략엔진에 반영합니다. 연구 실행 성공은 전략 채택이나 전체 운영 검증 완료를 뜻하지
          않습니다.
        </div>
      </section>
    </AppShell>
  );
}
