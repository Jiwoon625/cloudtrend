import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { KrMarketDataPanel } from "@/components/KrMarketDataPanel";
import { UsMarketDataPanel } from "@/components/UsMarketDataPanel";
import { Button } from "@/components/ui/button";
import { dataStatusQueryOptions } from "@/lib/analysisQuery";
import { loadUsMarketDataSummary, loadUsScreeningHistory } from "@/lib/usProspectiveCloud";
import type { DataStatusPayload } from "@/lib/market.functions";
import type { UsProspectiveSummary } from "@/lib/usBrowserViews";

export function MarketDataOverview({
  kr,
  us,
}: {
  kr?: DataStatusPayload;
  us?: UsProspectiveSummary | null;
}) {
  const krBars = kr?.barCoverage ?? [];
  const validDates = krBars
    .flatMap((r) => [r.first, r.last])
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const cards = [
    {
      title: "한국 · 주식·ETF",
      href: "#kr-data",
      fields: [
        ["데이터 기준일", kr?.asOfDate ?? "미확인"],
        ["공급자", kr?.dataProvider ?? "미확인"],
        ["데이터 버전", kr?.dataVersion ?? "미확인"],
        ["전략 버전", kr?.strategyVersion ?? "미확인"],
        ["수집 종목", kr ? `${krBars.length.toLocaleString()}종목` : "미확인"],
        [
          "일봉 최소기간 충족",
          kr
            ? `${krBars.filter((r) => r.bars >= 120).length.toLocaleString()} / ${krBars.length.toLocaleString()}종목 · 120봉 기준`
            : "미확인",
        ],
        [
          "전체 일봉 구간",
          validDates.length ? `${validDates[0]} ~ ${validDates.at(-1)}` : "미확인",
        ],
        ["자료 구분", kr ? (kr.isLive ? "실데이터" : "합성 데이터") : "미확인"],
      ],
    },
    {
      title: "미국 · 주식·SPY",
      href: "#us-data",
      fields: [
        ["데이터 기준일", us?.analysis.date ?? "미확인"],
        ["공급자", us?.source.provider ?? "미확인"],
        ["입력 형식 버전", us?.source.schemaVersion ?? "미확인"],
        ["전략 버전", us?.analysis.ruleVersion ?? "미확인"],
        ["수집 종목", us ? `${us.analysis.rowCount.toLocaleString()}종목 · SPY 포함` : "미확인"],
        [
          "랭킹 가능 종목",
          us?.analysis.summary["rankedRows"] == null
            ? "미확인"
            : `${us.analysis.summary["rankedRows"].toLocaleString()}종목`,
        ],
        [
          "SPY 기준 종가",
          us?.analysis.summary["spyClose"] == null
            ? "미확인"
            : `$${us.analysis.summary["spyClose"].toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
        ],
        ["상세 검증 범위", us?.quality ? "저장된 최신 스크리닝 행" : "미확인"],
      ],
    },
  ];
  return (
    <section aria-label="한국 미국 데이터 비교" className="space-y-3">
      <h2 className="text-base font-semibold">시장별 수집 현황 한눈에 보기</h2>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {cards.map((card) => (
          <article key={card.title} className="min-w-0 rounded-lg border bg-card p-4">
            <a
              href={card.href}
              className="text-sm font-semibold text-primary underline underline-offset-4"
            >
              {card.title} 상세 보기
            </a>
            <dl className="mt-3 divide-y divide-border text-xs">
              {card.fields.map(([label, value]) => (
                <div
                  key={label}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] items-start gap-3 py-2"
                >
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        한국은 원본 일봉·지수·지원 항목을, 미국은 확정 스크리닝 요약과 저장된 종목별 필드를
        검증합니다. 제공되지 않는 검증·수집 시각·해시는 추정하지 않으며, 서로 다른 검증 기준의
        수치를 같은 품질 점수로 비교하지 않습니다.
      </p>
    </section>
  );
}

export function MarketDataPage() {
  const kr = useQuery(dataStatusQueryOptions);
  const us = useQuery({
    queryKey: ["us-market-data-summary"],
    queryFn: loadUsMarketDataSummary,
    staleTime: 60_000,
    retry: false,
  });
  const history = useQuery({
    queryKey: ["us-screening-history"],
    queryFn: () => loadUsScreeningHistory(370),
    staleTime: 60_000,
    retry: false,
  });
  const pending = kr.isFetching || us.isFetching || history.isFetching;
  return (
    <AppShell
      loadAnalysis={false}
      {...(kr.data
        ? {
            source: {
              isLive: kr.data.isLive,
              provider: kr.data.dataProvider,
              notes: kr.data.notes,
              fallbackReason: kr.data.source.fallbackReason,
            },
          }
        : {})}
    >
      <div className="min-w-0 space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">데이터상태</h1>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              한국·미국 수집 상태, 검증 결과와 운용 규칙을 한 곳에서 확인합니다.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              void kr.refetch();
              void us.refetch();
              void history.refetch();
            }}
          >
            <RefreshCw className="size-3.5" />
            {pending ? "조회 중" : "새로고침"}
          </Button>
        </header>
        <nav aria-label="시장 데이터 바로가기" className="flex flex-wrap gap-2 text-sm">
          <a className="rounded-md border bg-card px-4 py-2" href="#kr-data">
            한국 데이터
          </a>
          <a className="rounded-md border bg-card px-4 py-2" href="#us-data">
            미국 데이터
          </a>
          <Link className="rounded-md border px-4 py-2" to="/scoring">
            데이터 입력·산식
          </Link>
        </nav>
        <MarketDataOverview
          {...(kr.data ? { kr: kr.data } : {})}
          {...(us.data ? { us: us.data } : {})}
        />
        {kr.isError ? (
          <section id="kr-data" aria-label="한국 데이터 조회 오류">
            <h2 className="font-semibold">한국 데이터 조회 오류</h2>
            <DataError embedded error={kr.error} reset={() => void kr.refetch()} />
          </section>
        ) : kr.data ? (
          <KrMarketDataPanel data={kr.data} />
        ) : (
          <section id="kr-data" role="status" className="rounded-lg border p-4 text-sm">
            한국 데이터 상태를 확인하는 중입니다…
          </section>
        )}
        <div className="border-t border-border pt-6">
          {us.isError || history.isError ? (
            <p role="alert" className="mb-4 rounded-lg border border-destructive p-3 text-sm">
              {us.isError ? "미국 데이터 상태" : "미국 스크리닝 이력"}를 조회하지 못했습니다. 로그인
              상태를 확인한 뒤 새로고침해 주세요. 조회 실패는 수집 0건을 뜻하지 않습니다.
            </p>
          ) : null}
          {us.isPending ? (
            <p role="status" className="mb-4 text-sm text-muted-foreground">
              미국 데이터 상태를 확인하는 중입니다…
            </p>
          ) : null}
          <UsMarketDataPanel
            value={us.data ?? null}
            historyCount={history.data?.length ?? null}
            {...(history.data?.[0]?.date ? { latestHistoryDate: history.data[0].date } : {})}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            미국 이력은 최근 최대 370개 날짜를 조회합니다. 화면의 조회 범위는 저장된 전체 보존
            기간과 다를 수 있습니다.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
