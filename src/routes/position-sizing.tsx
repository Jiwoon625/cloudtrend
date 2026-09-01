import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlert, Calculator, TrendingUp, Shield, Info } from "lucide-react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { calculatePositionSizing } from "@/lib/engine/scoring";
import { analysisQueryOptions } from "@/lib/analysisQuery";
import { formatNumber, formatPrice, formatWon } from "@/lib/format";

export const Route = createFileRoute("/position-sizing")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
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
  errorComponent: ({ error, reset }) => <DataError error={error} reset={reset} />,
  component: PositionSizingPage,
});

function FormulaBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-[12px] text-muted-foreground">
      {children}
    </div>
  );
}

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
  const gateLabel = analysis.marketGate.status === "NEUTRAL"
    ? "Neutral → 계획 리스크 50% 축소 권고"
    : analysis.marketGate.status;

  const field = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
    hint?: string,
  ) => (
    <div className="space-y-1.5">
      <Label className="text-[12px] font-medium text-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 text-right"
      />
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );

  return (
    <AppShell>
      <div className="mb-6 space-y-2">
        <div className="flex items-center gap-2">
          <Calculator className="size-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">포지션 사이징 계산기</h1>
        </div>
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          이 도구는 <strong className="text-foreground">"한 번의 거래에서 얼마나 많은 주식을 사야 리스크가 통제되는가"</strong>를
          계산합니다. 진입가와 ATR 기반 손절가를 정하면, 총 자산 대비 허용 리스크와 단일 종목 최대 비중
          두 기준 중 <strong className="text-foreground">더 작은 쪽</strong>을 자동으로 선택합니다.
        </p>
      </div>

      <Card className="mb-6 border-l-4 border-l-primary">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Info className="size-4 text-primary" />
            계산 흐름 한눈에 보기
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <Badge variant="secondary">1. 손절가 결정</Badge>
            <span className="hidden sm:inline">→</span>
            <Badge variant="secondary">2. 허용 리스크 금액 산출</Badge>
            <span className="hidden sm:inline">→</span>
            <Badge variant="secondary">3. 리스크 기준 수량 계산</Badge>
            <span className="hidden sm:inline">→</span>
            <Badge variant="secondary">4. 자산 비중 한도와 비교</Badge>
            <span className="hidden sm:inline">→</span>
            <Badge variant="default">5. 최종 수량 확정</Badge>
          </div>
          <FormulaBox>손절가 = 진입가 − k × ATR14</FormulaBox>
          <FormulaBox>주당 리스크 = 진입가 − 손절가</FormulaBox>
          <FormulaBox>리스크 기준 수량 = 총자산 × 리스크% ÷ 주당 리스크</FormulaBox>
          <FormulaBox>비중 제한 수량 = 총자산 × 최대비중% ÷ 진입가</FormulaBox>
          <FormulaBox>최종 수량 = MIN(리스크 기준 수량, 비중 제한 수량)</FormulaBox>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">입력값</CardTitle>
            <CardDescription className="text-[12px]">
              직접 입력하거나, 스크리너 첫 번째 종목의 값을 기본값으로 사용할 수 있습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {field(
              "총 운용자산(원)",
              totalCapital,
              setTotalCapital,
              1_000_000,
              "예: 1억 원. 전체 계좌 자산을 기준으로 합니다.",
            )}
            {field(
              "1회 허용 리스크 비율(%)",
              riskPercent,
              setRiskPercent,
              0.1,
              "한 종목에서 최대 허용하는 손실 비중. 권고 최대 2%",
            )}
            {field("진입가(원)", entryPrice, setEntryPrice, 100, "매수 예정가 또는 현재가")}
            {field(
              "ATR14(원)",
              atr14,
              setAtr14,
              10,
              "최근 14일 평균 진폭. 변동성이 클수록 손절 폭이 넓어집니다.",
            )}
            {field(
              "ATR 배수 k",
              atrMultiple,
              setAtrMultiple,
              0.1,
              "일반적으로 1.5 ~ 2.5. 추세 추종 전략에서는 1.8을 많이 사용합니다.",
            )}
            {field(
              "단일 종목 최대 비중(%)",
              maxWeightPercent,
              setMaxWeightPercent,
              1,
              "한 종목에 투입할 최대 자산 비중. 권고 20~25%",
            )}
            {field(
              "현재 전체 오픈 리스크(%)",
              currentOpenRiskPercent,
              setCurrentOpenRiskPercent,
              0.1,
              "이미 보유 중인 포지션의 미실현 리스크 합계. 6% 초과 시 경고",
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">계산 결과</CardTitle>
            <CardDescription className="text-[12px]">
              시장 게이트 상태: <span className="font-medium text-foreground">{gateLabel}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.errors.length > 0 ? (
              <div className="rounded-md border border-destructive/30 bg-down-soft p-3 text-[12px] text-down">
                {result.errors.map((e) => (
                  <p key={e}>• {e}</p>
                ))}
              </div>
            ) : null}

            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                핵심 판단
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="text-[12px] text-muted-foreground">리스크 기준 수량</span>
                  <p className="num text-lg font-bold">{formatNumber(result.riskBasedQuantity, 0)}주</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[12px] text-muted-foreground">비중 제한 수량</span>
                  <p className="num text-lg font-bold">{formatNumber(result.weightCappedQuantity, 0)}주</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
                <TrendingUp className="size-4" />
                {result.riskBasedQuantity < result.weightCappedQuantity
                  ? "리스크 기준이 더 작아서 최종 수량을 제한합니다."
                  : "비중 한도가 더 작아서 최종 수량을 제한합니다."}
              </div>
            </div>

            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] font-semibold">최종 매수 수량</span>
                <span className="num text-2xl font-bold text-primary">
                  {formatNumber(result.finalQuantity, 0)}주
                </span>
              </div>
              <div className="mt-2 grid gap-2 text-[12px] text-muted-foreground sm:grid-cols-2">
                <span>1차 진입: {formatNumber(result.firstTrancheQuantity, 0)}주</span>
                <span>2차 진입: {formatNumber(result.secondTrancheQuantity, 0)}주</span>
              </div>
            </div>

            <div className="space-y-2">
              <ResultRow label="손절가" value={formatPrice(result.stopPrice)} />
              <ResultRow label="주당 리스크" value={formatPrice(result.riskPerShare)} />
              <ResultRow label="예상 투자금액" value={formatWon(result.investment)} />
              <ResultRow label="자산 비중" value={`${formatNumber(result.weightPercent, 2)}%`} />
              <ResultRow label="최대 예상손실" value={formatWon(result.maxLoss)} />
              <ResultRow
                label="시장 게이트 반영 권장 리스크"
                value={`${formatNumber(riskPercent * gateAdjust, 2)}%`}
              />
            </div>

            <div className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-foreground">
                <TrendingUp className="size-4 text-primary" />
                수익 목표 (R 배수)
              </div>
              <p className="mb-3 text-[11px] text-muted-foreground">
                1R = 주당 리스크만큼 이익이 난 가격. 2R, 3R은 각각 2배, 3배 이익 지점입니다.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <RBox label="1R" value={result.r1} />
                <RBox label="2R" value={result.r2} />
                <RBox label="3R" value={result.r3} />
              </div>
            </div>

            <ResultRow
              label="진입 후 전체 오픈 리스크"
              value={`${formatNumber(result.openRiskAfter, 2)}%`}
              warning={result.openRiskExceeded}
            />
            {result.openRiskExceeded ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-down-soft p-3 text-[12px] font-medium text-down">
                <TriangleAlert className="size-4" />
                전체 오픈 리스크 6% 한도를 초과합니다. 신규 진입을 축소하거나 보유 포지션을 먼저 정리하세요.
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-[12px] font-medium text-emerald-400">
                <Shield className="size-4" />
                전체 오픈 리스크 6% 한도 내입니다.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">용어 설명</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-[12px] leading-relaxed text-muted-foreground sm:grid-cols-2">
          <div>
            <strong className="text-foreground">ATR(Average True Range)</strong>
            <p>최근 N일 동안의 평균 가격 변동폭. 변동성이 큰 종목일수록 손절 폭을 넓게 잡습니다.</p>
          </div>
          <div>
            <strong className="text-foreground">리스크 기준 수량</strong>
            <p>"이 거래에서 잃어도 좋은 돈"을 주당 리스크로 나눈 값. 리스크를 먼저 정하고 수량을 도출합니다.</p>
          </div>
          <div>
            <strong className="text-foreground">비중 제한 수량</strong>
            <p>단일 종목에 투입할 최대 자산 비중을 진입가로 환산한 수량. 분산 투자 기준을 반영합니다.</p>
          </div>
          <div>
            <strong className="text-foreground">오픈 리스크</strong>
            <p>현재 보유 포지션의 손절가 기준 잠재 손실 비중. 6% 이상이면 신규 진입에 제약이 생깁니다.</p>
          </div>
          <div>
            <strong className="text-foreground">R(Reward)</strong>
            <p>주당 리스크를 1단위로 볼 때의 예상 수익 지점. 2R은 손절 폭의 2배만큼 이익이 난 가격입니다.</p>
          </div>
          <div>
            <strong className="text-foreground">시장 게이트</strong>
            <p>코스피 추세·VKOSPI·외국인 수급을 종합해 RISK_ON/NEUTRAL/RISK_OFF로 판단합니다. NEUTRAL일 때는
              리스크를 절반으로 줄이는 것을 권고합니다.</p>
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}

function ResultRow({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border py-2 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={`num text-[13px] font-medium ${warning ? "text-down font-bold" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function RBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-card p-2 text-center">
      <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className="num text-[13px] font-bold">{formatPrice(value)}</div>
    </div>
  );
}
