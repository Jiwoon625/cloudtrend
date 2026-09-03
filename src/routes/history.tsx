import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, History, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCount, formatKstDateTime, formatNumber } from "@/lib/format";
import { diffSnapshots, useSnapshots, type SnapshotEntry } from "@/lib/screeningHistory";

export const Route = createFileRoute("/history")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "스크리닝 이력 | TrendScore KR" },
      {
        name: "description",
        content:
          "날짜별로 저장된 마지막 스크리닝 결과를 조회하고 전일 대비 신규 A등급 진입·A→B 하락 종목을 비교합니다.",
      },
      { property: "og:title", content: "스크리닝 이력 | TrendScore KR" },
      {
        property: "og:description",
        content: "일별 마지막 스크리닝 스냅샷과 등급 변화 비교.",
      },
    ],
  }),
  component: HistoryPage,
});

function EntryList({ entries, empty }: { entries: SnapshotEntry[]; empty: string }) {
  if (entries.length === 0) return <p className="text-[11px] text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map((e) => (
        <Link key={e.symbol} to="/instrument/$symbol" params={{ symbol: e.symbol }}>
          <Badge variant="outline" className="text-[10px]">
            {e.name}
          </Badge>
        </Link>
      ))}
    </div>
  );
}

function HistoryPage() {
  const { snapshots, remove, clear } = useSnapshots();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = useMemo(
    () => snapshots.find((s) => s.date === selectedDate) ?? snapshots[0] ?? null,
    [snapshots, selectedDate],
  );
  const diff = useMemo(
    () => (selected ? diffSnapshots(selected, snapshots) : null),
    [selected, snapshots],
  );

  const sortedEntries = useMemo(
    () =>
      selected
        ? [...selected.entries].sort((a, b) => b.totalScore - a.totalScore).slice(0, 50)
        : [],
    [selected],
  );

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <History className="size-5 text-primary" />
            스크리닝 이력
          </h1>
          <p className="text-[12px] text-muted-foreground">
            하루에 여러 번 스크리닝하면 그날의 마지막 결과만 저장됩니다. (브라우저 로컬 저장, 최근
            90일)
          </p>
        </div>
        {snapshots.length > 0 ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={clear}>
            <Trash2 className="size-3.5" />
            전체 삭제
          </Button>
        ) : null}
      </div>

      {snapshots.length === 0 ? (
        <section className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <p className="text-[13px] text-muted-foreground">
            저장된 이력이 없습니다. 대시보드에서 스크리닝을 실행하면 그날의 결과가 자동 저장됩니다.
          </p>
          <Link to="/" className="mt-3 inline-block text-[12px] text-primary hover:underline">
            대시보드로 이동
          </Link>
        </section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-sm font-semibold">저장된 날짜</h2>
            <ul className="space-y-1">
              {snapshots.map((s) => {
                const isActive = selected?.date === s.date;
                return (
                  <li key={s.date} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelectedDate(s.date)}
                      className={`num flex-1 rounded px-2 py-1.5 text-left text-[12px] ${
                        isActive ? "bg-primary/15 font-semibold text-primary" : "hover:bg-muted"
                      }`}
                    >
                      {s.date}
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        {s.totalCount}종목 · A {s.gradeACount}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${s.date} 삭제`}
                      onClick={() => remove(s.date)}
                      className="rounded p-1 text-muted-foreground hover:text-down"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {selected ? (
            <div className="space-y-4">
              <section className="rounded-lg border border-border bg-card p-4">
                <h2 className="mb-2 text-sm font-semibold">{selected.date} 스크리닝 요약</h2>
                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {[
                    ["저장 시각 (KST)", formatKstDateTime(selected.savedAt)],
                    ["기준일", selected.asOfDate],
                    ["시장 게이트", selected.marketGateStatus],
                    ["전체 분석 종목", formatCount(selected.totalCount)],
                    ["Universe 통과", formatCount(selected.passedCount)],
                    ["A등급 / B등급", `${selected.gradeACount} / ${selected.gradeBCount}`],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-baseline justify-between gap-2 border-b border-border py-1.5"
                    >
                      <span className="text-[12px] text-muted-foreground">{label}</span>
                      <span className="num text-[13px] font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              </section>

              <div className="grid gap-4 sm:grid-cols-2">
                <section className="rounded-lg border border-border bg-card p-4">
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-up">
                    <ArrowUpRight className="size-4" />
                    신규 A등급 진입 {diff ? `(${diff.newGradeA.length})` : ""}
                  </h3>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    {diff?.previous
                      ? `${diff.previous.date} 스냅샷 대비 A등급으로 새로 올라온 종목입니다.`
                      : "비교할 이전 날짜 스냅샷이 없습니다."}
                  </p>
                  <EntryList entries={diff?.newGradeA ?? []} empty="해당 종목 없음" />
                </section>
                <section className="rounded-lg border border-border bg-card p-4">
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-down">
                    <ArrowDownRight className="size-4" />
                    A→B 하락 {diff ? `(${diff.droppedAtoB.length})` : ""}
                  </h3>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    {diff?.previous
                      ? `${diff.previous.date}에 A등급이었으나 B등급으로 내려온 종목입니다.`
                      : "비교할 이전 날짜 스냅샷이 없습니다."}
                  </p>
                  <EntryList entries={diff?.droppedAtoB ?? []} empty="해당 종목 없음" />
                </section>
              </div>

              <section className="rounded-lg border border-border bg-card p-4">
                <h3 className="mb-2 text-sm font-semibold">저장된 종목 (종합점수 상위 50)</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-1.5 pr-2 font-medium">종목</th>
                        <th className="py-1.5 pr-2 font-medium">구분</th>
                        <th className="py-1.5 pr-2 text-right font-medium">종합점수</th>
                        <th className="py-1.5 pr-2 text-right font-medium">기술점수</th>
                        <th className="py-1.5 pr-2 font-medium">등급</th>
                        <th className="py-1.5 font-medium">Universe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedEntries.map((e) => (
                        <tr key={e.symbol} className="border-b border-border/60 last:border-0">
                          <td className="py-1.5 pr-2">
                            <Link
                              to="/instrument/$symbol"
                              params={{ symbol: e.symbol }}
                              className="hover:underline"
                            >
                              {e.name}
                              <span className="num ml-1 text-[10px] text-muted-foreground">
                                {e.symbol}
                              </span>
                            </Link>
                          </td>
                          <td className="py-1.5 pr-2 text-muted-foreground">
                            {e.instrumentType === "ETF" ? "ETF" : "주식"}
                          </td>
                          <td className="num py-1.5 pr-2 text-right">
                            {formatNumber(e.totalScore, 1)}
                          </td>
                          <td className="num py-1.5 pr-2 text-right">{e.technicalPoints}</td>
                          <td className="py-1.5 pr-2 font-semibold">{e.grade}</td>
                          <td className="py-1.5 text-muted-foreground">
                            {e.hardFilterPassed ? "통과" : "실격"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
