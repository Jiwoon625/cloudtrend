import { SignalJournalCoverage } from "@/components/SignalJournalCoverage";
import type { SignalSnapshot } from "@/lib/signalJournal";
import {
  validScreeningStages,
  screeningStagesPath,
  screeningStageLabels,
  type ScreeningStage,
} from "@/lib/screeningStages";
import { supabase } from "@/lib/cloud";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSessionViewState, viewText, viewPage, viewChoice } from "@/lib/useSessionViewState";
import { validDate } from "@/lib/ledger/date";
import { AppShell } from "@/components/AppShell";
import { listScreeningArchive, screeningArchiveQueryOptions } from "@/lib/screeningArchiveQuery";
import { historyRecordKey, usHistorySignals } from "@/lib/usScreeningHistory";
import { formatKstDateTime } from "@/lib/format";
import {
  isHistoryOperationalEntry,
  historyEtfEvidence,
  historyEntryStatus,
  historyScoreLabel,
  historyEtfOnsetLabel,
} from "@/components/historyEntryPresentation";
export const Route = createFileRoute("/history")({
  ssr: false,
  head: () => ({ meta: [{ title: "스크리닝 이력 | CloudTrend" }] }),
  component: HistoryPage,
});
function HistoryPage() {
  const [market, setMarket] = useSessionViewState(
      "history:market",
      "ALL",
      viewChoice(["ALL", "KR", "US", "KOSPI", "KOSDAQ", "ETF"]),
    ),
    [strategy, setStrategy] = useSessionViewState(
      "history:strategy",
      "ALL",
      viewChoice(["ALL", "KR", "A0", "A2", "B3"]),
    ),
    [version, setVersion] = useSessionViewState("history:version", "ALL", viewText),
    [date, setDate] = useSessionViewState(
      "history:date",
      "",
      (v): v is string => typeof v === "string" && (v === "" || validDate(v)),
    ),
    [run, setRun] = useSessionViewState("history:run", "", viewText),
    [search, setSearch] = useSessionViewState("history:search", "", viewText),
    [page, setPage] = useSessionViewState("history:page", 0, viewPage);
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
          (strategy === "ALL" || (strategy === "KR" ? s.market !== "US" : s.market === "US")) &&
          (version === "ALL" || (s.strategyVersion ?? "과거 버전 미기록") === version) &&
          (market === "ALL" ||
            (market === "US" && s.market === "US") ||
            (market !== "US" && s.market !== "US")),
      ),
    [q.data, date, version, market, strategy],
  );
  const selected = runs.find((s) => historyRecordKey(s) === run) ?? runs[0];
  const stageQuery = useQuery({
    queryKey: ["screening-stage-status", selected?.runId],
    enabled: !!selected?.runId,
    retry: false,
    queryFn: async () => {
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth.user) throw new Error("로그인 확인 필요");
      const status = await supabase.storage
        .from("cloudtrend-data")
        .download(screeningStagesPath(auth.user.id, selected!.runId!));
      if (!status.error && status.data) {
        const saved = JSON.parse(await status.data.text());
        if (
          saved.version !== 1 ||
          saved.runId !== selected!.runId ||
          !validScreeningStages(saved.pipelineStatus)
        )
          throw new Error("단계별 상태 식별 불일치");
        return saved.pipelineStatus as Record<string, string>;
      }
      if (status.error && !/not.?found|404/i.test(status.error.message)) throw status.error;
      const { data, error } = await supabase
        .from("analysis_runs")
        .select("summary")
        .eq("user_id", auth.user.id)
        .eq("id", `screening-${selected!.runId}`)
        .maybeSingle();
      if (error) throw error;
      return (data?.summary?.pipelineStatus as Record<string, string> | undefined) ?? null;
    },
  });
  const detail = useQuery({
    ...screeningArchiveQueryOptions(selected ?? { asOfDate: "", savedAt: "" }),
    enabled: !!selected,
  });
  const entries = (detail.isError ? [] : (detail.data?.entries ?? [])).filter(
    (e) =>
      (market === "ALL" ||
        market === "US" ||
        market === "KR" ||
        e.market === market ||
        (market === "ETF" && e.instrumentType === "ETF")) &&
      (strategy === "ALL" ||
        (e.market === "US"
          ? usHistorySignals(e, strategy).entries.length > 0 ||
            usHistorySignals(e, strategy).exits.length > 0
          : strategy === "KR")) &&
      (!search || `${e.name} ${e.symbol}`.toLowerCase().includes(search.toLowerCase())),
  );
  const pages = Math.max(1, Math.ceil(entries.length / 50));
  const currentPage = Math.min(page, pages - 1);
  return (
    <AppShell loadAnalysis={false}>
      <header className="mb-4">
        <h1 className="text-xl font-bold">스크리닝 이력</h1>
        <p className="text-xs text-muted-foreground">
          매일의 전략 버전과 진입·청산 조건을 보존합니다. 신호는 실제 체결 내역이 아니며 수익률은
          계산하지 않습니다.
        </p>
      </header>
      <SignalJournalCoverage />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <select
          aria-label="시장"
          value={market}
          onChange={(e) => {
            setMarket(e.target.value);
            setPage(0);
          }}
        >
          {["ALL", "KR", "KOSPI", "KOSDAQ", "ETF", "US"].map((v) => (
            <option key={v} value={v}>
              {v === "ALL" ? "전체 시장" : v === "KR" ? "한국 전체" : v}
            </option>
          ))}
        </select>
        <select
          aria-label="전략"
          value={strategy}
          onChange={(e) => {
            setStrategy(e.target.value);
            setPage(0);
          }}
        >
          <option value="ALL">전체 전략</option>
          <option value="KR">한국 채택 전략</option>
          {["A0", "A2", "B3"].map((v) => (
            <option key={v} value={v}>
              {v} 신호
            </option>
          ))}
        </select>
        <select
          aria-label="전략 버전"
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
            setPage(0);
          }}
        >
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
          onChange={(e) => {
            setDate(e.target.value);
            setPage(0);
          }}
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
            value={historyRecordKey(selected)}
            onChange={(e) => {
              setRun(e.target.value);
              setPage(0);
            }}
          >
            {runs.map((s) => (
              <option key={historyRecordKey(s)} value={historyRecordKey(s)}>
                {s.asOfDate} · {s.market ?? "KR"} · {formatKstDateTime(s.savedAt)} KST ·{" "}
                {s.runId ?? "과거 일별 대표"}
                {s.historySource === "KR_ORIGINAL_RECOVERY" ? " · 잠정 원본 복원" : ""}
              </option>
            ))}
          </select>
          {detail.data?.historySource === "KR_ORIGINAL_RECOVERY" ? (
            <div
              role="note"
              className="rounded border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950"
            >
              <strong>잠정 원본 복원 · 확정 신호 아님</strong>
              <p>
                당시 실제 저장된 실행 결과입니다. 시가총액 등 필수 자료가 미확인된 상태와 계산
                신호를 그대로 보존했습니다.
              </p>
              <p>
                실제 거래 및 확정 일별 이력에는 반영하지 않습니다. 복원 등록:{" "}
                {formatKstDateTime(detail.data.storedAt!)} KST
              </p>
              <p className="break-all text-xs">
                원본 SHA256: {detail.data.recoveryEvidence?.sourceSha256}
              </p>
            </div>
          ) : null}
          {(detail.data as SignalSnapshot | undefined)?.signalJournal ? (
            <div className="rounded border p-3 text-xs">
              {(detail.data as SignalSnapshot).signalJournal.kind === "RECONSTRUCTED"
                ? "후일 자료로 복원한 신호"
                : "자료 수집 후 기록한 신호"}
              {" · 전략 "}
              {(detail.data as SignalSnapshot).signalJournal.rule.id.slice(0, 12)}
              {" · 적용 시작 "}
              {(detail.data as SignalSnapshot).signalJournal.rule.effectiveFrom}
              <p>
                매수·매도 조건 기록입니다. 수량·체결·손익 및 보유기간에 의존하는 청산은 분기
                연구에서 계산합니다.
              </p>
              {(detail.data as SignalSnapshot).signalJournal.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          ) : null}
          <p role="status" className="text-xs text-muted-foreground">
            {stageQuery.isError
              ? "단계별 상태 조회 실패"
              : stageQuery.isFetching
                ? "단계별 상태 확인 중…"
                : stageQuery.data
                  ? Object.entries(stageQuery.data)
                      .map(
                        ([key, value]) =>
                          `${({ screening: "스크리닝", signalHistory: "일별 신호 이력", actualPortfolio: "실제 평가", models: "모델 기록", publication: "완료 증빙" } as Record<string, string>)[key] ?? key}: ${screeningStageLabels[value as ScreeningStage] ?? value}`,
                      )
                      .join(" · ")
                  : "단계별 상태 미기록"}
          </p>
          {!selected.runId && selected.market !== "US" ? (
            <p className="text-xs text-muted-foreground">
              과거 기록에서 시장이 저장되지 않은 종목은 한국 전체에서 조회할 수 있습니다.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            기준일 {selected.asOfDate} · 전략 {selected.strategyVersion ?? "과거 버전 미기록"} ·
            실행 ID {selected.runId ?? "미기록"} · {selected.runId ? "실제 분석" : "과거 저장시각"}{" "}
            {formatKstDateTime(selected.savedAt)} KST
            {selected.historySource === "US_DAILY"
              ? " · 과거 일별 신호 기록: 원신호·적격·실행 ID·분석시각 미기록"
              : ""}
          </p>
          {detail.isPending ? (
            <p>선택한 실행 불러오는 중…</p>
          ) : detail.error ? (
            <div role="alert">
              {detail.error.message}{" "}
              <button onClick={() => void detail.refetch()}>다시 시도</button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            당시 저장된 계산 신호이며 실제 매수·매도 체결 기록이 아닙니다. ETF 기술점수는 M0와
            별개이며, 미기록·미확인 M0는 기술점수로 대체하지 않습니다.
          </p>
          <div className="overflow-auto rounded-lg border">
            <table className="w-full min-w-[800px] text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">종목</th>
                  <th>시장</th>
                  <th>점수</th>
                  <th>원신호</th>
                  <th>확인·진입 준비</th>
                  <th>계산 청산신호</th>
                  <th>당시 상태</th>
                </tr>
              </thead>
              <tbody>
                {!entries.length && !detail.isPending && !detail.error ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center">
                      선택한 조건의 저장 신호가 없습니다.
                    </td>
                  </tr>
                ) : null}
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
                          market: selected.market ?? "KR",
                          strategyVersion: selected.strategyVersion ?? "",
                          dataHash: selected.dataHash ?? "",
                          historySource:
                            selected.historySource === "KR_ORIGINAL_RECOVERY"
                              ? "KR_ORIGINAL_RECOVERY"
                              : undefined,
                        }}
                        className="text-primary hover:underline"
                      >
                        {e.name} · {e.symbol}
                      </Link>
                    </td>
                    <td>{e.market ?? (e.instrumentType === "ETF" ? "ETF" : "미기록")}</td>
                    <td>{historyScoreLabel(e, selected.asOfDate)}</td>
                    <td>
                      {e.instrumentType === "ETF"
                        ? historyEtfOnsetLabel(e, selected.asOfDate)
                        : e.market === "US" && usHistorySignals(e).onset === undefined
                          ? "미기록"
                          : e.kospi80Onset ||
                              e.kosdaq80Onset ||
                              e.evidence?.["rawOnset"] ||
                              historyEtfEvidence(e)?.rawOnset
                            ? "원신호"
                            : "—"}
                    </td>
                    <td>
                      {e.market === "US"
                        ? usHistorySignals(e, strategy).entries.join(" · ") || "—"
                        : (e.kospiEntry?.confirmationDate ??
                          (isHistoryOperationalEntry(e, selected.asOfDate) ||
                          historyEtfEvidence(e)?.entryState === "confirmed" ||
                          e.evidence?.["a0Entry"] === true
                            ? "진입 준비"
                            : "—"))}
                    </td>
                    <td>
                      {e.market === "US"
                        ? usHistorySignals(e, strategy).exits.join(" · ") || "—"
                        : (e.exitSignal ?? "—")}
                    </td>
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
