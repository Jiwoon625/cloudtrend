import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { analysisQueryOptions, isAnalysisPayload } from "@/lib/analysisQuery";

import { AnalysisRequired } from "@/components/AnalysisRequired";
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
  component: EtfScreenerPage,
});

function EtfScreenerPage() {
  // 저장된 입력 데이터로 이 화면에서도 직접 계산한다(외부 API 호출 없음).
  const { data: cached, error, isError, isPending, refetch } = useQuery(analysisQueryOptions);
  if (isPending) return <AnalysisRequired loading />;
  if (isError) return <DataError error={error} reset={refetch} />;
  if (!isAnalysisPayload(cached)) {
    return <DataError error="분석 결과 형식이 올바르지 않습니다. 캐시를 다시 생성해 주세요." reset={refetch} />;
  }
  return (
    <AppShell>
      <ScreenerView mode="ETF" analysis={cached.analysis} />
    </AppShell>
  );
}
