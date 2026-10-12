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
  return (
    <details className="mt-2 text-[11px]">
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
  );
}
