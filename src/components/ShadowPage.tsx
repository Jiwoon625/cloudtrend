import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { OctoberShadowSummary } from "@/components/OctoberShadowSummary";
import { KospiShadowPanel } from "@/components/KospiShadowPanel";
import { Button } from "@/components/ui/button";
export function ShadowPage() {
  const [showKospiCorrection, setShowKospiCorrection] = useState(false);
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
        <section className="space-y-4 rounded-lg border p-4" aria-label="별도 KOSPI 기록">
          <div>
            <h2 className="font-semibold">별도 KOSPI Shadow · 사후 정정본</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              위 통합 모델과 별개의 기록입니다. 원본을 보존한 정정본과 원본 기록을 구분하여
              조회합니다.
            </p>
          </div>
          <Button
            variant="outline"
            aria-expanded={showKospiCorrection}
            aria-controls="separate-kospi-shadow"
            onClick={() => setShowKospiCorrection((value) => !value)}
          >
            {showKospiCorrection ? "별도 KOSPI 기록 닫기" : "별도 KOSPI 기록 열기"}
          </Button>
          {showKospiCorrection && (
            <div id="separate-kospi-shadow">
              <KospiShadowPanel />
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
