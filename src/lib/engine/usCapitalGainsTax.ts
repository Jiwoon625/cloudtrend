import { z } from "zod";

/** Reporting-only estimate. Never used to mutate cash, positions, signals or saved NAV. */
export const US_TAX_VERSION = "KR-US-CGT-2026-10-03-v1";
export const US_TAX_LAW_AS_OF = "2026-10-03";
export const US_TAX_DEDUCTION_KRW = 2_500_000;
export const US_TAX_DISCLAIMER =
  "연간 과세대상 주식 실현손익 합산 후 기본공제 250만원 초과분 통상 22%(지방소득세 포함). 미실현손익·배당 제외. 다른 계좌 합산 필요.";
export const US_TAX_SOURCES = [
  {
    label: "국세청 계산 안내",
    url: "https://www.nts.go.kr/nts/na/ntt/selectNttInfo.do?nttSn=1350890",
  },
  {
    label: "국세청 세율",
    url: "https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7711&mi=2312",
  },
  { label: "지방세법 세율", url: "https://law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1021847601" },
  {
    label: "외화 환산 기준",
    url: "https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=05&joNo=0178&lsiSeq=286211&urlMode=lsScJoRltInfoR",
  },
] as const;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(v);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  });
const amount = z.number().finite().nonnegative().max(1e15);
const source = z.string().trim().min(1).max(500);
const fx = z.object({ date, krwPerUsd: z.number().finite().positive().max(1e6), source });

const basis = z.object({
  lotId: source,
  buySettlementDate: date,
  grossCostUsd: amount,
  buyFx: fx,
  // Includes the allocated, tax-deductible acquisition expense exactly once.
  eligibleAcquisitionExpenseKrw: amount,
  expenseSource: source,
});
const sale = z.object({
  id: source,
  poolId: source,
  accountId: source,
  accountTaxRegime: z.enum(["ORDINARY", "ISA", "UNKNOWN"]),
  instrumentTaxKind: z.enum([
    "FOREIGN_DIRECT_STOCK",
    "FOREIGN_DIRECT_CORPORATE_ETF",
    "DOMESTIC_TAXABLE_STOCK",
    "OTHER",
  ]),
  settlementDate: date,
  grossProceedsUsd: amount,
  sellFx: fx,
  eligibleDisposalExpenseKrw: amount,
  expenseSource: source,
  basisMethod: z.enum(["BROKER_CONFIRMED", "FIFO_MODEL", "MOVING_AVERAGE_MODEL"]),
  basisSource: source,
  acquisitionLots: z.array(basis).min(1),
  // No rates/classifications are inferred from ticker, venue, or portfolio market.
  taxClass: z.enum(["STANDARD_20_PERCENT", "EXCLUDED", "UNSUPPORTED"]),
});
const priorLiability = z.object({
  taxYear: z.number().int().min(1900),
  liabilityKrw: amount,
  source,
});
const payment = z.object({
  id: source,
  poolId: source,
  taxYear: z.number().int().min(1900),
  paidDate: date,
  amountKrw: amount,
  source,
  navTreatment: z.enum(["ALREADY_INCLUDED", "OUTSIDE_NAV"]),
  // A historical payment is not translated at today's reserve valuation FX.
  paidUsd: amount.nullable(),
});
export const usTaxEvidenceSchema = z.object({
  version: z.literal(US_TAX_VERSION),
  scope: z.object({
    kind: z.enum(["ACTUAL_OWNER", "COUNTERFACTUAL"]),
    poolId: source,
    strategyId: source.nullable(),
  }),
  coverage: z.object({
    historyStartYear: z.number().int().min(1900),
    throughDate: date,
    transactions: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]),
    accounts: z.enum(["ALL_TAXABLE_ACCOUNTS", "REGISTERED_ONLY", "UNKNOWN"]),
    priorLiabilities: z.enum(["COMPLETE", "UNKNOWN"]),
    residency: z.enum(["CONFIRMED", "MODEL_ASSUMPTION", "UNKNOWN"]),
    // The broker/source explicitly verified settlement, corporate actions and fee treatment.
    reconciled: z.boolean(),
    source,
  }),
  sales: z.array(sale),
  openingLiabilities: z.array(priorLiability),
  payments: z.array(payment),
  valuationFx: fx.nullable(),
  assumptions: z.array(source).optional(),
});
export type UsTaxEvidence = z.infer<typeof usTaxEvidenceSchema>;
export type UsTaxSale = z.infer<typeof sale>;
export type UsTaxValuationFx = z.infer<typeof fx>;
export interface UsTaxOverlayResult {
  version: string;
  lawAsOf: string;
  asOf: string;
  status: "ESTIMATE" | "PARTIAL" | "UNAVAILABLE";
  scopeLabel: string;
  taxYear: number;
  currentYearRealizedKrw: number | null;
  currentYearTaxKrw: number | null;
  priorYearUnpaidKrw: number | null;
  unpaidReserveKrw: number | null;
  preTaxNavUsd: number | null;
  afterTaxNavUsd: number | null;
  preTaxPnlUsd: number | null;
  afterTaxPnlUsd: number | null;
  missingFields: string[];
  valuationFx: UsTaxValuationFx | null;
  assumptions: string[];
  annual: Array<{
    taxYear: number;
    realizedKrw: number | null;
    nationalTaxKrw: number | null;
    localTaxKrw: number | null;
    liabilityKrw: number;
    paidKrw: number;
    unpaidKrw: number;
  }>;
}
export interface UsTaxOverlayInput {
  asOf: string;
  preTaxNavUsd: number | null;
  initialCapitalUsd: number | null;
  kind: "ACTUAL_OWNER" | "COUNTERFACTUAL";
  poolId: string;
  strategyId: string | null;
  evidence: unknown;
}
const validNumber = (n: number | null) => n !== null && Number.isFinite(n);
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function estimateAnnualUsTax(realizedKrw: number) {
  if (!Number.isFinite(realizedKrw)) throw new Error("원화 실현손익을 확인하세요.");
  const taxableKrw = Math.max(0, realizedKrw - US_TAX_DEDUCTION_KRW);
  const nationalTaxKrw = round(taxableKrw * 0.2);
  const localTaxKrw = round(taxableKrw * 0.02);
  return {
    taxableKrw,
    nationalTaxKrw,
    localTaxKrw,
    liabilityKrw: round(nationalTaxKrw + localTaxKrw),
  };
}

/** All accounts/strategies for one actual owner must be supplied in ONE call/pool. */
export function estimateUsTaxOverlay(input: UsTaxOverlayInput): UsTaxOverlayResult {
  const result: UsTaxOverlayResult = {
    version: US_TAX_VERSION,
    lawAsOf: US_TAX_LAW_AS_OF,
    asOf: input.asOf,
    status: "UNAVAILABLE",
    scopeLabel:
      input.kind === "ACTUAL_OWNER"
        ? "실제 소유자 · 과세대상 계좌 합산"
        : "독립 비교전략 · 가상 납세자",
    taxYear: Number(input.asOf.slice(0, 4)),
    currentYearRealizedKrw: null,
    currentYearTaxKrw: null,
    priorYearUnpaidKrw: null,
    unpaidReserveKrw: null,
    preTaxNavUsd: validNumber(input.preTaxNavUsd) ? input.preTaxNavUsd : null,
    afterTaxNavUsd: null,
    preTaxPnlUsd:
      validNumber(input.preTaxNavUsd) && validNumber(input.initialCapitalUsd)
        ? round(input.preTaxNavUsd! - input.initialCapitalUsd!)
        : null,
    afterTaxPnlUsd: null,
    missingFields: [],
    valuationFx: null,
    assumptions: [],
    annual: [],
  };
  const missing = (s: string) => {
    if (!result.missingFields.includes(s)) result.missingFields.push(s);
  };
  if (!date.safeParse(input.asOf).success) {
    missing("평가 기준일 확인 필요");
    return result;
  }
  const parsed = usTaxEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) {
    missing("검증된 세무자료 필요: 취득원가·결제일·매수/매도 결제환율·인정 필요경비·원장 완전성");
    return result;
  }
  const e = parsed.data;
  if (
    e.scope.kind !== input.kind ||
    e.scope.poolId !== input.poolId ||
    e.scope.strategyId !== input.strategyId
  )
    missing("소유자·실제/Shadow·전략별 세금 풀 불일치");
  if (e.coverage.throughDate !== input.asOf || e.coverage.historyStartYear > result.taxYear)
    missing("기준일까지의 연간 거래 이력 미확인");
  if (e.coverage.transactions === "UNKNOWN" || e.coverage.accounts === "UNKNOWN")
    missing("계좌·거래 누락 여부 미확인");
  if (!e.coverage.reconciled) missing("취득원가·이전입고·기업행사·수수료 증빙 대사 필요");
  if (
    e.coverage.residency === "UNKNOWN" ||
    (input.kind === "ACTUAL_OWNER" && e.coverage.residency !== "CONFIRMED")
  )
    missing("국외주식 과세 거주요건 확인 필요");
  const priorLiabilitiesUnknown = e.coverage.priorLiabilities !== "COMPLETE";
  result.assumptions = e.assumptions ?? [];
  const ids = new Set<string>();
  const gains = new Map<number, number>();
  for (const s of e.sales) {
    if (ids.has(s.id)) missing("중복 실현거래 ID");
    ids.add(s.id);
    if (s.poolId !== input.poolId) missing("다른 소유자/비교전략의 거래가 포함됨");
    if (s.accountTaxRegime !== "ORDINARY")
      missing("일반계좌 확인 필요: ISA·미확인 계좌는 미국 양도세 풀에서 분리");
    if (s.instrumentTaxKind === "DOMESTIC_TAXABLE_STOCK" && s.taxClass !== "EXCLUDED")
      missing("과세 국내주식 원화 원가·손익 및 공제 배분은 별도 확인 필요 (v1 USD 계산 미지원)");
    if (s.instrumentTaxKind === "OTHER" && s.taxClass !== "EXCLUDED")
      missing("상품별 과세 분류 확인 필요 (특수상품·국내상장 ETF 미지원)");
    if (s.settlementDate > input.asOf) continue; // Settlement, never order/trade date, assigns year.
    if (s.taxClass === "EXCLUDED") continue;
    if (s.taxClass === "UNSUPPORTED") {
      missing("다른 세율·특수상품의 법정 손익/공제 배분 미지원");
      continue;
    }
    const year = Number(s.settlementDate.slice(0, 4));
    if (year < e.coverage.historyStartYear)
      missing("시작 연도 이전 거래와 기초 세금부채 중복 가능");
    if (s.sellFx.date !== s.settlementDate) missing("매도 결제일 기준환율 불일치");
    if (input.kind === "ACTUAL_OWNER" && s.basisMethod !== "BROKER_CONFIRMED")
      missing("실제 취득원가는 증권사 세무자료 확인 필요");
    const lots = new Set<string>();
    for (const lot of s.acquisitionLots) {
      if (lots.has(lot.lotId)) missing("한 매도의 취득원가 배분 중복");
      lots.add(lot.lotId);
      if (lot.buySettlementDate > s.settlementDate || lot.buyFx.date !== lot.buySettlementDate)
        missing("매수 결제일·결제환율 확인 필요");
    }
    const basisKrw = s.acquisitionLots.reduce(
      (sum, lot) =>
        sum + lot.grossCostUsd * lot.buyFx.krwPerUsd + lot.eligibleAcquisitionExpenseKrw,
      0,
    );
    const gain = s.grossProceedsUsd * s.sellFx.krwPerUsd - basisKrw - s.eligibleDisposalExpenseKrw;
    gains.set(year, (gains.get(year) ?? 0) + gain);
  }
  const annual = new Map<number, UsTaxOverlayResult["annual"][number]>();
  for (const opening of e.openingLiabilities) {
    if (opening.taxYear >= e.coverage.historyStartYear || annual.has(opening.taxYear))
      missing("기초 세금부채 귀속연도 중복/범위 오류");
    annual.set(opening.taxYear, {
      taxYear: opening.taxYear,
      realizedKrw: null,
      nationalTaxKrw: null,
      localTaxKrw: null,
      liabilityKrw: opening.liabilityKrw,
      paidKrw: 0,
      unpaidKrw: opening.liabilityKrw,
    });
  }
  for (let year = e.coverage.historyStartYear; year <= result.taxYear; year++) {
    const realizedKrw = round(gains.get(year) ?? 0);
    const tax = estimateAnnualUsTax(realizedKrw);
    annual.set(year, {
      taxYear: year,
      realizedKrw,
      nationalTaxKrw: tax.nationalTaxKrw,
      localTaxKrw: tax.localTaxKrw,
      liabilityKrw: tax.liabilityKrw,
      paidKrw: 0,
      unpaidKrw: tax.liabilityKrw,
    });
  }
  let outsideNavPaidUsd = 0;
  const paymentIds = new Set<string>();
  for (const p of e.payments) {
    if (paymentIds.has(p.id)) missing("중복 세금 납부 ID");
    paymentIds.add(p.id);
    if (p.poolId !== input.poolId) missing("다른 소유자/비교전략의 세금 납부가 포함됨");
    if (p.paidDate > input.asOf) continue;
    const year = annual.get(p.taxYear);
    if (!year || p.taxYear > Number(p.paidDate.slice(0, 4))) {
      missing("세금 납부의 귀속연도 부채 미확인");
      continue;
    }
    year.paidKrw += p.amountKrw;
    if (p.navTreatment === "OUTSIDE_NAV") {
      if (p.paidUsd !== null && (p.amountKrw === 0) !== (p.paidUsd === 0))
        missing("세금 납부 KRW/USD 금액의 0 여부 불일치");
      if (p.paidUsd === null) missing("원장 밖 납부세액의 실제 USD 환산액 필요");
      else outsideNavPaidUsd += p.paidUsd;
    }
  }
  for (const year of annual.values()) {
    if (year.paidKrw > year.liabilityKrw) missing("초과납부·환급 처리 확인 필요");
    year.unpaidKrw = round(Math.max(0, year.liabilityKrw - year.paidKrw));
  }
  if (result.missingFields.length) return result;
  result.annual = [...annual.values()].sort((a, b) => a.taxYear - b.taxYear);
  result.currentYearRealizedKrw = annual.get(result.taxYear)!.realizedKrw;
  result.currentYearTaxKrw = annual.get(result.taxYear)!.liabilityKrw;
  const partial =
    e.coverage.transactions === "PARTIAL" || e.coverage.accounts === "REGISTERED_ONLY";
  result.scopeLabel = partial ? "등록 거래 기준 · 전체 계좌 세금 미확인" : result.scopeLabel;
  result.status = partial ? "PARTIAL" : "ESTIMATE";
  if (priorLiabilitiesUnknown) {
    missing("이전 연도 미납세액·납부 이력 미확인: 당해 연도 세액과 별도 확인");
    result.status = "PARTIAL";
    return result;
  }
  result.priorYearUnpaidKrw = round(
    result.annual.filter((y) => y.taxYear < result.taxYear).reduce((n, y) => n + y.unpaidKrw, 0),
  );
  result.unpaidReserveKrw = round(result.annual.reduce((n, y) => n + y.unpaidKrw, 0));
  if (result.unpaidReserveKrw === 0) {
    // No currency conversion is needed for an independently verified zero liability.
    if (result.preTaxNavUsd !== null) {
      result.afterTaxNavUsd = round(result.preTaxNavUsd - outsideNavPaidUsd);
      if (validNumber(input.initialCapitalUsd))
        result.afterTaxPnlUsd = round(result.afterTaxNavUsd - input.initialCapitalUsd!);
    }
    if (e.valuationFx?.date === input.asOf) result.valuationFx = e.valuationFx;
  } else if (!e.valuationFx || e.valuationFx.date !== input.asOf) {
    missing("NAV 평가일의 별도 USD/KRW 환율 필요 (세무 결제환율과 구분)");
  } else {
    result.valuationFx = e.valuationFx;
    if (result.preTaxNavUsd !== null) {
      result.afterTaxNavUsd = round(
        result.preTaxNavUsd - result.unpaidReserveKrw / e.valuationFx.krwPerUsd - outsideNavPaidUsd,
      );
      if (validNumber(input.initialCapitalUsd))
        result.afterTaxPnlUsd = round(result.afterTaxNavUsd - input.initialCapitalUsd!);
    }
  }
  return result;
}
