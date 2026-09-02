import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { analysisQueryOptions } from "@/lib/analysisQuery";

import { AnalysisRequired } from "@/components/AnalysisRequired";
import { AppShell } from "@/components/AppShell";
import { ScreenerView } from "@/components/ScreenerView";
import type { AnalysisPayload } from "@/lib/market.functions";

export const Route = createFileRoute("/screener/etfs")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
  head: () => ({
    meta: [
      { title: "ETF 스크리너 | TrendScore KR" },
      {
        name: "description",
        content:
          "국내 상장 ETF를 순자산·거래대금·괴리율·총보수 기반 상품건전성 점수와 기술 조건으로 스크리닝합니다. 레버리지·인버스는 기본 제외됩니다.",
      },
      { property: "og:title", content: "ETF 스크리너 | TrendScore KR" },
      {
        property: "og:description",
        content: "ETF 전용 상품건전성 100점 체계와 유형 태그로 후보를 좁힙니다.",
      },
    ],
  }),
  component: EtfScreenerPage,
});

function EtfScreenerPage() {
  const queryClient = useQueryClient();
  const data = queryClient.getQueryData<AnalysisPayload>(analysisQueryOptions.queryKey);
  if (!data) return <AnalysisRequired />;
  return (
    <AppShell>
      <ScreenerView mode="ETF" analysis={data.analysis} />
    </AppShell>
  );
}
