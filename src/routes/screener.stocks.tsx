import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { analysisQueryOptions } from "@/lib/analysisQuery";

import { AnalysisRequired } from "@/components/AnalysisRequired";
import { AppShell } from "@/components/AppShell";
import { ScreenerView } from "@/components/ScreenerView";
import type { AnalysisPayload } from "@/lib/market.functions";

export const Route = createFileRoute("/screener/stocks")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
  head: () => ({
    meta: [
      { title: "주식 스크리너 | TrendScore KR" },
      {
        name: "description",
        content:
          "KOSPI·KOSDAQ 종목을 실격 필터, 시장 게이트, 기술 7점·우선 10점·펀더멘털 100점 체계로 스크리닝하고 프리셋과 CSV로 관리합니다.",
      },
      { property: "og:title", content: "주식 스크리너 | TrendScore KR" },
      {
        property: "og:description",
        content: "필터·정렬·프리셋을 지원하는 한국 주식 중기 추세추종 스크리너.",
      },
    ],
  }),
  component: StockScreenerPage,
});

function StockScreenerPage() {
  const queryClient = useQueryClient();
  const data = queryClient.getQueryData<AnalysisPayload>(analysisQueryOptions.queryKey);
  if (!data) return <AnalysisRequired />;
  return (
    <AppShell>
      <ScreenerView mode="STOCK" analysis={data.analysis} />
    </AppShell>
  );
}
