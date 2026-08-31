import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { calculatePositionSizing } from "@/lib/engine/scoring";
import { analysisQueryOptions } from "@/lib/analysisQuery";
import { formatNumber, formatPrice, formatWon } from "@/lib/format";

export const Route = createFileRoute("/position-sizing")({
  head: () => ({
    meta: [
      { title: "포지션 사이징 계산기 | TrendScore KR" },
      {
        name: "description",
        content:
          "ATR 손절 기준 리스크 수량과 비중 제한 수량을 동시에 계산하고, 1R·2R·3R 가격과 전체 오픈 리스크 한도 초과를 점검합니다.",
      },
      { property: "og:title", content: "포지션 사이징 계산기 | TrendScore KR" },
      {
        property: "og:description",
        content: "ATR 배수 손절과 계좌 리스크 한도를 반영한 분할 진입 수량 계산기.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(analysisQueryOptions),
  component: PositionSizingPage,
});

function PositionSizingPage() {
  const { data } = useSuspenseQuery(analysisQueryOptions);
  const analysis = data.analysis;
  const first = analysis.rows[0]!;
  const [totalCapital, setTotalCapital] = useState(100_000_000);
  const [riskPercent, setRiskPercent] = useState(1);
  const [entryPrice, setEntryPrice] = useState(Math.round(first.snapshot.close));
  const [atr14, setAtr14] = useState(Math.round(first.snapshot.atr14 ?? 1000));
  const [atrMultiple, setAtrMultiple] = useState(1.8);
  const [maxWeightPercent, setMaxWeightPercent] = useState(25);
  const [currentOpenRiskPercent, setCurrentOpenRiskPercent] = useState(2);

  const result = calculatePositionSizing({
    totalCapital,
    riskPercent,
    entryPrice,
    atr14,
    atrMultiple,
    maxWeightPercent,
    currentOpenRiskPercent,
  });

  const gateAdjust = analysis.marketGate.status === "NEUTRAL" ? 0.5 : 1;

  const field = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
    hint?: string,
  ) => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 text-right"
      />
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );

  const out = (label: string, value: string, emphasis = false) => (
    <div className="flex items-baseline justify-between border-b border-border py-2 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={`num text-[13px] ${emphasis ? "font-bold" : "font-medium"}`}>{value}</span>
    </div>
  );

  return (
    <AppShell>
      <h1 className="text-xl font-bold tracking-tight">포지션 사이징 계산기</h1>
      <p className="mb-4 text-[12px] text-muted-foreground">
        기본값: 리스크 1% (최대 2%), 단일 종목 최대 25%, 전체 오픈 리스크 최대 6%, ATR 배수 1.8 ·
        시장 게이트 {analysis.marketGate.status === "NEUTRAL" ? "Neutral → 계획 리스크 50% 축소 권고" : analysis.marketGate.status}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">입력값</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("총 운용자산(원)", totalCapital, setTotalCapital, 1_000_000)}
            {field("1회 허용 리스크 비율(%)", riskPercent, setRiskPercent, 0.1, "권고 최대 2%")}
            {field("진입가(원)", entryPrice, setEntryPrice, 100)}
            {field("ATR14(원)", atr14, setAtr14, 10)}
            {field("ATR 배수 k", atrMultiple, setAtrMultiple, 0.1)}
            {field("단일 종목 최대 비중(%)", maxWeightPercent, setMaxWeightPercent, 1)}
            {field("현재 전체 오픈 리스크(%)", currentOpenRiskPercent, setCurrentOpenRiskPercent, 0.1)}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">계산 결과</h2>
          {result.errors.length > 0 ? (
            <div className="mb-3 rounded-md border border-destructive/30 bg-down-soft p-2 text-[12px] text-down">
              {result.errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          ) : null}
          {out("손절가 = 진입가 - k × ATR14", formatPrice(result.stopPrice))}
          {out("주당 리스크", formatPrice(result.riskPerShare))}
          {out("리스크 기준 수량", `${formatNumber(result.riskBasedQuantity, 0)}주`)}
          {out("자산비중 제한 수량", `${formatNumber(result.weightCappedQuantity, 0)}주`)}
          {out("최종 수량", `${formatNumber(result.finalQuantity, 0)}주`, true)}
          {out(
            "1차 / 2차 분할 (각 50%)",
            `${formatNumber(result.firstTrancheQuantity, 0)}주 / ${formatNumber(result.secondTrancheQuantity, 0)}주`,
          )}
          {out("예상 투자금액", formatWon(result.investment))}
          {out("자산 비중", `${formatNumber(result.weightPercent, 2)}%`)}
          {out("최대 예상손실", formatWon(result.maxLoss))}
          {out(
            "시장 게이트 반영 권장 리스크",
            `${formatNumber(riskPercent * gateAdjust, 2)}%`,
          )}
          {out("1R / 2R / 3R 가격", `${formatPrice(result.r1)} / ${formatPrice(result.r2)} / ${formatPrice(result.r3)}`)}
          {out("진입 후 전체 오픈 리스크", `${formatNumber(result.openRiskAfter, 2)}%`)}
          {result.openRiskExceeded ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-down-soft p-2 text-[12px] font-medium text-down">
              <TriangleAlert className="size-4" />
              전체 오픈 리스크 6% 한도를 초과합니다. 계산 결과는 계속 표시되지만 신규 진입 축소를
              점검하세요.
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
