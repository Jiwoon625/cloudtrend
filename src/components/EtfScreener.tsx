import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { DomesticPositionContext } from "@/lib/positionSignalContext";
import { ETF_POLICY } from "@/lib/engine/etfStrategy";
import type { DualPortfolioState } from "@/lib/portfolioLedgers";
import { soldSymbolsSinceSignal } from "@/lib/dashboardOperations";
import type { AnalysisResult } from "@/lib/engine/pipeline";
import { etfPartialEvidence } from "@/lib/etfPartialEvidence";

const num = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("ko-KR", { maximumFractionDigits: digits });
const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "미확인" : `${num(n * 100)}%`;
const scoreText = (n: number | null) => (n === null ? "산정 불가" : num(n));
const evidenceText = (n: number | null, digits = 2) => (n === null ? "미확인" : num(n, digits));
const environmentNames = {
  stock_sector: "국내 주식 섹터",
  peer_mix_lag1: "지역 ETF 환경 · 전일",
  own_index_lag1: "기초지수 대체 · 전일",
  unavailable: "데이터 없음",
};

type SortDirection = "asc" | "desc";
type SortKey =
  | "instrument"
  | "score"
  | "previousScore"
  | "technical"
  | "priority"
  | "health"
  | "environment"
  | "tradingValue"
  | "signal"
  | "volatility"
  | "entryWeight"
  | "evidence";

const ETF_TABLE_COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "instrument", label: "종목" },
  { key: "score", label: "M0 / 100" },
  { key: "previousScore", label: "전일 M0" },
  { key: "technical", label: "기술 / 62.5" },
  { key: "priority", label: "Priority / 7.5" },
  { key: "health", label: "Health / 15" },
  { key: "environment", label: "환경 / 15" },
  { key: "signal", label: "신호·확인 일정" },
  { key: "tradingValue", label: "20일 평균 거래대금(원)" },
  { key: "volatility", label: "20일 변동성" },
  { key: "entryWeight", label: "신규 비중" },
  { key: "evidence", label: "데이터·환경 근거" },
];

const compareNullable = (
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: SortDirection,
) => {
  const aMissing = a == null || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b == null || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "ko", { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
};

export function EtfScreener({
  analysis,
  ledger,
  ledgerError,
  positionContext,
}: {
  analysis: AnalysisResult;
  ledger?: DualPortfolioState | undefined;
  ledgerError?: string | undefined;
  positionContext?: DomesticPositionContext | undefined;
}) {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("equity");
  const [sector, setSector] = useState("ALL");
  const [minimums, setMinimums] = useState({ score: 0, environment: 0, tradingValue: 0 });
  const unknownExit = filter === "exit" && (!positionContext || !!ledgerError);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const rows = analysis.rows.filter((r) => r.instrument.instrumentType === "ETF");
  const evidenceBySymbol = new Map(
    rows.map((r) => [r.instrument.symbol, etfPartialEvidence(r, analysis.asOfDate)]),
  );
  const evidenceFor = (r: AnalysisResult["rows"][number]) =>
    evidenceBySymbol.get(r.instrument.symbol)!;
  const krxPending = rows.find((r) => evidenceFor(r).krxPending)?.etfStrategy;
  const heldSet = new Set(positionContext?.heldSymbols ?? []);
  const blocked = (r: AnalysisResult["rows"][number]) =>
    soldSymbolsSinceSignal(
      ledger?.document.executions ?? [],
      "ETF",
      r.etfStrategy?.originDate ?? analysis.asOfDate,
    ).has(r.instrument.symbol);
  const actionable = (r: AnalysisResult["rows"][number]) =>
    !!ledger &&
    !!positionContext &&
    !ledgerError &&
    r.etfStrategy?.version === ETF_POLICY.version &&
    r.etfStrategy.onset &&
    r.etfStrategy.dataStatus !== "krx_batch_pending" &&
    !heldSet.has(r.instrument.symbol) &&
    !blocked(r);
  const getSignalLabel = (r: AnalysisResult["rows"][number]) => {
    const s = r.etfStrategy;
    const symbol = r.instrument.symbol;
    const confirmed = s?.version === ETF_POLICY.version;
    if (!confirmed || !evidenceFor(r).current) return "기준일 자료 미확인 · 재계산 필요";
    if (s.dataStatus === "krx_batch_pending") return "KRX 자료 대기 · 신호 판단 보류";
    if (!positionContext || ledgerError) return "보유 미확인 · 청산 판정 대기";
    if (heldSet.has(symbol))
      return s.exit === "MA60"
        ? "다음 시가 청산"
        : s.exit === "DATA_UNAVAILABLE"
          ? "데이터 오류 · 청산 점검"
          : "보유 · 추가 매수 없음";
    if (blocked(r)) return "청산한 신호 · 재진입 제외";
    if (s.entryState === "rejected") return "하루 확인 탈락";
    if (!s.eligible) return "대상·데이터 점검";
    if (s.entryState === "pending") return "하루 확인 대기";
    if (s.onset) return ledger ? "진입 준비 · 다음 시가 진입" : "진입 준비 · 보유정보 확인 필요";
    return s.score !== null && s.score >= 80 ? "80 이상 유지" : "관찰";
  };
  const getSortValue = (r: AnalysisResult["rows"][number], key: SortKey) => {
    const s = r.etfStrategy;
    const e = evidenceFor(r);
    const symbol = r.instrument.symbol;
    switch (key) {
      case "instrument":
        return `${r.instrument.name} ${symbol}`;
      case "score":
        return e.score;
      case "previousScore":
        return e.previousScore;
      case "technical":
        return e.technical;
      case "priority":
        return e.priority;
      case "health":
        return e.health;
      case "environment":
        return e.environment;
      case "tradingValue":
        return e.averageTradingValue20;
      case "signal":
        return getSignalLabel(r);
      case "volatility":
        return e.annualVolatility;
      case "entryWeight":
        return e.entryWeight;
      case "evidence":
        return s
          ? `${environmentNames[s.environmentSource]} ${s.issues.join(" ")}`
          : "새 전략 재계산 필요";
    }
  };
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection("asc");
  };
  const shown = rows
    .filter((r) => {
      const s = r.etfStrategy,
        text = `${r.instrument.symbol} ${r.instrument.name}`.toLowerCase();
      if (!text.includes(query.trim().toLowerCase())) return false;
      if (sector !== "ALL" && (s?.sector ?? r.instrument.sectorName) !== sector) return false;
      const e = evidenceFor(r);
      if (minimums.score > 0 && (e.score === null || e.score < minimums.score)) return false;
      if (
        minimums.environment > 0 &&
        (e.environment === null || e.environment < minimums.environment)
      )
        return false;
      if (
        minimums.tradingValue > 0 &&
        (e.averageTradingValue20 === null ||
          e.averageTradingValue20 < minimums.tradingValue * 100_000_000)
      )
        return false;
      if (filter === "entry") return actionable(r);
      if (filter === "pending")
        return s?.entryState === "pending" || s?.entryState === "data_pending";
      if (filter === "partial") return evidenceFor(r).krxPending;
      if (filter === "rejected") return s?.entryState === "rejected";
      if (filter === "exit")
        return (
          heldSet.has(r.instrument.symbol) &&
          (s?.exit != null || s?.dataStatus === "krx_batch_pending")
        );
      if (filter === "missing") return !s?.eligible;
      if (filter === "equity") {
        const evidence = evidenceFor(r);
        return s?.eligible === true || (evidence.krxPending && evidence.isStrategyTarget);
      }
      return true;
    })
    .sort((a, b) => {
      if (sortKey) {
        const compared = compareNullable(
          getSortValue(a, sortKey),
          getSortValue(b, sortKey),
          sortDirection,
        );
        if (compared !== 0) return compared;
      }
      return (
        Number(actionable(b)) - Number(actionable(a)) ||
        (b.etfStrategy?.averageTradingValue20 ?? -1) -
          (a.etfStrategy?.averageTradingValue20 ?? -1) ||
        a.instrument.symbol.localeCompare(b.instrument.symbol)
      );
    });
  const pageCount = Math.max(1, Math.ceil(shown.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  const downloadCsv = () => {
    const quote = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const body = [
      ["기준일", "전략 버전", ...ETF_TABLE_COLUMNS.map((c) => c.label)],
      ...shown.map((r) => [
        analysis.asOfDate,
        ETF_POLICY.version,
        ...ETF_TABLE_COLUMNS.map((c) => getSortValue(r, c.key)),
      ]),
    ]
      .map((row) => row.map(quote).join(","))
      .join("\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `cloudtrend-etf-${analysis.asOfDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">ETF 스크리너 </h1>
        <p className="text-xs text-muted-foreground">
          기준일 {analysis.asOfDate} · 전략 {ETF_POLICY.version} · 자료 {rows.length}종목
        </p>
      </header>
      {krxPending && (
        <section
          role="status"
          aria-label="KRX 자료 수신 상태"
          className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm text-slate-900"
        >
          <strong>{analysis.asOfDate} KRX 금액·기초지수 자료가 일괄 미수신 상태입니다</strong>
          <p>
            주가는 {analysis.asOfDate}, 직전 KRX 자료 확인일은 {krxPending.krxReferenceDate}입니다.
            KRX 일별 자료는 통상 다음 영업일 오전 8시(KST)에 발표됩니다. 현재 저장된 주가 기반
            기술·Priority·변동성과 계산 가능한 환경 근거는 아래에서 먼저 확인할 수 있습니다. KRX
            의존 항목은 미확인으로 남기며, 새 자료 수집 후 다시 스크리닝해야 당일 M0와 진입·청산
            신호를 확정할 수 있습니다. 전일 M0는 과거 참고값입니다.
          </p>
          <p>
            이 상태는 기초지수 MA60 하회 청산 신호와 구분합니다. 개별 종목의 이력 부족·전략 대상
            제외는 아래 데이터 근거에 별도로 남습니다.
          </p>
        </section>
      )}
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <div className="rounded-lg border p-3">
          원신호 {rows.filter((r) => r.etfStrategy?.rawOnset).length}
        </div>
        <div className="rounded-lg border p-3">
          확인 대기 {rows.filter((r) => r.etfStrategy?.entryState === "pending").length}
        </div>
        <div className="rounded-lg border p-3">
          진입 준비{" "}
          {positionContext && !ledgerError ? rows.filter(actionable).length : "보유 확인 대기"}
        </div>
      </div>
      <p className="text-xs">
        <Link to="/portfolio" className="text-primary hover:underline">
          ETF 자금·보유·주문 계획은 포트폴리오에서 확인
        </Link>
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          className="max-w-xs"
          aria-label="ETF 검색"
          placeholder="ETF 이름 / 코드"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label="ETF 신호 필터"
          className="rounded-md border bg-background p-2 text-sm"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="equity">전략 대상 · 부분 판단 포함</option>
          <option value="partial">KRX 대기 · 부분 판단</option>
          <option value="entry">진입 준비 · 신규 진입</option>
          <option value="pending">하루 확인 대기</option>
          <option value="rejected">하루 확인 탈락</option>
          <option value="exit" disabled={!positionContext || !!ledgerError}>
            보유 ETF 청산·점검
          </option>
          <option value="missing">대상 제외·데이터 점검</option>
          <option value="all">전체 ETF</option>
        </select>
        <span className="text-sm text-muted-foreground">
          {unknownExit ? "미확인" : shown.length}/{rows.length}종목 · 신규 신호{" "}
          {positionContext && !ledgerError ? rows.filter(actionable).length : "미확인"}건 · KRX 대기{" "}
          {rows.filter((r) => evidenceFor(r).krxPending).length}건 · 데이터·대상 점검{" "}
          {rows.filter((r) => !r.etfStrategy?.eligible && !evidenceFor(r).krxPending).length}건
        </span>
      </div>
      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-4 text-xs">
        <label className="space-y-1">
          섹터
          <select
            aria-label="ETF 섹터"
            className="block h-8 w-full rounded border bg-background"
            value={sector}
            onChange={(e) => {
              setSector(e.target.value);
              setPage(0);
            }}
          >
            <option value="ALL">전체 섹터</option>
            {[...new Set(rows.map((r) => r.etfStrategy?.sector ?? r.instrument.sectorName))]
              .sort()
              .map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
          </select>
        </label>
        {(
          [
            ["score", "M0 최소"],
            ["environment", "환경점수 최소"],
            ["tradingValue", "20일 평균 거래대금 최소(억원)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="space-y-1">
            {label}
            <Input
              aria-label={label}
              type="number"
              min={0}
              step="any"
              className="h-8 text-xs"
              value={minimums[key]}
              onChange={(e) => {
                setMinimums({ ...minimums, [key]: Math.max(0, Number(e.target.value) || 0) });
                setPage(0);
              }}
            />
          </label>
        ))}
      </div>
      {unknownExit ? (
        <p role="status" className="text-xs">
          보유 조회가 완료되면 청산 목록을 표시합니다.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={downloadCsv}>
              CSV 다운로드
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              {currentPage + 1}/{pageCount}페이지
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              이전
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              다음
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs whitespace-nowrap">
              <thead className="bg-muted">
                <tr>
                  {ETF_TABLE_COLUMNS.map((column) => {
                    const active = sortKey === column.key;
                    return (
                      <th
                        key={column.key}
                        className="p-0 text-left"
                        aria-sort={
                          active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"
                        }
                      >
                        <button
                          type="button"
                          className="flex w-full items-center gap-1 p-3 text-left font-semibold hover:bg-muted-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => handleSort(column.key)}
                          title={`${column.label} 정렬`}
                        >
                          <span>{column.label}</span>
                          <span className="text-xs text-muted-foreground" aria-hidden="true">
                            {active ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.slice(currentPage * 100, (currentPage + 1) * 100).map((r) => {
                  const s = r.etfStrategy,
                    symbol = r.instrument.symbol;
                  const label = getSignalLabel(r);
                  const e = evidenceFor(r);
                  return (
                    <tr key={symbol} className="border-t align-top">
                      <td className="p-3">
                        <Link
                          to="/instrument/$symbol"
                          params={{ symbol }}
                          className="font-medium hover:underline"
                        >
                          {r.instrument.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {symbol} · {s?.region ?? "분류 없음"} ·{" "}
                          {s?.sector ?? r.instrument.sectorName}
                        </div>
                      </td>
                      <td className="p-3 font-semibold">
                        {scoreText(e.score)}
                        {e.krxPending && <div className="text-xs font-normal">KRX 자료 대기</div>}
                      </td>
                      <td className="p-3">
                        {scoreText(e.previousScore)}
                        {e.previousScore !== null && (
                          <div className="text-xs text-muted-foreground">
                            {e.previousDate} · 과거 참고
                          </div>
                        )}
                      </td>
                      <td className="p-3">{scoreText(e.technical)}</td>
                      <td className="p-3">{scoreText(e.priority)}</td>
                      <td className="p-3">
                        {scoreText(e.health)}
                        {e.krxPending && <div className="text-xs">KRX 시총·거래대금 미확인</div>}
                      </td>
                      <td className="p-3">{scoreText(e.environment)}</td>
                      <td className="p-3">
                        <strong>{label}</strong>
                        {e.current && s?.originDate && (
                          <div className="text-xs">
                            원신호 {s.originDate} · 확인 {s.confirmationDate ?? "다음 거래일 종가"}
                          </div>
                        )}
                        {s?.confirmationIssues?.length ? (
                          <div className="text-xs whitespace-normal max-w-64">
                            {s.confirmationIssues.join(" · ")}
                          </div>
                        ) : null}
                        <div className="text-xs text-muted-foreground">
                          기초지수 {evidenceText(e.underlyingClose)} / MA60{" "}
                          {evidenceText(e.underlyingMa60)}
                        </div>
                        <div className="text-xs">
                          {e.underlyingJudgment === "below_ma60"
                            ? "관측 근거: 기초지수 MA60 하회"
                            : e.underlyingJudgment === "above_ma60"
                              ? "관측 근거: 기초지수 MA60 이상"
                              : "기초지수 MA60 판단 미확인"}
                        </div>
                      </td>
                      <td className="p-3">{evidenceText(e.averageTradingValue20, 0)}</td>
                      <td className="p-3">{pct(e.annualVolatility)}</td>
                      <td className="p-3">{pct(e.entryWeight)}</td>
                      <td className="p-3 whitespace-normal min-w-48 text-xs">
                        <p>{e.provenanceLabel}</p>
                        {e.current && s
                          ? environmentNames[s.environmentSource]
                          : "환경 출처 미확인"}
                        {e.krxPending && <p>부분 근거만 표시 · M0·진입·청산 확정 대기</p>}
                        {s?.issues.length ? <p>{s.issues.join(" · ")}</p> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!shown.length && (
              <p className="p-6 text-sm text-muted-foreground">
                표시할 ETF가 없습니다. 전체 또는 데이터 점검 필터에서 입력 상태를 확인해 주세요.
              </p>
            )}
          </div>
        </>
      )}
      <details className="rounded-lg border p-3 text-sm">
        <summary>운영규칙·산식</summary>
        <Link to="/operating-rules" className="text-primary">
          운영규칙에서 ETF 채택 기준 확인
        </Link>
      </details>
    </div>
  );
}
