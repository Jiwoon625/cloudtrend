import type { KrxReviewField, KrxReviewReference } from "@/lib/krxReviewReference";

const labels: Record<KrxReviewField, string> = {
  marketCap: "시가총액",
  listedShares: "상장주식수",
  tradingValue: "거래대금",
  nav: "NAV",
  aum: "순자산총액(AUM)",
  listedUnits: "상장좌수",
  underlyingIndexName: "기초지수",
  underlyingIndexClose: "기초지수 종가",
};
export function KrxReviewReferenceDetails({
  reference,
  etf = false,
}: {
  reference?: KrxReviewReference | undefined;
  etf?: boolean;
}) {
  if (!reference)
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        KRX 참고값 준비 전 · 새 스크리닝 후 표시
      </p>
    );
  const fields: KrxReviewField[] = etf
    ? [
        "tradingValue",
        "marketCap",
        "nav",
        "aum",
        "listedUnits",
        "underlyingIndexName",
        "underlyingIndexClose",
      ]
    : ["marketCap", "listedShares"];
  const dates = [
    ...new Set(
      fields
        .map((field) => reference?.fields[field]?.date)
        .filter((date): date is string => Boolean(date)),
    ),
  ].sort();
  const prior = dates.some((date) => date < (reference?.reviewDate ?? ""));
  const preview = reference.preliminary;
  const number = (value: number | null | undefined, digits = 2) =>
    value === null || value === undefined ? "미확인" :
    value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
  return (
    <div className="mt-2">
      {preview ? (
        <div className="mb-2 rounded border border-border bg-muted/40 p-2 text-[11px]" aria-label="전일 KRX 예비판단">
          <p className="font-semibold">
            저녁 예비판단 · 가격 {preview.priceDate} / KRX 직전 거래일 {preview.referenceDate}
          </p>
          {preview.kind === "STOCK" ? (
            <p>
              시총 {number(preview.marketCap, 0)}원 ({preview.marketCapDate ?? "미수신"}) ·{" "}
              {preview.stockUniverse === "PASS"
                ? "유니버스 잠정 충족"
                : preview.stockUniverse === "FAIL"
                  ? "유니버스 잠정 미충족"
                  : "유니버스 잠정판정 불가"} · 최종 진입 미확정
            </p>
          ) : (
            <>
              <p>
                예비 M0 {number(preview.m0)} / 100 ·
                {preview.preliminaryOnset === true
                  ? " 예비 신규 돌파"
                  : preview.preliminaryOnset === false
                    ? " 예비 신규 돌파 없음"
                    : " 신규 돌파 판정 불가"}
                {" "}· 최종 진입 미확정
              </p>
              <p>
                KRX 시총 {number(preview.marketCap, 0)}원 ({preview.marketCapDate ?? "미수신"}) ·
                20일 평균 거래대금 {number(preview.averageTradingValue20, 0)}원
                (실제 관측 종료 {preview.tradingValueThrough ?? "미확인"})
              </p>
              <p>
                마지막 확정 기초지수 {number(preview.underlyingClose)} / MA60{" "}
                {number(preview.underlyingMa60)} · 기준일 {preview.underlyingDate ?? "미확인"}
                {" "}· 당일 청산 판정 아님
              </p>
            </>
          )}
          {preview.issues.length > 0 ? (
            <p className="text-muted-foreground">검증 필요: {preview.issues.join(" · ")}</p>
          ) : null}
          <p className="text-muted-foreground">
            직전 확정 KRX 관측을 임시 적용한 참고 계산입니다. 최종 M0·원신호·진입·청산·주문·Shadow 원장에는 반영하지 않습니다.
          </p>
        </div>
      ) : null}
      <details className="text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        {prior ? "직전 KRX 참고값" : "KRX 참고값"} ·{" "}
        {dates.length ? `기준일 ${dates.join(" · ")}` : "미수신 / 기준일 미확인"}
      </summary>
      <p className="mt-1 text-muted-foreground">
        참고 전용 · 직전값은 당일 자격·점수·진입 판단에 대입하지 않습니다.
      </p>
      <dl className="mt-1 space-y-1">
        {fields.map((field) => {
          const fact = reference?.fields[field];
          const money = ["marketCap", "tradingValue", "nav", "aum"].includes(field);
          const unit = money
            ? "원"
            : field === "listedShares"
              ? "주"
              : field === "listedUnits"
                ? "좌"
                : "";
          return (
            <div key={field} className="flex flex-wrap gap-x-2">
              <dt>{labels[field]}</dt>
              <dd>
                {fact
                  ? `${typeof fact.value === "number" ? fact.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : fact.value}${unit} · ${fact.date}${fact.date < (reference?.reviewDate ?? "") ? " (직전 참고)" : " (당일)"}`
                  : "미수신 / 기준일 미확인"}
              </dd>
            </div>
          );
        })}
      </dl>
      </details>
    </div>
  );
}
