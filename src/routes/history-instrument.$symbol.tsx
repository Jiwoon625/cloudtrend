import { historyEntryStatus } from "@/components/historyEntryPresentation";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { KospiEntryDetails } from "@/components/KospiEntryDetails";
import { OnsetProfileDetails } from "@/components/OnsetProfileDetails";
import { screeningArchiveQueryOptions } from "@/lib/screeningArchiveQuery";
import { formatKstDateTime } from "@/lib/format";

export const Route = createFileRoute("/history-instrument/$symbol")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    runId: String(s["runId"] ?? ""),
    date: String(s["date"] ?? ""),
    savedAt: String(s["savedAt"] ?? ""),
    market: String(s["market"] ?? "KR"),
    strategyVersion: String(s["strategyVersion"] ?? ""),
    dataHash: String(s["dataHash"] ?? ""),
  }),
  head: () => ({ meta: [{ title: "과거 신호 근거 | CloudTrend" }] }),
  component: HistoricalInstrument,
});
function HistoricalInstrument() {
  const { symbol } = Route.useParams(),
    search = Route.useSearch();
  const q = useQuery(screeningArchiveQueryOptions({ ...search, asOfDate: search.date }));
  const s = q.data,
    row = s?.entries.find((r) => r.symbol === symbol);
  return (
    <AppShell loadAnalysis={false}>
      <Link to="/history" className="text-xs text-primary">
        스크리닝 이력
      </Link>
      <h1 className="my-3 text-xl font-bold">{row?.name ?? symbol} · 과거 신호 근거</h1>
      {q.isPending ? (
        <p>기록 불러오는 중…</p>
      ) : q.error ? (
        <div role="alert">
          {q.error.message} <button onClick={() => void q.refetch()}>다시 시도</button>
        </div>
      ) : !row ? (
        <p>해당 실행에 종목 기록이 없습니다.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            기준일 {s!.asOfDate} · 전략{" "}
            {s!.strategyVersion ?? row.operationalSignalVersion ?? "과거 버전 미기록"} · 실행 ID{" "}
            {s!.runId ?? "과거 일별 대표 기록 · 실행 ID 미기록"}
            <br />
            {s!.runId ? "실제 분석시각" : "과거 저장시각"} {formatKstDateTime(s!.savedAt)}
          </p>
          {s!.storedAt ? (
            <p className="text-xs text-muted-foreground">
              기록 저장시각 {formatKstDateTime(s!.storedAt)} · 게시시각 미기록
            </p>
          ) : null}
          <section className="rounded-lg border p-4">
            <h2 className="text-sm font-semibold">당시 저장된 판정</h2>
            <p>{historyEntryStatus(row)}</p>
            {row.market === "US" ? (
              <div className="text-sm">
                <p>
                  {["coreRank", "betaRank", "tkRank", "relvolRank"]
                    .map((key) => `${key.replace("Rank", "")} ${row.evidence?.[key] ?? "미관측"}`)
                    .join(" · ")}
                </p>
                <p>
                  자격{" "}
                  {typeof row.evidence?.["eligibleBase"] === "boolean"
                    ? row.evidence["eligibleBase"]
                      ? "PASS"
                      : "FAIL"
                    : "미기록"}{" "}
                  · 원신호{" "}
                  {typeof row.evidence?.["rawOnset"] === "boolean"
                    ? row.evidence["rawOnset"]
                      ? "발생"
                      : "없음"
                    : "미기록"}
                </p>
              </div>
            ) : (
              <p className="text-sm">
                기술점수 {row.technicalPoints ?? "미관측"} · 우선점수 {row.priorityPoints} · 자격{" "}
                {row.hardFilterStatus ?? (row.hardFilterPassed ? "PASS" : "FAIL")}
              </p>
            )}
            <p className="text-xs">{row.pendingRules?.join(" · ")}</p>
            <OnsetProfileDetails profile={row.onsetProfile} />
            {row.kospiEntry ? <KospiEntryDetails entry={row.kospiEntry} /> : null}
          </section>
          <details open className="rounded-lg border p-4">
            <summary>당시 계산 근거 · 원신호·확인·청산 기록</summary>
            <pre className="mt-3 overflow-auto text-xs">
              {JSON.stringify(row.evidence ?? row, null, 2)}
            </pre>
            {!row.evidence || s!.historySource === "US_DAILY" ? (
              <p className="text-xs text-muted-foreground">
                이 과거 기록에는 저장된 신호·점수만 포함되어 있습니다. 당시 저장하지 않은 산식
                세부값은 재구성하지 않습니다.
              </p>
            ) : null}
          </details>
        </div>
      )}
    </AppShell>
  );
}
