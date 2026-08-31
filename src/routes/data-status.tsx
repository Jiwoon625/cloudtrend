import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { dataStatusQueryOptions } from "@/lib/analysisQuery";
import { formatCount } from "@/lib/format";

export const Route = createFileRoute("/data-status")({
  head: () => ({
    meta: [
      { title: "데이터 상태 및 검증 | TrendScore KR" },
      {
        name: "description",
        content:
          "공급자별 기준일, 레코드 수, OHLC 논리 오류·중복·미래 날짜 등 자동 검증 결과와 제공되지 않는 데이터 항목을 확인하는 품질 관리 화면입니다.",
      },
      { property: "og:title", content: "데이터 상태 및 검증 | TrendScore KR" },
      {
        property: "og:description",
        content: "실데이터/합성 데이터 여부, 공급 범위, 자동 검증 결과를 투명하게 표시합니다.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(dataStatusQueryOptions),
  component: DataStatusPage,
});

const CAPABILITY_LABELS: Record<string, string> = {
  marketCap: "시가총액",
  fundamentals: "재무(펀더멘털)",
  etfFacts: "ETF NAV·총보수·순자산",
  sectors: "업종 분류·섹터지수",
  investorFlow: "투자자별 순매수",
  volatilityIndex: "변동성지수(VKOSPI)",
  exactTradingValue: "거래대금 실측값",
};

function DataStatusPage() {
  const { data } = useSuspenseQuery(dataStatusQueryOptions);
  const validations = [
    { label: "OHLC 논리 오류", value: data.checks.ohlcErrors },
    { label: "음수 거래량", value: data.checks.negativeVolume },
    { label: "동일 종목·일자 중복", value: data.checks.duplicates },
    { label: "미래 날짜 데이터", value: data.checks.futureDates },
    { label: "지표 최소 기간(120봉) 미충족", value: data.checks.insufficient },
    { label: "비정상 급등락 (검토 플래그)", value: data.checks.abnormalMoves },
  ];

  return (
    <AppShell source={{ isLive: data.isLive, provider: data.dataProvider, notes: data.notes, fallbackReason: data.source.fallbackReason }}>
      <h1 className="text-xl font-bold tracking-tight">데이터 상태 및 계산 로그</h1>
      <p className="mb-4 text-[12px] text-muted-foreground">
        공급자 {data.dataProvider} · 기준일 {data.asOfDate} · 데이터 버전 {data.dataVersion} · 전략 v
        {data.strategyVersion} · {data.isLive ? "실데이터" : "합성 데이터"}
      </p>

      {data.notes.length > 0 ? (
        <ul className="mb-4 space-y-1 rounded-lg border border-border bg-card p-3 text-[12px] leading-relaxed text-muted-foreground">
          {data.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
            공급자별 수집 현황
          </h2>
          <table className="w-full text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">공급자</th>
                <th className="px-2 py-1.5 text-left">데이터 종류</th>
                <th className="px-2 py-1.5 text-right">레코드 수</th>
                <th className="px-2 py-1.5 text-right">대상 수</th>
                <th className="px-2 py-1.5 text-left">상태</th>
              </tr>
            </thead>
            <tbody>
              {data.coverage.map((r) => (
                <tr key={r.kind} className="border-t border-border">
                  <td className="px-2 py-1.5">{r.provider}</td>
                  <td className="px-2 py-1.5">{r.kind}</td>
                  <td className="num px-2 py-1.5 text-right">{formatCount(r.count)}</td>
                  <td className="num px-2 py-1.5 text-right">{formatCount(r.entities)}</td>
                  <td className={`px-2 py-1.5 ${r.ok ? "text-up" : "text-warn"}`}>
                    {r.ok ? "정상" : "미제공"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
              자동 검증 결과
            </h2>
            <table className="w-full text-[12px]">
              <tbody>
                {validations.map((v) => (
                  <tr key={v.label} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{v.label}</td>
                    <td
                      className={`num px-3 py-2 text-right font-semibold ${v.value === 0 ? "text-up" : "text-warn"}`}
                    >
                      {formatCount(v.value)}건
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              비정상 급등락은 자동 삭제하지 않고 corporate action 또는 데이터 오류 검토 대상으로만
              플래그합니다.
            </p>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
              항목별 제공 여부
            </h2>
            <table className="w-full text-[12px]">
              <tbody>
                {Object.entries(data.capabilities).map(([key, ok]) => (
                  <tr key={key} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{CAPABILITY_LABELS[key] ?? key}</td>
                    <td
                      className={`px-3 py-2 text-right font-semibold ${ok ? "text-up" : "text-muted-foreground"}`}
                    >
                      {ok ? "제공" : "미제공 → 점수 산정에서 제외"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
          종목별 일봉 수집 구간
        </h2>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-surface-strong text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">종목</th>
                <th className="px-2 py-1.5 text-left">심볼</th>
                <th className="px-2 py-1.5 text-right">봉 수</th>
                <th className="px-2 py-1.5 text-left">시작일</th>
                <th className="px-2 py-1.5 text-left">최종일</th>
              </tr>
            </thead>
            <tbody>
              {data.barCoverage.map((b) => (
                <tr key={b.symbol} className="border-t border-border">
                  <td className="px-2 py-1.5">{b.name}</td>
                  <td className="num px-2 py-1.5">{b.symbol}</td>
                  <td
                    className={`num px-2 py-1.5 text-right ${b.bars < 120 ? "text-warn" : ""}`}
                  >
                    {formatCount(b.bars)}
                  </td>
                  <td className="num px-2 py-1.5">{b.first}</td>
                  <td className="num px-2 py-1.5">{b.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
