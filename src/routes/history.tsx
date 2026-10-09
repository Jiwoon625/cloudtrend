import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { listScreeningArchive, readScreeningArchive } from "@/lib/screeningArchiveQuery";
import { formatKstDateTime } from "@/lib/format";
import {
  isHistoryOperationalEntry,
  historyEtfEvidence,
  historyEntryStatus,
} from "@/components/historyEntryPresentation";
export const Route = createFileRoute("/history")({
  ssr: false,
  head: () => ({ meta: [{ title: "스크리닝 이력 | CloudTrend" }] }),
  component: HistoryPage,
});
function HistoryPage() {
  const [market, setMarket] = useState("ALL"),
    [version, setVersion] = useState("ALL"),
    [date, setDate] = useState(""),
    [run, setRun] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ["screening-execution-history", date],
    queryFn: () => listScreeningArchive(date || undefined),
    retry: false,
  });
  const runs = useMemo(
    () =>
      (q.data ?? []).filter(
        (s) =>
          (!date || s.asOfDate === date) &&
          (version === "ALL" || (s.strategyVersion ?? "과거 버전 미기록") === version) &&
          (market === "ALL" ||
            (market === "US" && s.market === "US") ||
            (market !== "US" && s.market !== "US")),
      ),
    [q.data, date, version, market],
  );
  const selected = runs.find((s) => (s.runId ?? s.savedAt) === run) ?? runs[0];
  const detail = useQuery({
    queryKey: ["screening-execution", selected?.runId, selected?.asOfDate, selected?.savedAt],
    enabled: !!selected,
    queryFn: () =>
      readScreeningArchive(selected!.runId ?? "", selected!.asOfDate, selected!.savedAt),
    retry: false,
  });
  const entries = (detail.data?.entries ?? []).filter(
    (e) =>
      (market === "ALL" ||
        market === "US" ||
        e.market === market ||
        (market === "ETF" && e.instrumentType === "ETF")) &&
      (!search || `${e.name} ${e.symbol}`.toLowerCase().includes(search.toLowerCase())),
  );
  const pages = Math.max(1, Math.ceil(entries.length / 50));
  const currentPage = Math.min(page, pages - 1);
  return (
    <AppShell>
      <header className="mb-4">
        <h1 className="text-xl font-bold">스크리닝 이력</h1>
        <p className="text-xs text-muted-foreground">
          실행별 보존 기록과 과거 일별 대표 기록 · 최근 90개 실행/날짜 조회
        </p>
      </header>
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <select
          aria-label="시장"
          value={market}
          onChange={(e) => {
            setMarket(e.target.value);
            setPage(0);
          }}
        >
          {["ALL", "KOSPI", "KOSDAQ", "ETF", "US"].map((v) => (
            <option key={v} value={v}>
              {v === "ALL" ? "전체 시장" : v}
            </option>
          ))}
        </select>
        <select aria-label="전략 버전" value={version} onChange={(e) => setVersion(e.target.value)}>
          <option value="ALL">전체 전략 버전</option>
          {[...new Set((q.data ?? []).map((s) => s.strategyVersion ?? "과거 버전 미기록"))].map(
            (v) => (
              <option key={v}>{v}</option>
            ),
          )}
        </select>
        <input
          aria-label="기준일"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <input
          aria-label="종목 검색"
          placeholder="종목명·코드 검색"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </div>
      {q.isPending ? (
        <p>이력 불러오는 중…</p>
      ) : q.error ? (
        <div role="alert">
          {q.error.message}
          <button onClick={() => void q.refetch()}>다시 시도</button>
        </div>
      ) : !selected ? (
        <p>선택한 조건의 기록이 없습니다.</p>
      ) : (
        <div className="space-y-4">
          <select
            className="w-full rounded border p-2 text-xs"
            aria-label="실행 기록"
            value={selected.runId ?? selected.savedAt}
            onChange={(e) => {
              setRun(e.target.value);
              setPage(0);
            }}
          >
            {runs.map((s) => (
              <option key={s.runId ?? s.savedAt} value={s.runId ?? s.savedAt}>
                {s.asOfDate} · {s.market ?? "KR"} · {formatKstDateTime(s.savedAt)} ·{" "}
                {s.runId ?? "과거 일별 대표"}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            기준일 {selected.asOfDate} · 전략 {selected.strategyVersion ?? "과거 버전 미기록"} ·
            실행 ID {selected.runId ?? "미기록"} · {selected.runId ? "실제 분석" : "과거 저장시각"}{" "}
            {formatKstDateTime(selected.savedAt)}
          </p>
          {detail.isPending ? (
            <p>선택한 실행 불러오는 중…</p>
          ) : detail.error ? (
            <p role="alert">{detail.error.message}</p>
          ) : null}
          <div className="overflow-auto rounded-lg border">
            <table className="w-full min-w-[800px] text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">종목</th>
                  <th>시장</th>
                  <th>점수</th>
                  <th>원신호</th>
                  <th>확인·진입 준비</th>
                  <th>청산 기록</th>
                  <th>당시 상태</th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(currentPage * 50, (currentPage + 1) * 50).map((e) => (
                  <tr key={e.symbol} className="border-b">
                    <td className="p-2">
                      <Link
                        to="/history-instrument/$symbol"
                        params={{ symbol: e.symbol }}
                        search={{
                          runId: selected.runId ?? "",
                          date: selected.asOfDate,
                          savedAt: selected.savedAt,
                        }}
                        className="text-primary hover:underline"
                      >
                        {e.name} · {e.symbol}
                      </Link>
                    </td>
                    <td>{e.market ?? (e.instrumentType === "ETF" ? "ETF" : "미기록")}</td>
                    <td>{e.technicalPoints ?? "미관측"}</td>
                    <td>
                      {e.kospi80Onset ||
                      e.kosdaq80Onset ||
                      e.evidence?.["rawOnset"] ||
                      historyEtfEvidence(e)?.rawOnset
                        ? "원신호"
                        : "—"}
                    </td>
                    <td>
                      {e.kospiEntry?.confirmationDate ??
                        (isHistoryOperationalEntry(e, selected.asOfDate) ||
                        historyEtfEvidence(e)?.entryState === "confirmed" ||
                        e.evidence?.["a0Entry"] === true
                          ? "진입 준비"
                          : "—")}
                    </td>
                    <td>{e.exitSignal ?? "—"}</td>
                    <td>{historyEntryStatus(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs">
            <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              이전
            </button>
            <span>
              {currentPage + 1} / {pages} · {entries.length}종목
            </span>
            <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>
              다음
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
