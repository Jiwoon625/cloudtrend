import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppShell } from "@/components/AppShell";
import { getBars, INSTRUMENTS, INDEX_SERIES, TRADE_DATES } from "@/lib/engine/mockProvider";
import { runAnalysis } from "@/lib/engine/pipeline";
import { formatCount } from "@/lib/format";

export const Route = createFileRoute("/data-status")({
  head: () => ({
    meta: [
      { title: "데이터 상태 및 검증 | TrendScore KR" },
      {
        name: "description",
        content:
          "공급자별 기준일, 레코드 수, OHLC 논리 오류·중복·미래 날짜 등 자동 검증 결과를 확인하는 데이터 품질 관리 화면입니다.",
      },
      { property: "og:title", content: "데이터 상태 및 검증 | TrendScore KR" },
      {
        property: "og:description",
        content: "OHLC 논리 검증, 중복·누락 점검, 최소 계산 기간 충족 여부를 표시합니다.",
      },
    ],
  }),
  component: DataStatusPage,
});

function validate() {
  let ohlcErrors = 0;
  let negativeVolume = 0;
  let duplicates = 0;
  let futureDates = 0;
  let insufficient = 0;
  let abnormalMoves = 0;
  const today = TRADE_DATES[TRADE_DATES.length - 1]!;

  for (const inst of INSTRUMENTS) {
    const bars = getBars(inst.symbol);
    if (bars.length < 120) insufficient++;
    const seen = new Set<string>();
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      if (b.high < b.low || b.high < b.open || b.high < b.close || b.low > b.open || b.low > b.close)
        ohlcErrors++;
      if (b.volume < 0) negativeVolume++;
      if (seen.has(b.tradeDate)) duplicates++;
      seen.add(b.tradeDate);
      if (b.tradeDate > today) futureDates++;
      if (i > 0) {
        const chg = b.close / bars[i - 1]!.close - 1;
        if (Math.abs(chg) > 0.29) abnormalMoves++;
      }
    }
  }
  return { ohlcErrors, negativeVolume, duplicates, futureDates, insufficient, abnormalMoves };
}

function DataStatusPage() {
  const analysis = useMemo(() => runAnalysis(), []);
  const checks = useMemo(() => validate(), []);
  const recordCount = INSTRUMENTS.length * TRADE_DATES.length;

  const rows = [
    { provider: analysis.dataProvider, kind: "일봉 가격", count: recordCount, entities: INSTRUMENTS.length },
    { provider: analysis.dataProvider, kind: "지수 일봉", count: INDEX_SERIES.length * TRADE_DATES.length, entities: INDEX_SERIES.length },
    { provider: analysis.dataProvider, kind: "재무 스냅샷", count: INSTRUMENTS.filter((i) => i.instrumentType === "STOCK").length, entities: 20 },
    { provider: analysis.dataProvider, kind: "ETF 메타데이터", count: INSTRUMENTS.filter((i) => i.instrumentType === "ETF").length, entities: 10 },
  ];

  const validations = [
    { label: "OHLC 논리 오류", value: checks.ohlcErrors },
    { label: "음수 거래량", value: checks.negativeVolume },
    { label: "동일 종목·일자 중복", value: checks.duplicates },
    { label: "미래 날짜 데이터", value: checks.futureDates },
    { label: "지표 최소 기간 미충족", value: checks.insufficient },
    { label: "비정상 급등락 (검토 플래그)", value: checks.abnormalMoves },
  ];

  return (
    <AppShell>
      <h1 className="text-xl font-bold tracking-tight">데이터 상태 및 계산 로그</h1>
      <p className="mb-4 text-[12px] text-muted-foreground">
        기준일 {analysis.asOfDate} · 데이터 버전 {analysis.dataVersion} · 전략 v
        {analysis.strategyVersion}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
            공급자별 수집 현황
          </h2>
          <table className="w-full text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">공급자</th>
                <th className="px-2 py-1.5 text-left">데이터 종류</th>
                <th className="px-2 py-1.5 text-right">레코드 수</th>
                <th className="px-2 py-1.5 text-right">대상 수</th>
                <th className="px-2 py-1.5 text-left">상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.kind} className="border-t border-border">
                  <td className="px-2 py-1.5">{r.provider}</td>
                  <td className="px-2 py-1.5">{r.kind}</td>
                  <td className="num px-2 py-1.5">{formatCount(r.count)}</td>
                  <td className="num px-2 py-1.5">{formatCount(r.entities)}</td>
                  <td className="px-2 py-1.5 text-up">정상</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
            자동 검증 결과
          </h2>
          <table className="w-full text-[12px]">
            <tbody>
              {validations.map((v) => (
                <tr key={v.label} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">{v.label}</td>
                  <td
                    className={`num px-3 py-2 font-semibold ${v.value === 0 ? "text-up" : "text-warn"}`}
                  >
                    {formatCount(v.value)}건
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            비정상 급등락은 자동 삭제하지 않고 corporate action 또는 데이터 오류 검토 대상으로만
            플래그합니다.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
