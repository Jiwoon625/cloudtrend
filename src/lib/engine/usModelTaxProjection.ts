import { z } from "zod";
import { US_PROSPECTIVE_RULE_VERSION } from "./usProspective";
import { US_PROSPECTIVE_STRATEGIES, US_PROSPECTIVE_ONE_WAY_COST } from "./usProspectivePortfolio";
import { US_TAX_VERSION, type UsTaxEvidence, type UsTaxSale } from "./usCapitalGainsTax";
import type { modelTaxEvidenceSchema, modelTaxSourceSchema } from "../usTaxOverlay";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const finite = z.number().finite();
const positive = finite.positive();
const position = z.object({ shares: positive.int().safe(), lastPrice: positive });
const snapshotSchema = z.object({
  strategy_id: z.string(),
  date,
  rule_version: z.string(),
  nav_usd: finite,
  cash_usd: finite,
  fees_usd: finite.nonnegative(),
  state: z.object({
    initializedDate: date,
    initialCapital: positive,
    lastDate: date,
    cash: finite,
    positions: z.record(position),
  }),
});
const fillSchema = z.object({
  trade_key: z.string().min(1),
  strategy_id: z.string(),
  execution_date: date,
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL", "REBALANCE_BUY", "REBALANCE_SELL"]),
  status: z.enum(["EXECUTED", "PARTIAL"]),
  model_price: positive,
  model_shares: positive.int().safe(),
  model_notional: positive,
  fee_usd: finite.nonnegative(),
});
const sourceSchema = z.object({
  strategyId: z.string(),
  sourceDate: date,
  registry: z.object({
    strategy_id: z.string(),
    rule_version: z.string(),
    config: z.unknown(),
    frozen_at: z.string().min(1),
  }),
  snapshots: z.array(snapshotSchema).min(1),
  trades: z.array(fillSchema),
  sourceProofs: z
    .array(
      z.object({
        date,
        dataHash: z.string().min(1),
        ruleVersion: z.string(),
        previousSessionDate: date.nullable(),
        confirmedRegularClose: z.literal(true),
        failedSymbols: z.literal(0),
      }),
    )
    .min(1),
  completed: z
    .array(z.object({ date, rule_version: z.string(), data_hash: z.string().min(1) }))
    .min(1),
});
export type UsModelTaxSource = z.infer<typeof sourceSchema>;
/** Supplied only from independently sourced tax settlement dates and FX, never trading-day guesses. */
const timingSchema = z.object({
  byTradeKey: z.record(
    z.object({
      settlementDate: date,
      krwPerUsd: positive.nullable(),
      fxSource: z.string().min(1).nullable(),
      settlementSource: z.string().min(1),
      instrumentTaxKind: z.enum(["FOREIGN_DIRECT_STOCK", "FOREIGN_DIRECT_CORPORATE_ETF"]),
    }),
  ),
  valuationFx: z.object({ date, krwPerUsd: positive, source: z.string().min(1) }).nullable(),
});
export type UsModelTaxTiming = z.infer<typeof timingSchema>;
export interface UsModelTaxProjection {
  strategyId: string;
  sourceDate: string;
  taxEvidence: z.infer<typeof modelTaxEvidenceSchema> | null;
  taxSource: z.infer<typeof modelTaxSourceSchema> | null;
  missingFields: string[];
}
export function stableTaxJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTaxJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableTaxJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const sameMoney = (a: number, b: number) => Math.abs(a - b) <= 0.011;
/** Closed counterfactual only. Reconciles its complete journal before assigning any zero or basis. */
export async function buildUsModelTaxProjection(
  raw: unknown,
  timing?: UsModelTaxTiming,
): Promise<UsModelTaxProjection> {
  const parsed = sourceSchema.safeParse(raw);
  const out: UsModelTaxProjection = {
    strategyId: parsed.success ? parsed.data.strategyId : "UNKNOWN",
    sourceDate: parsed.success ? parsed.data.sourceDate : "",
    taxEvidence: null,
    taxSource: null,
    missingFields: [],
  };
  const missing = (message: string) => {
    if (!out.missingFields.includes(message)) out.missingFields.push(message);
  };
  if (!parsed.success) {
    missing("모델 전체 원장·초기 상태·완료 이력의 필수 필드 확인 필요");
    return out;
  }
  const s = parsed.data;
  if (timing !== undefined && !timingSchema.safeParse(timing).success) {
    missing("모델 결제일·환율 증거의 형식 또는 출처 확인 필요");
    return out;
  }
  for (const [key, facts] of Object.entries(timing?.byTradeKey ?? {})) {
    const fill = s.trades.find((t) => t.trade_key === key);
    if (!fill || facts.settlementDate < fill.execution_date)
      missing("결제일은 해당 모델 체결일보다 빠를 수 없음");
    if (facts.settlementDate > s.sourceDate && facts.krwPerUsd !== null)
      missing("미래 결제일 환율을 이미 확정된 값으로 사용할 수 없음");
    if (facts.settlementDate <= s.sourceDate && (facts.krwPerUsd === null || !facts.fxSource))
      missing("결제 완료분의 환율·출처 확인 필요");
  }

  const config = US_PROSPECTIVE_STRATEGIES.find((c) => c.id === s.strategyId);
  if (
    !config ||
    s.registry.strategy_id !== s.strategyId ||
    s.registry.rule_version !== US_PROSPECTIVE_RULE_VERSION ||
    stableTaxJson(s.registry.config) !== stableTaxJson(config)
  )
    missing("동결된 모델 전략·규칙 원천 불일치");
  const snapshots = [...s.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const first = snapshots[0]!,
    latest = snapshots.at(-1)!;
  if (
    first.date !== first.state.initializedDate ||
    first.state.initialCapital !== 100000 ||
    Object.keys(first.state.positions).length ||
    !sameMoney(first.cash_usd, 100000) ||
    !sameMoney(first.nav_usd, 100000) ||
    first.fees_usd !== 0
  )
    missing("현금만 있는 동결 초기 상태를 확인할 수 없어 모델 세금을 0으로 가정하지 않음");
  const frozenAt = new Date(s.registry.frozen_at);
  const frozenDate = Number.isFinite(frozenAt.getTime())
    ? frozenAt.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
    : "";
  if (
    !frozenDate ||
    snapshots.some(
      (day) =>
        day.date < frozenDate &&
        (Object.keys(day.state.positions).length > 0 ||
          !sameMoney(day.cash_usd, 100000) ||
          day.fees_usd !== 0),
    ) ||
    s.trades.some((fill) => fill.execution_date < frozenDate)
  )
    missing("전략 동결 전 체결 또는 비어 있지 않은 초기 이력은 세금 모형에 사용할 수 없음");
  const completed = [...s.completed].sort((a, b) => a.date.localeCompare(b.date));
  if (
    latest.date !== s.sourceDate ||
    stableTaxJson(snapshots.map((r) => r.date)) !== stableTaxJson(completed.map((r) => r.date)) ||
    new Set(completed.map((r) => r.date)).size !== completed.length ||
    completed.some((r) => r.rule_version !== s.registry.rule_version)
  )
    missing("초기일부터 기준일까지 모델 스냅샷·완료 이력 누락/불일치");
  const proofs = [...s.sourceProofs].sort((a, b) => a.date.localeCompare(b.date));
  if (
    proofs.length !== completed.length ||
    proofs.some(
      (proof, i) =>
        proof.date !== completed[i]?.date ||
        proof.dataHash !== completed[i]?.data_hash ||
        proof.ruleVersion !== s.registry.rule_version ||
        (i > 0 && proof.previousSessionDate !== proofs[i - 1]!.date),
    )
  )
    missing("동결 일별 입력의 완료 해시·이전 거래일 연결이 누락되어 전체 이력 확인 불가");
  const trades = [...s.trades].sort(
    (a, b) =>
      a.execution_date.localeCompare(b.execution_date) ||
      Number(a.side.endsWith("BUY")) - Number(b.side.endsWith("BUY")) ||
      a.trade_key.localeCompare(b.trade_key),
  );
  const dates = new Set(snapshots.map((r) => r.date));
  if (
    new Set(trades.map((t) => t.trade_key)).size !== trades.length ||
    trades.some(
      (t) =>
        t.strategy_id !== s.strategyId ||
        !dates.has(t.execution_date) ||
        t.execution_date <= first.date ||
        !sameMoney(t.model_notional, t.model_price * t.model_shares) ||
        !sameMoney(t.fee_usd, t.model_notional * US_PROSPECTIVE_ONE_WAY_COST),
    )
  )
    missing("모델 체결 중복·기간·수량·금액 불일치");
  if (out.missingFields.length) return out;
  type Lot = { id: string; shares: number; price: number };
  const lots = new Map<string, Lot[]>();
  let cash = first.cash_usd;
  const sales: UsTaxSale[] = [];
  for (const day of snapshots) {
    let dayFees = 0;
    if (
      day.strategy_id !== s.strategyId ||
      day.rule_version !== s.registry.rule_version ||
      day.state.initializedDate !== first.date ||
      day.state.initialCapital !== 100000 ||
      day.state.lastDate !== day.date ||
      !sameMoney(day.state.cash, day.cash_usd)
    )
      missing("모델 일별 동결 상태 불일치");
    for (const fill of trades.filter((t) => t.execution_date === day.date)) {
      dayFees += fill.fee_usd;
      const queue = lots.get(fill.symbol) ?? [];
      const buy = fill.side.endsWith("BUY");
      cash += (buy ? -fill.model_notional : fill.model_notional) - fill.fee_usd;
      if (buy)
        queue.push({ id: fill.trade_key, shares: fill.model_shares, price: fill.model_price });
      else {
        const allocations: Array<{ lot: Lot; shares: number }> = [];
        let remaining = fill.model_shares;
        while (remaining > 0 && queue.length) {
          const lot = queue[0]!,
            used = Math.min(remaining, lot.shares);
          allocations.push({ lot: { ...lot }, shares: used });
          lot.shares -= used;
          remaining -= used;
          if (lot.shares === 0) queue.shift();
        }
        if (remaining) missing("모델 매도 취득원가 수량이 부족하여 FIFO 원가 산출 불가");
        const sellTiming = timing?.byTradeKey[fill.trade_key];
        if (!sellTiming) missing("모델 매도의 검증된 세무 결제일·결제환율 필요");
        else if (sellTiming.settlementDate <= s.sourceDate) {
          const acquisitionLots: UsTaxSale["acquisitionLots"] = [];
          for (const { lot, shares } of allocations) {
            const buyTiming = timing?.byTradeKey[lot.id];
            if (!buyTiming) {
              missing("매도분 FIFO 취득일의 검증된 결제일·환율 필요");
              continue;
            }
            acquisitionLots.push({
              lotId: lot.id,
              buySettlementDate: buyTiming.settlementDate,
              grossCostUsd: lot.price * shares,
              buyFx: {
                date: buyTiming.settlementDate,
                krwPerUsd: buyTiming.krwPerUsd!,
                source: buyTiming.fxSource!,
              },
              eligibleAcquisitionExpenseKrw: 0,
              expenseSource: "MODEL_ASSUMPTION_COMPOSITE_COST_NOT_DEDUCTED",
            });
          }
          sales.push({
            id: fill.trade_key,
            poolId: `COUNTERFACTUAL:${s.strategyId}`,
            accountId: `MODEL:${s.strategyId}`,
            accountTaxRegime: "ORDINARY",
            instrumentTaxKind: sellTiming.instrumentTaxKind,
            settlementDate: sellTiming.settlementDate,
            grossProceedsUsd: fill.model_notional,
            sellFx: {
              date: sellTiming.settlementDate,
              krwPerUsd: sellTiming.krwPerUsd!,
              source: sellTiming.fxSource!,
            },
            eligibleDisposalExpenseKrw: 0,
            expenseSource: "MODEL_ASSUMPTION_COMPOSITE_COST_NOT_DEDUCTED",
            basisMethod: "FIFO_MODEL",
            basisSource:
              `Completed model FIFO; settlement evidence: ${sellTiming.settlementSource}`.slice(
                0,
                500,
              ),
            acquisitionLots,
            taxClass: "STANDARD_20_PERCENT",
          });
        }
      }
      lots.set(fill.symbol, queue);
    }
    const shares = Object.fromEntries(
      [...lots.entries()]
        .map(([symbol, queue]) => [symbol, queue.reduce((n, lot) => n + lot.shares, 0)])
        .filter(([, n]) => n !== 0),
    );
    const savedShares = Object.fromEntries(
      Object.entries(day.state.positions).map(([symbol, p]) => [symbol, p.shares]),
    );
    if (
      stableTaxJson(shares) !== stableTaxJson(savedShares) ||
      !sameMoney(cash, day.cash_usd) ||
      !sameMoney(dayFees, day.fees_usd) ||
      !sameMoney(
        day.nav_usd,
        day.cash_usd +
          Object.values(day.state.positions).reduce((n, p) => n + p.shares * p.lastPrice, 0),
      )
    )
      missing("모델 일별 체결 합계와 현금·보유·비용·NAV 대사 불일치");
  }
  if (out.missingFields.length) return out;
  const bytes = new TextEncoder().encode(
    stableTaxJson({ source: s, timing: timing ?? null, taxVersion: US_TAX_VERSION }),
  );
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const revision = `${s.sourceDate}:${digest}`;
  const evidence: UsTaxEvidence = {
    version: US_TAX_VERSION,
    scope: {
      kind: "COUNTERFACTUAL",
      poolId: `COUNTERFACTUAL:${s.strategyId}`,
      strategyId: s.strategyId,
    },
    coverage: {
      historyStartYear: Number(first.date.slice(0, 4)),
      throughDate: s.sourceDate,
      transactions: "COMPLETE",
      accounts: "ALL_TAXABLE_ACCOUNTS",
      priorLiabilities: "COMPLETE",
      residency: "MODEL_ASSUMPTION",
      reconciled: true,
      source: `Frozen registry + empty bootstrap + completed daily journal reconciliation: ${digest}`,
    },
    sales,
    openingLiabilities: [],
    payments: [],
    valuationFx: timing?.valuationFx ?? null,
    assumptions: [
      "독립 가상 납세자 · 동결 초기일부터 전체 모델 체결 대사",
      "FIFO 원가 모형 · 합산 거래비용은 필요경비로 추가 공제하지 않는 보수적 추정",
      "기존 모형 비용은 그대로 유지하며 실제 계좌 세금과 합산하지 않음",
    ],
  };
  out.taxSource = { ledgerRevision: revision, ledgerDigest: digest };
  out.taxEvidence = {
    sourceLedgerRevision: revision,
    sourceLedgerDigest: digest,
    sourceDate: s.sourceDate,
    sourceRuleVersion: s.registry.rule_version,
    sourceNavUsd: latest.nav_usd,
    sourceCashUsd: latest.cash_usd,
    initialCapitalUsd: first.state.initialCapital,
    evidence,
  };
  return out;
}
