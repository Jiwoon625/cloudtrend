import { z } from "zod";
import { decimal, format } from "./ledger/decimal";
import { validDate } from "./ledger/date";

export const CAPITAL_PLAN_START = "2026-10-12" as const;
export const CAPITAL_PLAN_VERSION = "allocated-operating-plan-20261012-v1" as const;
export const CAPITAL_PLAN_POLICY = Object.freeze({
  kr: "ANNUAL_KR_NAV_DIV_30",
  us: "ANNUAL_USD_NAV_DIV_20",
  etf: "ANNUAL_ETF_NAV_TIMES_SIGNAL_VOLATILITY_WEIGHT",
  annualCutoff: "LAST_COMPLETE_PRIOR_YEAR_MARKET_SESSION_AVAILABLE_BEFORE_FIRST_SESSION",
  firstYear: "CONFIRMED_INITIAL_MARKET_ALLOCATION",
  pending: "KEEP_CONFIRMED_SIGNAL_BUDGET",
  rebalance: false,
  costs: "EXISTING_KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE",
} as const);
const messages = {
  input:
    "운용계획 입력을 확인하세요. 총 계획금액은 양수 원화 문자열이며 실제 현금·배분·환율은 입력하지 않습니다.",
  auth: "로그인 세션을 확인하세요.",
  missing: "기존 실제 원장을 먼저 대조해 주세요. 운용계획만으로 원장을 생성하지 않습니다.",
  conflict: "원장이 변경되었습니다. 최신 운용계획을 다시 읽고 검토해 주세요.",
  immutable: "저장된 초기 운용계획은 덮어쓸 수 없습니다. 기존 계획을 확인해 주세요.",
  uncertain:
    "저장 결과를 확인하지 못했습니다. 중복 저장하지 말고 최신 운용계획을 다시 읽어 주세요.",
  invalid: "저장된 운용계획을 검증하지 못했습니다. 계획을 새 값으로 덮어쓰지 말고 확인해 주세요.",
  generic: "운용계획을 처리하지 못했습니다. 최신 원장과 로그인 상태를 확인해 주세요.",
} as const;
export const CAPITAL_PLAN_ERRORS = messages;
export function capitalPlanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return Object.values(messages).find((allowed) => allowed === message) ?? messages.generic;
}
const amountPattern = /^\d{1,18}(?:\.\d{1,8})?$/;
const amount = z
  .string()
  .max(28)
  .regex(amountPattern)
  .refine((x) => amountPattern.test(x) && decimal(x) > 0n);
const stamp = z
  .string()
  .datetime({ offset: true })
  .refine((x) => validDate(x.slice(0, 10)));
const planSchema = z
  .object({
    version: z.literal(CAPITAL_PLAN_VERSION),
    startDate: z.literal(CAPITAL_PLAN_START),
    plannedCapitalKrw: amount.refine((x) => amountPattern.test(x) && format(decimal(x)) === x),
    currency: z.literal("KRW"),
    status: z.literal("ALLOCATION_PENDING"),
    allocation: z.null(),
    actualFunding: z.null(),
    initialHoldings: z.literal("EMPTY_NEW_SCOPE"),
    journalBoundary: z.literal("NOTION_MASTER_SEPARATE_NO_AUTOMATIC_SYNC"),
    integratedModel: z.literal("NOT_INITIALIZED_NO_TRADING"),
    policy: z
      .object({
        kr: z.literal(CAPITAL_PLAN_POLICY.kr),
        us: z.literal(CAPITAL_PLAN_POLICY.us),
        etf: z.literal(CAPITAL_PLAN_POLICY.etf),
        annualCutoff: z.literal(CAPITAL_PLAN_POLICY.annualCutoff),
        firstYear: z.literal(CAPITAL_PLAN_POLICY.firstYear),
        pending: z.literal(CAPITAL_PLAN_POLICY.pending),
        rebalance: z.literal(false),
        costs: z.literal(CAPITAL_PLAN_POLICY.costs),
      })
      .strict(),
    recordedAt: stamp,
  })
  .strict();
export type OperatingCapitalPlan = z.infer<typeof planSchema>;
/** A plan is never a NAV, cash deposit, trading order, or frozen model contract. */
export function prepareOperatingCapitalPlan(
  plannedCapitalKrw: unknown,
  recordedAt: string,
): OperatingCapitalPlan {
  const parsed = amount.safeParse(plannedCapitalKrw);
  if (!parsed.success || !stamp.safeParse(recordedAt).success) throw new Error(messages.input);
  return planSchema.parse({
    version: CAPITAL_PLAN_VERSION,
    startDate: CAPITAL_PLAN_START,
    plannedCapitalKrw: format(decimal(parsed.data)),
    currency: "KRW",
    status: "ALLOCATION_PENDING",
    allocation: null,
    actualFunding: null,
    initialHoldings: "EMPTY_NEW_SCOPE",
    journalBoundary: "NOTION_MASTER_SEPARATE_NO_AUTOMATIC_SYNC",
    integratedModel: "NOT_INITIALIZED_NO_TRADING",
    policy: { ...CAPITAL_PLAN_POLICY },
    recordedAt: new Date(recordedAt).toISOString(),
  });
}
export function readOperatingCapitalPlan(value: unknown): OperatingCapitalPlan | null {
  if (value === undefined) return null;
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) throw new Error(messages.invalid);
  return parsed.data;
}
const base = { accessToken: z.string().min(1).max(16_000) };
const change = {
  ...base,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  plannedCapitalKrw: amount,
};
const requestSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("load") }).strict(),
  z.object({ ...change, action: z.literal("preview") }).strict(),
  z.object({ ...change, action: z.literal("save"), reviewConfirmed: z.literal(true) }).strict(),
]);
export type OperatingCapitalPlanRequest = z.infer<typeof requestSchema>;
export function parseOperatingCapitalPlanRequest(value: unknown): OperatingCapitalPlanRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new Error(messages.input);
  return parsed.data;
}
