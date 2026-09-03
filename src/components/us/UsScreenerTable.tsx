import { Link } from "@tanstack/react-router";
import { AlertTriangle, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { usSectorLabel, type UsGrade, type UsRow } from "@/lib/engine/usPipeline";

const GRADE_CLASS: Record<UsGrade, string> = {
  S: "bg-primary text-primary-foreground",
  A: "bg-up/20 text-up border border-up/40",
  B: "bg-warn/20 text-warn border border-warn/40",
  C: "bg-muted text-muted-foreground",
  D: "bg-down/15 text-down border border-down/40",
};

export function UsGradeBadge({ grade, size = "sm" }: { grade: UsGrade; size?: "sm" | "lg" }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold ${GRADE_CLASS[grade]} ${
        size === "lg" ? "size-16 text-2xl" : "size-6 text-[11px]"
      }`}
    >
      {grade}
    </span>
  );
}

export function CoverageBadge({ coverage, status }: { coverage: number; status: UsRow["dataStatus"] }) {
  const label = status === "COMPLETE" ? "COMPLETE" : status === "PARTIAL" ? "PARTIAL" : "UNAVAILABLE";
  return (
    <Badge
      variant="outline"
      className={`gap-1 text-[10px] ${status === "COMPLETE" ? "" : "border-warn/50 text-warn"}`}
    >
      {status !== "COMPLETE" ? <AlertTriangle className="size-3" /> : null}
      {label} {(coverage * 100).toFixed(0)}%
    </Badge>
  );
}

export function EligibilityBadge({ row }: { row: UsRow }) {
  const s = row.eligibility.status;
  const map: Record<typeof s, string> = {
    ELIGIBLE: "정상 평가",
    NEW_LISTING: "이력 부족(NEW_LISTING)",
    TACTICAL_ONLY: "레버리지·인버스(TACTICAL_ONLY)",
    EXCLUDED: "평가 제외",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${s === "ELIGIBLE" ? "" : "border-warn/50 text-warn"}`}
      title={row.eligibility.reasons.join(" · ")}
    >
      {map[s]}
    </Badge>
  );
}

function TrendIcon({ value }: { value: number | null }) {
  if (value === null) return <Minus className="inline size-3 text-muted-foreground" />;
  if (value > 0) return <TrendingUp className="inline size-3 text-up" />;
  if (value < 0) return <TrendingDown className="inline size-3 text-down" />;
  return <Minus className="inline size-3 text-muted-foreground" />;
}

function pct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "N/A";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

export function UsScreenerTable({ rows }: { rows: UsRow[] }) {
  if (rows.length === 0)
    return (
      <p className="rounded-lg border border-dashed border-border p-8 text-center text-[12px] text-muted-foreground">
        조건에 해당하는 종목이 없습니다.
      </p>
    );

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[1080px] text-[12px]">
        <thead className="bg-surface-strong text-left">
          <tr>
            <th className="px-2 py-2 font-semibold">티커</th>
            <th className="px-2 py-2 font-semibold">종목명</th>
            <th className="px-2 py-2 font-semibold">섹터</th>
            <th className="px-2 py-2 text-right font-semibold">Composite</th>
            <th className="px-2 py-2 text-center font-semibold">표시등급</th>
            <th className="px-2 py-2 text-center font-semibold">원등급</th>
            <th className="px-2 py-2 text-right font-semibold">Tech</th>
            <th className="px-2 py-2 text-right font-semibold">Priority</th>
            <th className="px-2 py-2 text-right font-semibold">Health</th>
            <th className="px-2 py-2 text-right font-semibold">6M vs SPY</th>
            <th className="px-2 py-2 text-right font-semibold">52W 고가대비</th>
            <th className="px-2 py-2 font-semibold">데이터</th>
            <th className="px-2 py-2 font-semibold">자격</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.instrument.symbol} className="border-t border-border hover:bg-accent/40">
              <td className="px-2 py-1.5 font-mono font-semibold">
                <Link
                  to="/us/instrument/$symbol"
                  params={{ symbol: r.instrument.symbol }}
                  className="text-primary hover:underline"
                >
                  {r.instrument.symbol}
                </Link>
              </td>
              <td className="max-w-[220px] truncate px-2 py-1.5" title={r.instrument.name}>
                {r.instrument.nameKo ? `${r.instrument.nameKo} (${r.instrument.name})` : r.instrument.name}
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">
                {usSectorLabel(r.instrument.sector)}
              </td>
              <td className="num px-2 py-1.5 text-right font-semibold">
                {r.rawComposite.toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-center">
                <UsGradeBadge grade={r.displayGrade} />
              </td>
              <td className="num px-2 py-1.5 text-center text-muted-foreground">{r.rawGrade}</td>
              <td className="num px-2 py-1.5 text-right">
                {r.technical.points}/{r.technical.availableMaxPoints || "-"}
              </td>
              <td className="num px-2 py-1.5 text-right">
                {r.priority.points}/{r.priority.availableMaxPoints || "-"}
              </td>
              <td className="num px-2 py-1.5 text-right">
                {r.etfHealth && r.etfHealth.availableMaxPoints > 0
                  ? `${((r.etfHealth.points / r.etfHealth.availableMaxPoints) * 100).toFixed(0)}`
                  : "N/A"}
              </td>
              <td className="num px-2 py-1.5 text-right">
                <TrendIcon value={r.snapshot.return126} /> {pct(r.snapshot.return126)}
              </td>
              <td className="num px-2 py-1.5 text-right">
                {r.snapshot.distanceFrom252High === null
                  ? "N/A"
                  : `${r.snapshot.distanceFrom252High.toFixed(1)}%`}
              </td>
              <td className="px-2 py-1.5">
                <CoverageBadge coverage={r.coverage} status={r.dataStatus} />
              </td>
              <td className="px-2 py-1.5">
                <EligibilityBadge row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function toCsv(rows: UsRow[]): string {
  const header = [
    "symbol",
    "name",
    "assetType",
    "sector",
    "rawComposite",
    "rawGrade",
    "displayGrade",
    "technicalPoints",
    "priorityPoints",
    "etfHealthPercent",
    "coverage",
    "dataStatus",
    "eligibility",
  ];
  const lines = rows.map((r) =>
    [
      r.instrument.symbol,
      `"${r.instrument.name.replace(/"/g, '""')}"`,
      r.instrument.assetType,
      r.instrument.sector ?? "",
      r.rawComposite.toFixed(2),
      r.rawGrade,
      r.displayGrade,
      r.technical.points,
      r.priority.points,
      r.etfHealth && r.etfHealth.availableMaxPoints > 0
        ? ((r.etfHealth.points / r.etfHealth.availableMaxPoints) * 100).toFixed(1)
        : "",
      (r.coverage * 100).toFixed(1),
      r.dataStatus,
      r.eligibility.status,
    ].join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
