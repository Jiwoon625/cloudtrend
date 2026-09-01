import { createFileRoute } from "@tanstack/react-router";

import { analysisQueryOptions } from "@/lib/analysisQuery";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { ScreenerView } from "@/components/ScreenerView";

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
  loader: ({ context }) => context.queryClient.ensureQueryData(analysisQueryOptions),
  errorComponent: ({ error, reset }) => <DataError error={error} reset={reset} />,
  component: () => (
    <AppShell>
      <ScreenerView mode="ETF" />
    </AppShell>
  ),
});
