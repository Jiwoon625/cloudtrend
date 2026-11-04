import { AppShell } from "@/components/AppShell";
import { OctoberShadowSummary } from "@/components/OctoberShadowSummary";
export function ShadowPage() {
  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Shadow · 보관 기록</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            한국·미국·ETF의 채택·비교전략과 통합배분의 기존 기록을 조회하는 화면입니다.
            Shadow·전략원장·통합배분은 일상 스크리닝에서 분리했으며, 매일 기록하거나 수익률을 자동
            갱신하지 않습니다. 새로고침은 저장된 기록만 다시 불러옵니다.
          </p>
        </header>
        <p className="text-sm text-muted-foreground">
          일상 매수·매도 신호는 각 시장의 스크리닝 이력에서 확인하세요. 성과 연구는 분기별 등 필요한
          시점에 백테스트 자료수집기로 자료를 모아 별도로 진행합니다. 아래 수익률과 보유는 마지막
          저장일 기준이며, 모델별 기준일이 다르면 직접 비교하지 마세요.
        </p>
        <OctoberShadowSummary />
      </div>
    </AppShell>
  );
}
