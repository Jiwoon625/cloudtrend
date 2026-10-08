import type { ReactNode } from "react";
import { Delta, GradeBadge } from "@/components/ScreenerTable";
import { OnsetProfileDetails } from "@/components/OnsetProfileDetails";
import { StockAssessmentDetails } from "@/components/StockAssessmentDetails";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import { formatNumber, formatPrice, formatWon } from "@/lib/format";
import { getKospiRsAccel } from "@/lib/kospiRelativeQuality";
import type { DomesticPositionContext } from "@/lib/positionSignalContext";
import { stockAssessmentDisplay } from "@/lib/stockAssessmentDisplay";
import { getCompactStockStatus } from "@/lib/stockCompactStatus";

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface p-2">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="num text-[13px] font-semibold">{children}</dd>
    </div>
  );
}

/** Display the existing screening evidence, with no scoring or eligibility run. */
export function StockInstrumentSummary({
  row,
  asOfDate,
  tradeDates,
  positionContext,
}: {
  row: ScreeningRow;
  asOfDate: string;
  tradeDates?: readonly string[] | undefined;
  positionContext?: DomesticPositionContext | null | undefined;
}) {
  if (row.instrument.instrumentType !== "STOCK") return null;
  const assessment = stockAssessmentDisplay(row, asOfDate, tradeDates);
  const status = getCompactStockStatus(row, positionContext, asOfDate, tradeDates);
  const rsAccel = assessment.current ? getKospiRsAccel(row) : null;
  const statusColor = {
    normal: "text-foreground",
    warn: "text-warn",
    danger: "text-down",
    positive: "text-up",
  }[status.tone];

  return (
    <section
      className="rounded-lg border border-border bg-card p-3"
      aria-label="주식 핵심 지표 및 조건별 판단"
    >
      <h2 className="mb-2 text-sm font-semibold">판단 요약</h2>
      <div aria-label="주식 상태">
        <p className={`text-sm font-semibold ${statusColor}`}>{status.primary}</p>
        {status.secondary ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{status.secondary}</p>
        ) : null}
      </div>
      <div className="mt-3">
        <h3 className="mb-1 text-xs font-semibold">계산된 조건과 최종 진입 판단</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">
          기준일 {asOfDate}의 저장된 계산 결과입니다. 기술 조건·확인된 미충족·자료 대기를 각각
          표시하며, 실제 보유·보유기간·체결 여부는 원장에서 별도 확인합니다.
        </p>
        <StockAssessmentDetails assessment={assessment} />
      </div>
      {row.onsetProfile ? (
        <div className="mt-3 border-t border-border pt-3">
          <h3 className="mb-1 text-xs font-semibold">Onset 발생 경로</h3>
          <OnsetProfileDetails profile={row.onsetProfile} />
          <p className="mt-2 text-[11px] text-muted-foreground">
            유형·신규 획득 점수·MA20 이격은 신호 설명 정보이며 진입 점수나 매매규칙을 변경하지
            않습니다.
          </p>
        </div>
      ) : null}
      <h3 className="mb-2 mt-3 border-t border-border pt-3 text-xs font-semibold">상세 지표</h3>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="시장">{row.instrument.market}</Metric>
        <Metric label="종가">
          {assessment.current ? formatPrice(row.snapshot.close) : "기준일 가격 미확인"}
        </Metric>
        <Metric label="기술점수">
          {assessment.score === null ? "산정 불가" : `${formatNumber(assessment.score, 1)} / 10`}
        </Metric>
        <Metric label="우선점수 · 참고">
          {assessment.current
            ? `${formatNumber(row.priority.points, 2)} / ${formatNumber(row.priority.maxPoints, 1)}`
            : "미확인"}
        </Metric>
        <Metric label="모델등급 · 기술 기준">
          {assessment.grade === null ? "산정 불가" : <GradeBadge grade={assessment.grade} />}
        </Metric>
        <Metric label="거래량 비율(20일)">
          {assessment.volumeRatio20 === null
            ? "데이터 없음"
            : `${formatNumber(assessment.volumeRatio20, 1)}%`}
        </Metric>
        <Metric label="RS20">
          <Delta value={assessment.current ? row.rs20 : null} digits={2} />
        </Metric>
        <Metric label="RSAccel">
          {row.instrument.market !== "KOSPI"
            ? "해당 없음"
            : rsAccel === null
              ? "데이터 없음"
              : `${rsAccel > 0 ? "+" : ""}${formatNumber(rsAccel, 2)}%p`}
        </Metric>
        <Metric label="52주 고점 거리">
          <Delta value={assessment.current ? row.snapshot.distanceFrom52wHigh : null} />
        </Metric>
        <Metric label="시가총액">{formatWon(assessment.current ? row.marketCap : null)}</Metric>
      </dl>
    </section>
  );
}
