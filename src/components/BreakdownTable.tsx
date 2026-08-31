import { Check, Minus, X } from "lucide-react";

import type { ScoreBlock } from "@/lib/engine/scoring";

export function BreakdownTable({
  block,
  title,
  asOfDate,
  source,
}: {
  block: ScoreBlock;
  title: string;
  asOfDate: string;
  source: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border bg-surface-strong px-3 py-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="num text-xs text-muted-foreground">
          획득 {block.points} / 산정 가능 {block.availableMaxPoints} (만점 {block.maxPoints})
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[12px]">
          <thead className="bg-surface text-[11px] text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left">그룹</th>
              <th className="px-2 py-1.5 text-left">조건</th>
              <th className="px-2 py-1.5 text-left">실제값</th>
              <th className="px-2 py-1.5 text-left">기준값</th>
              <th className="px-2 py-1.5 text-center">충족</th>
              <th className="px-2 py-1.5 text-right">획득점수</th>
              <th className="px-2 py-1.5 text-right">산정 가능</th>
              <th className="px-2 py-1.5 text-left">기준일 / 출처</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={`${r.group}-${i}`} className="border-t border-border">
                <td className="px-2 py-1.5 font-medium">{r.group}</td>
                <td className="px-2 py-1.5">{r.rule}</td>
                <td className="px-2 py-1.5">{r.actual}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{r.threshold}</td>
                <td className="px-2 py-1.5 text-center">
                  {r.status === "PASS" ? (
                    <span className="inline-flex items-center gap-1 text-up">
                      <Check className="size-3" />
                      충족
                    </span>
                  ) : r.status === "FAIL" ? (
                    <span className="inline-flex items-center gap-1 text-down">
                      <X className="size-3" />
                      미충족
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Minus className="size-3" />
                      데이터 없음
                    </span>
                  )}
                </td>
                <td className="num px-2 py-1.5">
                  {r.points > 0 ? `+${r.points}` : r.status === "NO_DATA" ? "-" : "0"}
                </td>
                <td className="num px-2 py-1.5 text-muted-foreground">
                  {r.status === "NO_DATA" ? "산정 불가" : r.maxPoints}
                </td>
                <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                  {asOfDate} / {source}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
