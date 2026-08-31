import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppShell } from "@/components/AppShell";
import { Delta } from "@/components/ScreenerTable";
import { runAnalysis } from "@/lib/engine/pipeline";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/sectors")({
  head: () => ({
    meta: [
      { title: "섹터 상대강도 | TrendScore KR" },
      {
        name: "description",
        content:
          "KRX 산업지수 기반 20일·60일 시장 대비 초과수익률, 추세 상태, 섹터 Breadth와 등급별 종목 수를 순위표로 제공합니다.",
      },
      { property: "og:title", content: "섹터 상대강도 | TrendScore KR" },
      {
        property: "og:description",
        content: "RS20/RS60 백분위와 Breadth로 산출한 섹터 점수 순위.",
      },
    ],
  }),
  component: SectorsPage,
});

function TrendCell({ value, label }: { value: boolean | null; label: string }) {
  if (value === null) return <span className="text-muted-foreground">데이터 없음</span>;
  return (
    <span className={value ? "text-up" : "text-down"}>
      {value ? "○" : "×"} {label}
    </span>
  );
}

function SectorsPage() {
  const analysis = useMemo(() => runAnalysis(), []);
  return (
    <AppShell>
      <h1 className="text-xl font-bold tracking-tight">섹터 상대강도</h1>
      <p className="mb-4 text-[12px] text-muted-foreground">
        기준일 {analysis.asOfDate} · 벤치마크 KOSPI · 점수 = RS20 백분위 35 + RS60 백분위 25 + 추세
        20 + Breadth 20
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1000px] text-[12px]">
          <thead className="bg-surface-strong text-[11px]">
            <tr>
              <th className="px-2 py-2 text-left">RS 순위</th>
              <th className="px-2 py-2 text-left">섹터</th>
              <th className="px-2 py-2 text-right">섹터 점수</th>
              <th className="px-2 py-2 text-right">RS20</th>
              <th className="px-2 py-2 text-right">RS60</th>
              <th className="px-2 py-2 text-left">추세 상태</th>
              <th className="px-2 py-2 text-right">정배열 비율</th>
              <th className="px-2 py-2 text-right">신고가 근접</th>
              <th className="px-2 py-2 text-right">상승 종목</th>
              <th className="px-2 py-2 text-right">A / B등급</th>
              <th className="px-2 py-2 text-left">대표 ETF</th>
              <th className="px-2 py-2 text-right">전주 대비</th>
            </tr>
          </thead>
          <tbody>
            {analysis.sectors.map((s) => (
              <tr key={s.sectorCode} className="border-t border-border">
                <td className="num px-2 py-1.5">{s.rank}</td>
                <td className="px-2 py-1.5 font-medium">
                  {s.sectorName}
                  {s.isSynthetic ? (
                    <span className="ml-1 rounded bg-warn-soft px-1 text-[10px] text-warn">
                      합성 섹터지수
                    </span>
                  ) : null}
                </td>
                <td className="num px-2 py-1.5 font-semibold">{formatNumber(s.score, 1)}</td>
                <td className="num px-2 py-1.5">
                  <Delta value={s.rs20} digits={2} />
                </td>
                <td className="num px-2 py-1.5">
                  <Delta value={s.rs60} digits={2} />
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-col text-[11px]">
                    <TrendCell value={s.aboveMa20} label="MA20 위" />
                    <TrendCell value={s.aboveMa60} label="MA60 위" />
                    <TrendCell value={s.aboveCloud} label="구름 위" />
                  </div>
                </td>
                <td className="num px-2 py-1.5">{formatNumber(s.breadthMaAligned, 0)}%</td>
                <td className="num px-2 py-1.5">{formatNumber(s.breadthNearHigh, 0)}%</td>
                <td className="num px-2 py-1.5">{formatNumber(s.breadthAdvancing, 0)}%</td>
                <td className="num px-2 py-1.5">
                  {s.gradeACount} / {s.gradeBCount}
                </td>
                <td className="px-2 py-1.5">{s.representativeEtf ?? "-"}</td>
                <td className="num px-2 py-1.5">
                  {s.prevRank > s.rank ? (
                    <span className="text-up">▲{s.prevRank - s.rank}</span>
                  ) : s.prevRank < s.rank ? (
                    <span className="text-down">▼{s.rank - s.prevRank}</span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
