import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { analysisQueryOptions, isAnalysisPayload } from "@/lib/analysisQuery";

import {
  loadDomesticPortfolioLedger,
  loadDomesticPositionContext,
} from "@/lib/portfolioPositionContext";
import { AnalysisRequired } from "@/components/AnalysisRequired";
import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { EtfScreener } from "@/components/EtfScreener";

export const Route = createFileRoute("/screener/etfs")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
  head: () => ({
    meta: [
      { title: "ETF 스크리너 | CloudTrend" },
      {
        name: "description",
        content:
          "ETF: M0 80점 신규 돌파 후 하루 확인, 20일 평균 거래대금순 진입, 교체 없음, 기초지수 MA60 청산, 최대 10종목, 20일 변동성·15% 기준 신규 매수 비중 계산.",
      },
      { property: "og:title", content: "ETF 스크리너 | CloudTrend" },
      {
        property: "og:description",
        content: "일반 주식형 ETF의 확정 M0 전략과 변동성에 따른 매수 수량을 확인합니다.",
      },
    ],
  }),
  component: EtfScreenerPage,
});

function EtfScreenerPage() {
  const positions = useQuery({
    queryKey: ["domestic-position-context"],
    queryFn: loadDomesticPositionContext,
    retry: false,
    staleTime: 60000,
  });
  // 저장된 입력 데이터로 이 화면에서도 직접 계산한다(외부 API 호출 없음).
  const { data: cached, error, isError, isPending, refetch } = useQuery(analysisQueryOptions);
  const ledger = useQuery({
    queryKey: ["portfolio-ledgers"],
    queryFn: loadDomesticPortfolioLedger,
    staleTime: 60_000,
    retry: false,
  });
  if (isPending) return <AnalysisRequired loading />;
  if (isError) return <DataError error={error} reset={refetch} />;
  if (!isAnalysisPayload(cached)) {
    return (
      <DataError
        error="분석 결과 형식이 올바르지 않습니다. 캐시를 다시 생성해 주세요."
        reset={refetch}
      />
    );
  }
  return (
    <AppShell>
      <EtfScreener
        analysis={cached.analysis}
        ledger={ledger.data}
        positionContext={positions.data}
        ledgerError={ledger.error?.message}
      />
    </AppShell>
  );
}
