import { useId } from "react";

import {
  US_TAX_DISCLAIMER,
  US_TAX_SOURCES,
  type UsTaxOverlayResult,
} from "@/lib/engine/usCapitalGainsTax";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const krwFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const usd = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "미확인" : usdFormatter.format(value);
const krw = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "미확인" : `${krwFormatter.format(value)}원`;
const STATUS: Record<UsTaxOverlayResult["status"], string> = {
  ESTIMATE: "추정치",
  PARTIAL: "일부 자료 · 추정치",
  UNAVAILABLE: "산출 불가 · 자료 미확인",
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] leading-relaxed text-muted-foreground">{label}</dt>
      <dd className="num mt-1 break-words text-sm font-semibold">{value}</dd>
    </div>
  );
}

export function UsTaxEstimatePanel({
  estimate,
  title,
}: {
  estimate: UsTaxOverlayResult;
  title: string;
}) {
  const titleId = useId();
  const missing = [...new Set(estimate.missingFields)];
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-card p-4"
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="text-sm font-semibold">
            {title}
          </h3>
          <p className="mt-1 break-words text-[11px] text-muted-foreground">
            {estimate.taxYear}년 · {estimate.scopeLabel} · 기준일 {estimate.asOf}
          </p>
        </div>
        <span
          role="status"
          className={`rounded-md border px-2 py-1 text-[10px] font-medium ${
            estimate.status === "ESTIMATE" ? "text-muted-foreground" : "text-warn"
          }`}
        >
          {STATUS[estimate.status]}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Metric label="세전 NAV · USD" value={usd(estimate.preTaxNavUsd)} />
        <Metric label="추정 세후 NAV · USD" value={usd(estimate.afterTaxNavUsd)} />
        <Metric label="세전 누적손익 · USD" value={usd(estimate.preTaxPnlUsd)} />
        <Metric label="추정 세후 누적손익 · USD" value={usd(estimate.afterTaxPnlUsd)} />
      </dl>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3">
        <Metric label="당해 연도 실현손익 · KRW" value={krw(estimate.currentYearRealizedKrw)} />
        <Metric label="당해 연도 예상 세액 · KRW" value={krw(estimate.currentYearTaxKrw)} />
        <Metric label="이전 연도 미납 추정액 · KRW" value={krw(estimate.priorYearUnpaidKrw)} />
        <Metric label="미납세금 유보액 합계 · KRW" value={krw(estimate.unpaidReserveKrw)} />
      </dl>

      {estimate.assumptions.length > 0 ? (
        <ul
          className="mt-3 space-y-1 text-[11px] text-muted-foreground"
          aria-label="세금 모형 가정"
        >
          {estimate.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{US_TAX_DISCLAIMER}</p>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {estimate.status === "PARTIAL"
          ? "등록 거래 기준의 일부 추정치입니다. "
          : "세무자료 확인 범위 내 참고 추정치입니다. "}
        실제 총 납세액 확정에는 다른 계좌·과세대상 주식 합산과 세무 확인이 필요합니다. 미확인은
        0원이나 비과세를 뜻하지 않습니다.
      </p>
      {missing.length > 0 ? (
        <div className="mt-3 rounded-md bg-muted/50 p-3 text-[11px] leading-relaxed">
          <p className="font-medium">산출에 필요한 미확인 자료</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
            {missing.map((field) => (
              <li key={field} className="break-words">
                {field}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="mt-3 border-t pt-2 text-[11px] leading-relaxed">
        <summary className="cursor-pointer rounded py-1 font-medium text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          세금 계산 기준·유보액·공식 출처
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>RIA·환헤지 등 특례/세액공제 미반영. 해당 여부는 별도로 확인해야 합니다.</p>
          <p>
            귀속 연도는 결제일 기준입니다. 원화 실현손익에는 매수·매도 각각의 결제일 환율과
            취득원가·필요경비 확인이 필요합니다. 현재 환율로 USD 실현손익 전체를 환산하지 않습니다.
          </p>
          <p>
            당해 연도 예상 세액은 해당 연도 세금 총액 추정치이며, 미납세금 유보액 합계는 납부 내역을
            반영한 당해·이전 연도 미납 추정액입니다. 추정 세후 NAV·손익에는 이 유보액과 원장 밖에서
            이미 납부한 세금의 확인된 USD 금액을 차감합니다. NAV에 반영된 납부액은 중복 차감하지
            않습니다. 화면의 참고 표시이며 실제 현금 차감·세후 재투자 성과가 아닙니다.
          </p>
          <p>
            A0·A2·B3 모델은 각각 독립된 연간 세금 계산으로 비교합니다. 화면 날짜 필터는 연간
            손익·기본공제의 범위를 바꾸지 않습니다. 기존 모델 비용 가정은 매수·매도 각각 0.25%를
            유지합니다.
          </p>
          <p>
            {estimate.valuationFx
              ? `유보액 USD 환산용 평가환율: ${estimate.valuationFx.date} · 1 USD = ${estimate.valuationFx.krwPerUsd.toLocaleString("ko-KR", { maximumFractionDigits: 6 })} KRW · 출처 ${estimate.valuationFx.source}`
              : estimate.unpaidReserveKrw === 0
                ? "유보액이 0원이므로 환산이 필요하지 않습니다"
                : "유보액 USD 환산용 평가환율: 미확인"}
            . 이 평가환율은 유보액 환산에만 쓰며 매매별 세금 계산용 환율을 대신하지 않습니다.
          </p>
          <p>
            세법 확인일 {estimate.lawAsOf} · 계산 버전 {estimate.version}
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="양도소득세 공식 참고자료">
            {US_TAX_SOURCES.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {source.label}
                  <span className="sr-only"> (새 창)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}
