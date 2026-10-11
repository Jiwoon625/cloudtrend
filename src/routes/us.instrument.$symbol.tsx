import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HoldingsAvailability } from "@/components/HoldingsAvailability";
import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { loadUsProspectiveCache } from "@/lib/usProspectiveCloud";
import { loadDomesticPositionContext } from "@/lib/portfolioPositionContext";
import {
  isOperationalSignalDate,
  OPERATIONAL_SIGNAL_START,
  OPERATIONAL_START_NOTICE,
} from "@/lib/operationalSignalStart";
import { formatKstDateTime } from "@/lib/format";
export const Route = createFileRoute("/us/instrument/$symbol")({
  ssr: false,
  component: UsInstrumentPage,
  head: ({ params }) => ({ meta: [{ title: `${params.symbol} | CloudTrend A0 종목 상세` }] }),
});
const rank = (n: number | null) => (n === null ? "미관측" : `상위 ${((1 - n) * 100).toFixed(2)}%`);
function UsInstrumentPage() {
  const { symbol } = Route.useParams();
  const positions = useQuery({
    queryKey: ["domestic-position-context"],
    queryFn: loadDomesticPositionContext,
    retry: false,
    staleTime: 60000,
  });
  const held = positions.isSuccess
    ? positions.data.heldSymbols.includes(symbol.toUpperCase())
    : undefined;
  const query = useQuery({
    queryKey: ["us-prospective-cache"],
    queryFn: loadUsProspectiveCache,
    staleTime: 60000,
  });
  const data = query.data;
  const row = data?.analysis.rows.find((r) => r.symbol === symbol.toUpperCase());
  const operational = isOperationalSignalDate(row?.date);
  if (query.isError) return <DataError error={query.error} reset={query.refetch} />;
  return (
    <AppShell loadAnalysis={false}>
      <main className="space-y-4">
        <Link to="/us/screener" className="text-sm text-primary">
          ← US 스크리너
        </Link>
        {query.isPending ? (
          <p role="status">분석을 불러오는 중…</p>
        ) : !row ? (
          <p>해당 기준일의 종목 자료가 없습니다.</p>
        ) : (
          <>
            <header>
              <h1 className="text-xl font-bold">
                {row.name}{" "}
                <span className="text-sm font-normal">
                  {row.symbol} · {row.market} · {row.sector ?? "미분류"}
                </span>
              </h1>
              <p className="text-xs text-muted-foreground">
                기준일 {row.date} · 전략 {data!.analysis.ruleVersion} · 계산시각{" "}
                {formatKstDateTime(data!.generatedAt)} KST
              </p>
            </header>
            <p className="rounded-lg border bg-muted/30 p-3 text-xs">{OPERATIONAL_START_NOTICE}</p>
            {!operational ? (
              <p className="text-sm text-muted-foreground">
                {row.date} · 시작 전 과거 계산 근거입니다. 아래 저장된 조건 판정은 신규 운용 후보가
                아닙니다.
              </p>
            ) : null}
            <HoldingsAvailability
              ready={positions.isSuccess}
              failed={positions.isError}
              retry={positions.refetch}
            />
            <section className="grid gap-3 sm:grid-cols-4">
              {[
                ["종가", row.close === null ? "미관측" : `$${row.close}`],
                ["Core", rank(row.coreRank)],
                ["Beta", rank(row.betaRank)],
                ["TK", rank(row.tkRank)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border bg-card p-3">
                  <p className="text-xs text-muted-foreground">{k}</p>
                  <p className="font-semibold">{v}</p>
                </div>
              ))}
            </section>
            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-3 font-semibold">
                {operational ? "종목별 판정 근거 · A0" : "과거 종목별 판정 근거 · A0"}
              </h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th>항목</th>
                    <th>관측값</th>
                    <th>판정</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      "Core 원신호",
                      rank(row.coreRank),
                      row.onset80
                        ? operational
                          ? "신규 상위20% 진입"
                          : "과거 상위20% 진입"
                        : "원신호 없음",
                    ],
                    [
                      "Beta 상위10%",
                      rank(row.betaRank),
                      row.betaRank === null ? "미관측" : row.betaRank >= 0.9 ? "충족" : "미충족",
                    ],
                    [
                      "TK 상위20%",
                      rank(row.tkRank),
                      row.tkRank === null ? "미관측" : row.tkRank >= 0.8 ? "충족" : "미충족",
                    ],
                    [
                      "유동성 / 역 Amihud",
                      `${rank(row.liquidityRank)} / ${rank(row.amihudRank)}`,
                      row.liquidityRank === null || row.amihudRank === null
                        ? "미관측"
                        : row.liquidityRank >= 0.1 && row.amihudRank >= 0.1
                          ? "충족"
                          : "미충족",
                    ],
                    [
                      "20일 평균 거래대금",
                      row.adv20Usd === null ? "미관측" : `$${row.adv20Usd.toLocaleString()}`,
                      row.adv20Usd === null ? "미관측" : row.adv20Usd >= 500000 ? "충족" : "미충족",
                    ],
                    [
                      "진입 준비",
                      !operational
                        ? "신규 운용 대상 아님"
                        : row.a0Entry
                          ? "진입 준비"
                          : "해당 없음",
                      `${OPERATIONAL_SIGNAL_START} 이후 신호만 신규 운용 적용`,
                    ],
                    [
                      "저장된 A0 진입 조건",
                      row.a0Entry ? "조건 통과" : "해당 없음",
                      operational ? "공통 적격 포함 저장된 A0 판단" : "시작 전 과거 계산 근거",
                    ],
                    [
                      "Beta 약화 연속",
                      `${row.betaWeakStreak}일`,
                      !operational
                        ? row.a0BetaExit
                          ? "과거 청산 조건 충족"
                          : "과거 관측 근거"
                        : held && row.a0BetaExit
                          ? "청산 준비"
                          : "관측 근거",
                    ],
                    [
                      "보유 시 행동",
                      !operational
                        ? "신규 운용 대상 아님"
                        : held === undefined
                          ? "보유 미확인"
                          : !held
                            ? "미보유"
                            : row.a0Exit
                              ? "청산 준비"
                              : "보유 유지",
                      "실제 보유·체결은 포트폴리오에서 확인",
                    ],
                  ].map(([k, v, d]) => (
                    <tr key={k} className="border-b">
                      <td className="py-2">{k}</td>
                      <td>{v}</td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <details className="rounded-lg border p-4">
              <summary>
                {operational ? "원자료 · 계산 근거" : "시작 전 원자료 · 과거 계산 근거"}
              </summary>
              <pre className="mt-3 overflow-auto text-xs">
                {JSON.stringify(
                  {
                    operationalStartDate: OPERATIONAL_SIGNAL_START,
                    operationalSignalEligible: operational,
                    signalContext: operational ? "신규 운용 기간" : "시작 전 과거 계산 근거",
                    ruleVersion: data!.analysis.ruleVersion,
                    dataHash: data!.dataHash,
                    source: data!.source,
                    calculatedAt: data!.generatedAt,
                    row,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        )}
      </main>
    </AppShell>
  );
}
