import { z } from "zod";
import { validDate } from "./ledger/date";
import { fromLegacyNumber, representedLegacyNumber } from "./ledger/decimal";

const safeMoney = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => {
    try {
      fromLegacyNumber(value);
      return true;
    } catch {
      return false;
    }
  }, "금액은 소수점 8자리 이하로 입력하세요.");
const positiveMoney = safeMoney.refine((value) => value > 0, "0보다 큰 금액을 입력하세요.");
const date = z.string().refine(validDate, "실제 날짜를 입력하세요.");
const reference = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(
    (value) => !/https?:\/\/|[\r\n]/i.test(value),
    "거래 증빙 식별자만 입력하세요. URL·비밀정보는 넣지 마세요.",
  );
const identity = z.string().max(512);
const common = {
  accessToken: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  requestId: z.string().uuid(),
};
const asset = z.enum(["KR", "US", "ETF"]);
const currency = z.enum(["KRW", "USD"]);
const execution = z
  .object({
    id: identity,
    symbol: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(512),
    market: z.enum(["KOSPI", "KOSDAQ", "ETF", "US"]),
    side: z.enum(["BUY", "SELL"]),
    date,
    price: positiveMoney,
    shares: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fee: safeMoney,
    note: z.string().max(300),
  })
  .strict()
  .superRefine((value, ctx) => {
    const validSymbol =
      value.market === "US"
        ? /^[A-Z0-9][A-Z0-9.^/-]{0,63}$/.test(value.symbol)
        : /^[A-Z0-9]{6}$/.test(value.symbol);
    if (!validSymbol)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "시장에 맞는 종목코드를 확인하세요." });
    try {
      representedLegacyNumber(value.price * value.shares);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "거래금액이 안전한 범위를 초과합니다.",
      });
    }
  });
const allocation = z
  .object({
    quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    gross: positiveMoney,
    fee: safeMoney,
    brokerReference: reference,
  })
  .strict();
const event = z
  .object({
    id: identity,
    date,
    kind: z.enum(["DEPOSIT", "WITHDRAWAL", "DIVIDEND", "INTEREST", "FEE", "TAX"]),
    amount: positiveMoney,
    reference,
  })
  .strict();
export const newActualPortfolioRequestSchema = z.discriminatedUnion("action", [
  z.object({ accessToken: common.accessToken, action: z.literal("load") }).strict(),
  z
    .object({
      ...common,
      action: z.literal("execution"),
      asset,
      execution,
      allocation,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("cancelExecution"),
      asset,
      executionId: identity.min(1),
      reason: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({ ...common, action: z.literal("cash"), currency, event, confirmed: z.literal(true) })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("cancelCash"),
      currency,
      eventId: identity.min(1),
      reason: z.string().trim().min(1).max(300),
    })
    .strict(),
]);
export type NewActualPortfolioRequest = z.infer<typeof newActualPortfolioRequestSchema>;
export type NewActualPortfolioWrite = Exclude<NewActualPortfolioRequest, { action: "load" }>;
export function parseNewActualPortfolioRequest(input: unknown): NewActualPortfolioRequest {
  return newActualPortfolioRequestSchema.parse(input);
}
