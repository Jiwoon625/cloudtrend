import { AppShell } from "@/components/AppShell";
import { OctoberShadowSummary } from "@/components/OctoberShadowSummary";
export function ShadowPage() {
  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Shadow</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            한국·미국·ETF의 독립 모델을 표시합니다. 실제 포트폴리오와 분리된 모델 기록이며 KRW와 USD
            금액을 합산하지 않습니다.
          </p>
        </header>
        <OctoberShadowSummary />
      </div>
    </AppShell>
  );
}
