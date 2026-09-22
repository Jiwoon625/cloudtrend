import { getStoredOperationalExit, isOperationalEntry } from "@/lib/engine/operationalStrategy";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, History, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCount, formatKstDateTime, formatNumber } from "@/lib/format";
import { useSnapshots, type SnapshotEntry } from "@/lib/screeningHistory";
import { topTechnicalEntries } from "@/lib/screeningSnapshot";

export const Route = createFileRoute("/history")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "스크리닝 이력 | TrendScore KR" },
      {
        name: "description",
        content:
          "날짜별 스크리닝 결과와 KOSPI / KOSDAQ 8.0 Onset·Exit 조건 달성 종목, 기술점수·우선점수·운영상태를 조회합니다.",
      },
      { property: "og:title", content: "스크리닝 이력 | TrendScore KR" },
      {
        property: "og:description",
        content: "일별 마지막 스크리닝 스냅샷과 V8 운영신호 기록.",
      },
    ],
  }),
  component: HistoryPage,
});

function isOperational8Onset(entry: SnapshotEntry): boolean {
  if (isOperationalEntry(entry)) return true;
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*80\s*Onset|KOSDAQ\s*8\s*ONSET/i.test(entry.status ?? "");
}

function isOperationalExit(entry: SnapshotEntry): boolean {
  if (getStoredOperationalExit(entry, "KOSPI")) return true;
  if (entry.exitSignal === "UP90" || entry.exitSignal === "DOWN30") return true;
  return /KOSDAQ\s*Exit/i.test(entry.status ?? "");
}

function historyStatus(entry: SnapshotEntry): string {
  const status = entry.status?.trim() || (entry.hardFilterPassed ? "관찰" : "실격");
  return status
    .replace(/KOSDAQ80 Onset/gi, "KOSDAQ 8 ONSET")
    .replace(/KOSDAQ 80 Onset/gi, "KOSDAQ 8 ONSET");
}

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

function TopEntriesTable({
  title,
  subtitle,
  entries,
}: {
  title: string;
  subtitle: string;
  entries: SnapshotEntry[];
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-[12px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1.5 pr-2 font-medium">순위</th>
              <th className="py-1.5 pr-2 font-medium">종목</th>
              <th className="py-1.5 pr-2 text-right font-medium">기술점수</th>
              <th className="py-1.5 pr-2 text-right font-medium">우선점수</th>
              <th className="py-1.5 pr-2 font-medium">등급</th>
              <th className="py-1.5 font-medium">상태</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, index) => (
              <tr key={e.symbol} className="border-b border-border/60 last:border-0">
                <td className="num py-1.5 pr-2 text-muted-foreground">{index + 1}</td>
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
                <td className="num py-1.5 pr-2 text-right">
                  {e.technicalPoints === null ? "-" : formatNumber(e.technicalPoints, 1)}
                </td>
                <td className="num py-1.5 pr-2 text-right">
                  {formatNumber(e.priorityPoints, 1)}
                </td>
                <td className="py-1.5 pr-2 font-semibold">{e.grade}</td>
                <td className="py-1.5 font-medium">{historyStatus(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoryPage() {
  const { snapshots, remove, clear } = useSnapshots();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = useMemo(
    () => snapshots.find((s) => s.date === selectedDate) ?? snapshots[0] ?? null,
    [snapshots, selectedDate],
  );

  const entryOnsets = useMemo(() => selected?.entries.filter(isOperational8Onset) ?? [], [selected]);
  const exitConditionMet = useMemo(() => selected?.entries.filter(isOperationalExit) ?? [], [selected]);

  const stockTopEntries = useMemo(
    () =>
      selected
        ? (selected.topStocks ?? topTechnicalEntries(selected.entries, "STOCK"))
        : [],
    [selected],
  );
  const etfTopEntries = useMemo(
    () =>
      selected
        ? (selected.topEtfs ?? topTechnicalEntries(selected.entries, "ETF"))
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
            하루에 여러 번 스크리닝하면 그날의 마지막 결과만 Supabase에 저장됩니다. 최근 90개 날짜를
            모든 기기에서 공유합니다.
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
                    KOSPI / KOSDAQ 신규 진입 ({entryOnsets.length})
                  </h3>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    해당 스크리닝일에 KOSPI / KOSDAQ 8.0 신규 상향 돌파 진입조건을 달성한
                    종목입니다.
                  </p>
                  <EntryList entries={entryOnsets} empty="해당 종목 없음" />
                </section>
                <section className="rounded-lg border border-border bg-card p-4">
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-down">
                    <ArrowDownRight className="size-4" />
                    EXIT조건 달성 ({exitConditionMet.length})
                  </h3>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    KOSPI 9.5점 상향돌파 또는 KOSDAQ 9.0점 상향 재돌파 / 3.0점 하향 이탈 Exit 조건을
                    달성한 종목입니다.
                  </p>
                  <EntryList entries={exitConditionMet} empty="해당 종목 없음" />
                </section>
              </div>

              <TopEntriesTable
                title={`주식 기술점수 TOP 50 (${stockTopEntries.length})`}
                subtitle="주식은 10점 만점 기술점수를 기준으로 별도 정렬합니다."
                entries={stockTopEntries}
              />
              <TopEntriesTable
                title={`ETF 기술점수 TOP 50 (${etfTopEntries.length})`}
                subtitle="ETF는 100점 만점 기술점수를 기준으로 별도 정렬합니다."
                entries={etfTopEntries}
              />
            </div>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
