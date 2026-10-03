import { createFileRoute } from "@tanstack/react-router";
import { MarketDataPage } from "@/components/MarketDataPage";

export const Route = createFileRoute("/data-status")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "데이터상태 | CloudTrend" },
      {
        name: "description",
        content:
          "한국·미국 시장의 수집 범위, 기준일, 데이터 품질, 고정 운용 규칙과 누적 상태를 한 곳에서 확인합니다.",
      },
      { property: "og:title", content: "데이터상태 | CloudTrend" },
      {
        property: "og:description",
        content: "시장별 공급 범위와 검증 결과, 확인할 수 없는 항목을 구분해 표시합니다.",
      },
    ],
  }),
  component: MarketDataPage,
});
