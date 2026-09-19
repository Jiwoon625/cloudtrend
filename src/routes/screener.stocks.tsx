import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { analysisQueryOptions, isAnalysisPayload } from "@/lib/analysisQuery";
import { AnalysisRequired } from "@/components/AnalysisRequired";
import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { ScreenerView } from "@/components/ScreenerView";

export const Route = createFileRoute("/screener/stocks")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "주식 스크리너 | CloudTrend V8 Final" },
      {
        name: "description",
        content:
          "KOSPI·KOSDAQ 종목을 CloudTrend V8 Final 8개 피처·10점 기술점수로 스크리닝합니다. KOSPI / KOSDAQ 8.0 Onset과 점수 Exit는 명시적 신호로 계산됩니다.",
      },
      { property: "og:title", content: "주식 스크리너 | CloudTrend V8 Final" },
      {
        property: "og:description",
        content: "CloudTrend V8 Final 한국 주식 중기 모멘텀 스크리너.",
      },
    ],
  }),
  component: StockScreenerPage,
});

function StockScreenerPage() {
  const { data: cached, error, isError, isPending, refetch } = useQuery(analysisQueryOptions);
  if (isPending) return <AnalysisRequired loading />;
  if (isError) return <DataError error={error} reset={refetch} />;
  if (!isAnalysisPayload(cached))
    return (
      <DataError
        error="분석 결과 형식이 올바르지 않습니다. 캐시를 다시 생성해 주세요."
        reset={refetch}
      />
    );
  return (
    <AppShell>
      <ScreenerView mode="STOCK" analysis={cached.analysis} />
    </AppShell>
  );
}
