import { AppShell } from "@/components/AppShell";
import { OctoberShadowSummary } from "@/components/OctoberShadowSummary";
export function ShadowPage() {
  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Shadow</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            스크리닝에 연결된 한국·미국·ETF 채택·비교전략의 기록을 표시합니다. 자료가 부족한 날짜는
            갱신이 보류될 수 있으므로 모델별 마지막 기록일을 확인해 주세요. 별도 KOSPI 연구 Shadow와
            통합배분 추가 복구의 자동 실행은 중지했습니다. 기존 기록과 스크리닝 내부의 모델 갱신은
            유지되며, 자산배분 비교는 명시된 모델 환율을 사용합니다.
          </p>
        </header>
        <OctoberShadowSummary />
      </div>
    </AppShell>
  );
}
