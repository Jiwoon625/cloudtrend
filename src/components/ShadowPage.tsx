import { AppShell } from "@/components/AppShell";
import { OctoberShadowSummary } from "@/components/OctoberShadowSummary";
export function ShadowPage() {
  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Shadow</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            한국·미국·ETF의 독립 모델과 자산배분 O1·60/20/20 비교를 표시합니다. 실제 포트폴리오와
            분리된 기록이며, 자산배분 비교는 명시된 모델 환율을 사용합니다.
          </p>
        </header>
        <OctoberShadowSummary />
      </div>
    </AppShell>
  );
}
