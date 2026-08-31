import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { ScreenerView } from "@/components/ScreenerView";

export const Route = createFileRoute("/screener/stocks")({
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
  component: () => (
    <AppShell>
      <ScreenerView mode="STOCK" />
    </AppShell>
  ),
});
