import { AppShell } from "@/components/AppShell";
import { OctoberShadowSummary } from "@/components/OctoberShadowSummary";
export function ShadowPage() {
  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Shadow</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            한국·미국·ETF의 독립 모델 중 스크리닝에 연결된 채택·비교전략 기록을 표시합니다. 자료가
            부족한 날짜는 갱신이 보류될 수 있으므로 모델별 마지막 기록일을 확인해 주세요. 기존 KOSPI
            연구 Shadow와 통합배분은 일상 스크리닝에서 분리했습니다. 기존 기록과 개별 전략의 모델
            갱신은 유지되며, 자산배분 비교는 명시된 모델 환율을 사용합니다.
          </p>
        </header>
        <p className="text-sm text-muted-foreground">
          모델별 마지막 기록일이 다르면 수익률을 직접 비교하지 마세요. 주식병합·분할로 가격 기준이
          변경된 구간은 증빙 대사 후 반영하며, 확인되지 않은 수량이나 수익률은 추정하지 않습니다.
        </p>
        <OctoberShadowSummary />
      </div>
    </AppShell>
  );
}
