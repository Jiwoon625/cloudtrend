import { CompactStockStatus } from "./CompactStockStatus";
import { getCompactStockStatus, getCompactStockWarnings } from "@/lib/stockCompactStatus";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Download, Minus } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KospiEntryDetails } from "@/components/KospiEntryDetails";
import { OnsetProfileDetails } from "@/components/OnsetProfileDetails";
import { StockAssessmentDetails } from "./StockAssessmentDetails";
import { stockAssessmentDisplay } from "@/lib/stockAssessmentDisplay";
import { UniverseFilterDetails } from "@/components/UniverseFilterDetails";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import { formatNumber, formatPercent, formatPrice, formatWon } from "@/lib/format";
import { getKospiRsAccel } from "@/lib/kospiRelativeQuality";
import {
  getPortfolioAwareDisplayStatus,
  isPortfolioAwareOperationalEntry,
} from "@/lib/statusDisplay";
import { entrySuppressionReason, type DomesticPositionContext } from "@/lib/positionSignalContext";
import { getDisplayWarnings } from "@/lib/warningDisplay";

export function GradeBadge({ grade }: { grade: "A" | "B" | "C" }) {
  const cls =
    grade === "A"
      ? "bg-up-soft text-up border-up/30"
      : grade === "B"
        ? "bg-info-soft text-info border-info/30"
        : "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-bold ${cls}`}>
      {grade}등급
    </span>
  );
}

export function Delta({ value, digits = 1 }: { value: number | null; digits?: number }) {
  if (value === null) return <span className="text-muted-foreground">데이터 없음</span>;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const cls = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 ${cls}`}>
      <Icon className="size-3" aria-hidden />
      {formatPercent(value, digits)}
    </span>
  );
}

function ScoreDelta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">-</span>;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const cls = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground";
  // Stored deltas use the legacy 100-point scale; the displayed score is /10.
  const score10 = value / 10;
  const signed = score10 > 0 ? `+${formatNumber(score10, 1)}` : formatNumber(score10, 1);
  return (
    <span
      className={`inline-flex items-center justify-end gap-0.5 font-semibold ${cls}`}
      aria-label={`전 거래일 대비 ${signed}점`}
    >
      <Icon className="size-3" aria-hidden />
      {signed}p
    </span>
  );
}

function RsAccel({
  row,
  positionContext,
  signalDate,
}: {
  row: ScreeningRow;
  positionContext?: DomesticPositionContext | undefined;
  signalDate: string;
}) {
  const value = getKospiRsAccel(row);
  if (value === null) return <span className="text-muted-foreground">-</span>;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const cls = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground";
  const signed = value > 0 ? `+${formatNumber(value, 2)}` : formatNumber(value, 2);
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className={`inline-flex items-center justify-end gap-0.5 font-semibold ${cls}`}>
        <Icon className="size-3" aria-hidden />
        {signed}%p
      </span>
      {isPortfolioAwareOperationalEntry(row, positionContext, signalDate) &&
      row.instrument.market === "KOSPI" ? (
        <span className="text-[10px] font-medium text-up">확인일 RS 통과</span>
      ) : null}
    </span>
  );
}

type SortKey =
  | "entry"
  | "scoreDelta1d"
  | "technical"
  | "priority"
  | "volumeRatio"
  | "rs20"
  | "rsAccel"
  | "distanceHigh"
  | "marketCap"
  | "close";

const COLUMNS: Array<{ key: SortKey | "static"; label: string; id: string }> = [
  { key: "static", label: "순위", id: "rank" },
  { key: "static", label: "종목명", id: "name" },
  { key: "static", label: "시장", id: "market" },
  { key: "static", label: "섹터", id: "sector" },
  { key: "close", label: "종가", id: "close" },
  { key: "technical", label: "기술점수", id: "technical" },
  { key: "priority", label: "우선점수", id: "priority" },
  { key: "scoreDelta1d", label: "점수 변동(1D)", id: "scoreDelta1d" },
  { key: "static", label: "모델등급", id: "grade" },
  { key: "volumeRatio", label: "거래량 비율", id: "volumeRatio" },
  { key: "rs20", label: "RS20", id: "rs20" },
  { key: "rsAccel", label: "RSAccel", id: "rsAccel" },
  { key: "distanceHigh", label: "52주 고점 거리", id: "distanceHigh" },
  { key: "marketCap", label: "시가총액", id: "marketCap" },
  { key: "static", label: "상태", id: "status" },
  { key: "static", label: "경고", id: "warnings" },
];

function technicalValue(row: ScreeningRow): number | null {
  if (row.instrument.instrumentType === "STOCK") return row.operatingScore10;
  return (row.vf ?? row.technical).points;
}

function sortValue(
  row: ScreeningRow,
  key: SortKey,
  positionContext: DomesticPositionContext | undefined,
  signalDate: string,
): number | null {
  switch (key) {
    case "entry":
      return Number(isPortfolioAwareOperationalEntry(row, positionContext, signalDate));
    case "scoreDelta1d":
      return row.scoreDelta1d;
    case "technical":
      return technicalValue(row);
    case "priority":
      return row.priority.points;
    case "volumeRatio":
      return row.snapshot.volumeRatio20;
    case "rs20":
      return row.rs20;
    case "rsAccel":
      return getKospiRsAccel(row);
    case "distanceHigh":
      return row.snapshot.distanceFrom52wHigh;
    case "marketCap":
      return row.marketCap;
    case "close":
      return row.snapshot.close;
  }
}

export function ScreenerTable({
  rows,
  positionContext,
  signalDate,
  tradeDates,
  compactStock = false,
}: {
  rows: ScreeningRow[];
  positionContext?: DomesticPositionContext | undefined;
  signalDate: string;
  tradeDates?: readonly string[];
  compactStock?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("entry");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<string[]>([]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortValue(a, sortKey, positionContext, signalDate);
      const bv = sortValue(b, sortKey, positionContext, signalDate);
      if (av === null && bv === null) return a.instrument.symbol.localeCompare(b.instrument.symbol);
      if (av === null) return 1;
      if (bv === null) return -1;
      const diff = av - bv;
      if (diff === 0) {
        if (sortKey === "entry") {
          const technicalDiff = (technicalValue(b) ?? -Infinity) - (technicalValue(a) ?? -Infinity);
          if (technicalDiff !== 0) return technicalDiff;
        }
        if (sortKey === "technical" || sortKey === "entry") {
          const priorityDiff = b.priority.points - a.priority.points;
          if (priorityDiff !== 0) return priorityDiff;
        }
        if (sortKey === "rsAccel") {
          const priorityDiff = b.priority.points - a.priority.points;
          if (priorityDiff !== 0) return priorityDiff;
        }
        return a.instrument.symbol.localeCompare(b.instrument.symbol);
      }
      return dir === "desc" ? -diff : diff;
    });
    return copy;
  }, [rows, sortKey, dir, positionContext, signalDate]);

  const columns = compactStock
    ? COLUMNS.filter((c) =>
        ["name", "sector", "close", "technical", "scoreDelta1d", "status"].includes(c.id),
      )
    : COLUMNS;
  const visible = columns.filter((c) => !hidden.includes(c.id));

  const pageCount = Math.max(1, Math.ceil(sorted.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  const downloadCsv = () => {
    const header = visible.map((c) => c.label).join(",");
    const lines = sorted.map((r, i) => {
      const tech = technicalValue(r);
      const rsAccel = getKospiRsAccel(r);
      const compactStatus = compactStock
        ? getCompactStockStatus(r, positionContext, signalDate, tradeDates)
        : null;
      const values: Record<string, string | number> = {
        rank: i + 1,
        name: r.instrument.name,
        market: r.instrument.market,
        sector: r.instrument.sectorName,
        close: r.snapshot.close,
        technical:
          tech === null
            ? "산정 불가"
            : `${tech.toFixed(2)}/${r.instrument.instrumentType === "STOCK" ? "10" : (r.vf ?? r.technical).maxPoints}`,
        priority: `${r.priority.points.toFixed(2)}/${r.priority.maxPoints.toFixed(1)}`,
        scoreDelta1d: r.scoreDelta1d == null ? "" : (r.scoreDelta1d / 10).toFixed(1),
        grade: r.grade,
        volumeRatio: r.snapshot.volumeRatio20?.toFixed(1) ?? "",
        rs20: r.rs20?.toFixed(2) ?? "",
        rsAccel: rsAccel?.toFixed(2) ?? "",
        distanceHigh: r.snapshot.distanceFrom52wHigh?.toFixed(2) ?? "",
        marketCap: r.marketCap ?? "",
        status: compactStatus
          ? [compactStatus.primary, compactStatus.secondary].join(" · ")
          : getPortfolioAwareDisplayStatus(r, positionContext, signalDate),
        warnings: getDisplayWarnings(r).join("|"),
      };
      return visible.map((c) => values[c.id] ?? "").join(",");
    });
    const blob = new Blob([`\uFEFF${header}\n${lines.join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trendscore-kr-screening.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const th = (col: (typeof COLUMNS)[number]) => {
    const numeric = !["rank", "name", "market", "sector", "grade", "status", "warnings"].includes(
      col.id,
    );
    if (col.key === "static")
      return (
        <th
          key={col.id}
          className={`sticky top-0 z-10 whitespace-nowrap bg-surface-strong px-2 py-2 text-[11px] font-semibold ${compactStock && col.id === "name" ? "left-0 z-20 w-24 sm:w-36" : ""} ${numeric ? "text-right" : "text-left"}`}
        >
          {col.label}
        </th>
      );
    const active = sortKey === col.key;
    return (
      <th
        key={col.id}
        className="sticky top-0 z-10 whitespace-nowrap bg-surface-strong px-2 py-2 text-right text-[11px] font-semibold"
      >
        <button
          type="button"
          className={`inline-flex items-center gap-1 ${active ? "text-primary" : ""}`}
          onClick={() => {
            if (active) setDir(dir === "desc" ? "asc" : "desc");
            else {
              setSortKey(col.key as SortKey);
              setDir("desc");
            }
          }}
        >
          {col.label}
          {active ? (
            dir === "desc" ? (
              <ArrowDown className="size-3" />
            ) : (
              <ArrowUp className="size-3" />
            )
          ) : null}
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={downloadCsv}>
          <Download className="size-3.5" /> CSV 다운로드
        </Button>
        <div className="flex flex-wrap gap-1">
          {columns
            .filter((c) => !["rank", "name"].includes(c.id))
            .map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  setHidden((h) => (h.includes(c.id) ? h.filter((x) => x !== c.id) : [...h, c.id]))
                }
                className={`rounded border px-1.5 py-0.5 text-[10px] ${hidden.includes(c.id) ? "border-border text-muted-foreground line-through" : "border-primary/30 bg-info-soft text-info"}`}
              >
                {c.label}
              </button>
            ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {sorted.length}건 · {currentPage + 1}/{pageCount}페이지
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

      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-card">
        <table
          className={`w-full text-[12px] ${compactStock ? "min-w-[640px] sm:min-w-[720px]" : "min-w-[1200px]"}`}
          aria-label={compactStock ? "주식 핵심 목록" : undefined}
        >
          <thead>
            <tr>{visible.map((c) => th(c))}</tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={visible.length} className="p-6 text-center text-muted-foreground">
                  조건에 맞는 종목이 없습니다. 검색·필터를 조정해 주세요.
                </td>
              </tr>
            ) : null}
            {sorted.slice(currentPage * 100, (currentPage + 1) * 100).map((r, offset) => {
              const i = currentPage * 100 + offset;
              const tech = technicalValue(r);
              const techBlock = r.vf ?? r.technical;
              const displayWarnings = compactStock
                ? getCompactStockWarnings(r)
                : getDisplayWarnings(r);
              const displayStatus = getPortfolioAwareDisplayStatus(r, positionContext, signalDate);
              const instrumentLink = (
                <Link
                  to="/instrument/$symbol"
                  params={{ symbol: r.instrument.symbol }}
                  className={`font-medium text-primary hover:underline ${compactStock ? "block truncate" : ""}`}
                >
                  {r.instrument.name}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {r.instrument.symbol}
                  </span>
                </Link>
              );
              const cells: Record<string, React.ReactNode> = {
                rank: <span className="num">{i + 1}</span>,
                name: compactStock ? (
                  <div className="w-24 max-w-24 sm:w-36 sm:max-w-36">
                    {instrumentLink}
                    {compactStock && displayWarnings.length ? (
                      <Link
                        to="/instrument/$symbol"
                        params={{ symbol: r.instrument.symbol }}
                        className="block truncate text-[10px] text-warn"
                        title={displayWarnings.join(" · ")}
                      >
                        주의 · {displayWarnings[0]}
                        {displayWarnings.length > 1 ? ` 외 ${displayWarnings.length - 1}건` : ""}
                      </Link>
                    ) : null}
                  </div>
                ) : (
                  instrumentLink
                ),
                market: <span>{r.instrument.market}</span>,
                sector: (
                  <span
                    className={compactStock ? "block max-w-24 truncate" : undefined}
                    title={compactStock ? r.instrument.sectorName : undefined}
                  >
                    {r.instrument.sectorName}
                  </span>
                ),
                close: <span className="num">{formatPrice(r.snapshot.close)}</span>,
                technical: compactStock ? (
                  <span className="num font-semibold">
                    {tech === null || !Number.isFinite(tech)
                      ? "산정 불가"
                      : `${formatNumber(tech, 1)}/10`}
                  </span>
                ) : (
                  <span className="num font-semibold">
                    {tech === null ? (
                      <>
                        <span className="text-warn">산정 불가</span>
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          원점수 {formatNumber(techBlock.points, 1)}/
                          {formatNumber(techBlock.maxPoints, 1)}
                        </span>
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          산정 가능 {formatNumber(techBlock.availableMaxPoints, 1)}
                        </span>
                      </>
                    ) : (
                      <>
                        {formatNumber(tech, 1)}/
                        {r.instrument.instrumentType === "STOCK"
                          ? "10"
                          : formatNumber(techBlock.maxPoints, 1)}
                        {techBlock.availableMaxPoints < techBlock.maxPoints ? (
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            산정 가능 {formatNumber(techBlock.availableMaxPoints, 1)}
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
                ),
                priority: (
                  <span className="num">
                    {formatNumber(r.priority.points, 2)}/{formatNumber(r.priority.maxPoints, 1)}
                    {r.priority.availableMaxPoints < r.priority.maxPoints ? (
                      <span className="block text-[10px] text-muted-foreground">
                        산정 가능 {formatNumber(r.priority.availableMaxPoints, 1)}
                      </span>
                    ) : null}
                  </span>
                ),
                scoreDelta1d: (
                  <span className="num">
                    <ScoreDelta value={r.scoreDelta1d} />
                  </span>
                ),
                grade: tech === null ? <span>미확인</span> : <GradeBadge grade={r.grade} />,
                volumeRatio: (
                  <span className="num">
                    {r.snapshot.volumeRatio20 === null
                      ? "데이터 없음"
                      : `${formatNumber(r.snapshot.volumeRatio20, 1)}%`}
                  </span>
                ),
                rs20: (
                  <span className="num">
                    <Delta value={r.rs20} digits={2} />
                  </span>
                ),
                rsAccel: (
                  <span className="num">
                    <RsAccel row={r} positionContext={positionContext} signalDate={signalDate} />
                  </span>
                ),
                distanceHigh: (
                  <span className="num">
                    <Delta value={r.snapshot.distanceFrom52wHigh} digits={1} />
                  </span>
                ),
                marketCap: (
                  <span className="num">
                    {r.marketCap === null ? (
                      <span className="text-muted-foreground">데이터 없음</span>
                    ) : (
                      formatWon(r.marketCap)
                    )}
                  </span>
                ),
                status: compactStock ? (
                  <CompactStockStatus
                    status={getCompactStockStatus(r, positionContext, signalDate, tradeDates)}
                  />
                ) : (
                  <div className="flex flex-col items-start gap-0.5">
                    <Badge
                      variant="outline"
                      className={
                        isPortfolioAwareOperationalEntry(r, positionContext, signalDate)
                          ? "border-primary/30 bg-primary/5 text-primary"
                          : displayStatus.includes("청산") || r.hardFilterStatus === "PENDING"
                            ? "border-warn/30 bg-warn-soft text-warn"
                            : "text-muted-foreground"
                      }
                    >
                      {displayStatus}
                    </Badge>
                    {r.instrument.instrumentType === "STOCK" && r.instrument.market === "KOSPI" ? (
                      <KospiEntryDetails
                        entry={r.kospiEntry}
                        compact
                        entryJudgmentPending={r.hardFilterStatus === "PENDING"}
                        entrySuppression={entrySuppressionReason(
                          positionContext,
                          r.instrument.symbol,
                          r.kospiEntry?.originDate ?? signalDate,
                        )}
                      />
                    ) : null}
                    <OnsetProfileDetails profile={r.onsetProfile} compact />
                    <UniverseFilterDetails row={r} compact />
                    {r.instrument.instrumentType === "STOCK" ? (
                      <StockAssessmentDetails
                        held={positionContext?.heldSymbols.includes(r.instrument.symbol) ?? false}
                        assessment={stockAssessmentDisplay(r, signalDate, tradeDates)}
                      />
                    ) : null}
                    {r.dataCompletenessRatio < 1 ? (
                      <span className="text-[10px] text-warn">기술점수 산정 불완전</span>
                    ) : null}
                  </div>
                ),
                warnings: (
                  <div className="flex max-w-[220px] flex-wrap gap-1">
                    {displayWarnings.slice(0, 3).map((warning) => (
                      <Badge
                        key={warning}
                        variant="outline"
                        className="border-warn/30 bg-warn-soft text-[10px] text-warn"
                      >
                        {warning}
                      </Badge>
                    ))}
                    {displayWarnings.length > 3 ? (
                      <span className="text-[10px] text-muted-foreground">
                        +{displayWarnings.length - 3}
                      </span>
                    ) : null}
                  </div>
                ),
              };
              return (
                <tr
                  key={r.instrument.symbol}
                  className={`border-t border-border hover:bg-accent/40 ${compactStock || r.hardFilterPassed || r.hardFilterStatus === "PENDING" ? "" : "opacity-60"}`}
                >
                  {visible.map((c) => (
                    <td
                      key={c.id}
                      className={`${compactStock ? "px-1" : "px-2"} py-1.5 ${compactStock && c.id === "name" ? "sticky left-0 z-10 bg-card" : ""} ${["rank", "name", "market", "sector", "grade", "status", "warnings"].includes(c.id) ? "text-left" : "text-right"}`}
                    >
                      {cells[c.id]}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
