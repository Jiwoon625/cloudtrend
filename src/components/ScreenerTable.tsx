import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Download, Minus } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber, formatPercent, formatPrice, formatWon } from "@/lib/format";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import { WARNING_LABELS } from "@/lib/engine/scoring";

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
  if (value === null)
    return <span className="text-muted-foreground">데이터 없음</span>;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const cls = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 ${cls}`}>
      <Icon className="size-3" aria-hidden />
      {formatPercent(value, digits)}
    </span>
  );
}

type SortKey =
  | "total"
  | "technical"
  | "priority"
  | "volumeRatio"
  | "rs20"
  | "distanceHigh"
  | "marketCap"
  | "close";

const COLUMNS: Array<{ key: SortKey | "static"; label: string; id: string }> = [
  { key: "static", label: "순위", id: "rank" },
  { key: "static", label: "종목명", id: "name" },
  { key: "static", label: "시장", id: "market" },
  { key: "static", label: "섹터", id: "sector" },
  { key: "close", label: "종가", id: "close" },
  { key: "total", label: "정규화 점수", id: "total" },
  { key: "static", label: "모델등급", id: "grade" },
  { key: "technical", label: "모델 원점수", id: "technical" },
  { key: "priority", label: "우선점수", id: "priority" },
  { key: "volumeRatio", label: "거래량 비율", id: "volumeRatio" },
  { key: "rs20", label: "RS20", id: "rs20" },
  { key: "distanceHigh", label: "52주 고점 거리", id: "distanceHigh" },
  { key: "marketCap", label: "시가총액", id: "marketCap" },
  { key: "static", label: "상태", id: "status" },
  { key: "static", label: "경고", id: "warnings" },
];

function sortValue(row: ScreeningRow, key: SortKey): number {
  switch (key) {
    case "total":
      return row.totalScoreNormalized;
    case "technical":
      return (row.vf ?? row.technical).points;
    case "priority":
      return row.priority.points;
    case "volumeRatio":
      return row.snapshot.volumeRatio20 ?? -1;
    case "rs20":
      return row.rs20 ?? -999;
    case "distanceHigh":
      return row.snapshot.distanceFrom52wHigh ?? -999;
    case "marketCap":
      return row.marketCap ?? -1;
    case "close":
      return row.snapshot.close;
  }
}

export function ScreenerTable({ rows }: { rows: ScreeningRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [hidden, setHidden] = useState<string[]>([]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const diff = sortValue(a, sortKey) - sortValue(b, sortKey);
      return dir === "desc" ? -diff : diff;
    });
    return copy;
  }, [rows, sortKey, dir]);

  const visible = COLUMNS.filter((c) => !hidden.includes(c.id));

  const downloadCsv = () => {
    const header = visible.map((c) => c.label).join(",");
    const lines = sorted.map((r, i) =>
      [
        i + 1,
        r.instrument.name,
        r.instrument.market,
        r.instrument.sectorName,
        r.snapshot.close,
        r.totalScoreNormalized.toFixed(1),
        r.grade,
        `${(r.vf ?? r.technical).points}/${(r.vf ?? r.technical).maxPoints} (산정 가능 ${(r.vf ?? r.technical).availableMaxPoints})`,
        `${r.priority.points}/${r.priority.availableMaxPoints}`,
        r.snapshot.volumeRatio20?.toFixed(1) ?? "",
        r.rs20?.toFixed(2) ?? "",
        r.snapshot.distanceFrom52wHigh?.toFixed(2) ?? "",
        r.marketCap ?? "",
        r.actionLabelText,
        r.warnings.join("|"),
      ]
        .filter((_, idx) => !hidden.includes(COLUMNS[idx]!.id))
        .join(","),
    );
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
          className={`sticky top-0 z-10 whitespace-nowrap bg-surface-strong px-2 py-2 text-[11px] font-semibold ${numeric ? "text-right" : "text-left"}`}
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
          {COLUMNS.filter((c) => !["rank", "name"].includes(c.id)).map((c) => (
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
        <span className="ml-auto text-xs text-muted-foreground">{sorted.length}건</span>
      </div>

      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1100px] text-[12px]">
          <thead>
            <tr>{visible.map((c) => th(c))}</tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const cells: Record<string, React.ReactNode> = {
                rank: <span className="num">{i + 1}</span>,
                name: (
                  <Link
                    to="/instrument/$symbol"
                    params={{ symbol: r.instrument.symbol }}
                    className="font-medium text-primary hover:underline"
                  >
                    {r.instrument.name}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {r.instrument.symbol}
                    </span>
                  </Link>
                ),
                market: <span>{r.instrument.market}</span>,
                sector: <span>{r.instrument.sectorName}</span>,
                close: <span className="num">{formatPrice(r.snapshot.close)}</span>,
                total: (
                  <span className="num font-semibold">
                    {formatNumber(r.totalScoreNormalized, 1)}
                  </span>
                ),
                grade: <GradeBadge grade={r.grade} />,
                technical: (
                  <span className="num">
                    {(r.vf ?? r.technical).points}/{(r.vf ?? r.technical).maxPoints}
                    <span className="block text-[10px] text-muted-foreground">
                      산정 가능 {(r.vf ?? r.technical).availableMaxPoints}
                    </span>
                  </span>
                ),
                priority: (
                  <span className="num">
                    {r.priority.points}/{r.priority.availableMaxPoints}
                  </span>
                ),
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
                status: (
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="text-[11px] font-medium">{r.actionLabelText}</span>
                    {!r.hardFilterPassed ? (
                      <span className="text-[10px] text-down">실격: {r.failedRules[0]}</span>
                    ) : null}
                    {r.dataCompletenessRatio < 0.7 ? (
                      <span className="text-[10px] text-warn">낮은 데이터 신뢰도</span>
                    ) : null}
                  </div>
                ),
                warnings: (
                  <div className="flex max-w-[220px] flex-wrap gap-1">
                    {r.warnings.slice(0, 3).map((w) => (
                      <Badge
                        key={w}
                        variant="outline"
                        className="border-warn/30 bg-warn-soft text-[10px] text-warn"
                      >
                        {WARNING_LABELS[w] ?? w}
                      </Badge>
                    ))}
                    {r.warnings.length > 3 ? (
                      <span className="text-[10px] text-muted-foreground">
                        +{r.warnings.length - 3}
                      </span>
                    ) : null}
                  </div>
                ),
              };
              return (
                <tr
                  key={r.instrument.symbol}
                  className={`border-t border-border hover:bg-accent/40 ${r.hardFilterPassed ? "" : "opacity-60"}`}
                >
                  {visible.map((c) => (
                    <td
                      key={c.id}
                      className={`px-2 py-1.5 ${["rank", "name", "market", "sector", "grade", "status", "warnings"].includes(c.id) ? "text-left" : "text-right"}`}
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
