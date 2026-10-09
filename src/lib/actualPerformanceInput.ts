import { z } from "zod";
import type { ReviewedPerformanceWrite } from "./actualPerformance.server";
import { validDate } from "./ledger/date";

/** The browser supplies reviewed evidence, never an owner ID or an alternative series identity. */
export type ReviewedPerformanceInput =
  | Omit<Extract<ReviewedPerformanceWrite, { action: "confirmBaseline" }>, "expectedRevision">
  | Omit<Extract<ReviewedPerformanceWrite, { action: "appendObservation" }>, "expectedRevision">;

export const MAX_REVIEWED_PERFORMANCE_BYTES = 256_000;
const invalidInputMessage =
  "입력 형식을 확인하세요. 신규 운용 범위·배정 확인, 필수 항목, 날짜, 소수점 8자리 이내의 문자열 금액, 근거 자료와 입력 크기를 확인해 주세요.";
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value === value.trim() &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
  );
const currency = z.enum(["KRW", "USD"]);
const date = z.string().length(10).refine(validDate);
const timestamp = z
  .string()
  .max(40)
  .regex(
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  )
  .refine((value) => validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)));
// Bounded exact decimals: never coerce a JSON number, exponent, NaN or Infinity to money.
const money = z
  .string()
  .max(34)
  .regex(/^-?\d{1,24}(?:\.\d{1,8})?$/);
const nonnegative = money.refine((value) => !value.startsWith("-") || /^-0(?:\.0+)?$/.test(value));
const positive = nonnegative.refine((value) => !/^-?0+(?:\.0+)?$/.test(value));
const integerQuantity = positive.refine((value) => /^\d+(?:\.0+)?$/.test(value));
const zero = money.refine((value) => /^-?0+(?:\.0+)?$/.test(value));
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const source = z
  .object({
    system: z.enum(["notion", "broker"]),
    recordId: identifier,
    revision: identifier,
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const accountScope = z.object({ accountId: identifier, currency }).strict();
const fx = z
  .object({
    base: currency,
    quote: currency,
    date,
    rate: positive,
    source: z
      .string()
      .min(1)
      .max(1_000)
      .refine((value) => value.trim().length > 0),
    verified: z.boolean(),
    availableAt: timestamp.optional(),
  })
  .strict();
const position = z
  .object({
    securityId: identifier,
    quantity: nonnegative.nullable(),
    knownQuantityDelta: money,
    costBasis: nonnegative.nullable(),
    marketValue: nonnegative.nullable(),
    priceDate: date.nullable(),
  })
  .strict();
const account = z
  .object({
    accountId: identifier,
    currency,
    cash: money.nullable(),
    knownCashDelta: money,
    unsettledCash: money.nullable(),
    positions: z.array(position).max(500),
    equity: money.nullable(),
    issues: z.array(identifier).max(50),
  })
  .strict();
const snapshot = z
  .object({
    date,
    recordedAt: timestamp,
    source,
    accounts: z.array(account).max(100),
    fx: z.array(fx).max(100),
    complete: z.boolean(),
    requiredPriceDates: z
      .object({ KRW: date.optional(), USD: date.optional() })
      .strict()
      .optional(),
    requiredFxDate: date.optional(),
  })
  .strict();
const summaryKey = identifier.refine(
  (value) => !["__proto__", "prototype", "constructor"].includes(value),
);
// A new-capital series opens with explicitly allocated cash, never inherited holdings.
const allocatedOpening = snapshot
  .extend({
    accounts: z
      .array(
        account
          .extend({
            cash: nonnegative,
            unsettledCash: zero,
            positions: z.array(position).max(0),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const baseline = z
  .object({
    scope: z.literal("POST_START_ALLOCATED_CAPITAL"),
    baseCurrency: currency,
    scopeConfirmed: z.boolean(),
    accountScope: z.array(accountScope).min(1).max(100),
    pricePolicy: z.literal("EXPLICIT_DATED_MARKS_BEFORE_START"),
    valuation: allocatedOpening,
    confirmedAt: timestamp,
    sourceRevisions: z.object({ domestic: revision, us: revision }).strict(),
    betaArchive: z
      .object({
        asOfDate: date,
        source,
        summaries: z
          .record(summaryKey, z.string().max(2_000).nullable())
          .refine((value) => Object.keys(value).length <= 50),
      })
      .strict(),
  })
  .strict();
const flow = z
  .object({
    id: identifier,
    date,
    kind: z.enum(["DEPOSIT", "WITHDRAWAL", "TRANSFER"]),
    timing: z.enum(["BEGINNING", "END", "UNKNOWN"]),
    legs: z
      .array(z.object({ accountId: identifier, currency, amount: money.nullable() }).strict())
      .min(1)
      .max(100),
    fx: z.array(fx).max(100),
    source,
  })
  .strict();
const tradeAllocation = z
  .object({
    sourceSystem: z.enum(["portfolio_ledgers", "us_actual_portfolio_ledgers"]),
    executionId: identifier,
    date,
    order: sequence,
    accountId: identifier,
    currency,
    securityId: identifier,
    side: z.enum(["BUY", "SELL"]),
    quantity: integerQuantity,
    price: positive,
    gross: positive,
    fee: nonnegative,
    source,
  })
  .strict();
const cashAdjustment = z
  .object({
    id: identifier,
    date,
    accountId: identifier,
    currency,
    amount: money,
    kind: z.enum(["DIVIDEND", "INTEREST", "FEE", "TAX"]),
    source,
  })
  .strict();
const observation = z
  .object({
    valuation: snapshot,
    previousDate: date,
    flowsComplete: z.boolean(),
    intervalComplete: z.boolean(),
    allocationConfirmed: z.literal(true),
    tradeAllocations: z.array(tradeAllocation).max(500),
    cashAdjustments: z.array(cashAdjustment).max(500),
    flows: z.array(flow).max(500),
  })
  .strict();
const reviewedInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirmBaseline"), baseline }).strict(),
  z.object({ action: z.literal("appendObservation"), observation }).strict(),
]);
const accessToken = z.string().min(1).max(16_384).regex(/^\S+$/);
const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load"), accessToken }).strict(),
  z
    .object({
      action: z.literal("preview"),
      accessToken,
      expectedRevision: revision,
      input: reviewedInput,
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      accessToken,
      expectedRevision: revision,
      input: reviewedInput,
      reviewConfirmed: z.literal(true),
    })
    .strict(),
]);
export type ActualPerformanceRequest =
  | { action: "load"; accessToken: string }
  | {
      action: "preview";
      accessToken: string;
      expectedRevision: number;
      input: ReviewedPerformanceInput;
    }
  | {
      action: "save";
      accessToken: string;
      expectedRevision: number;
      input: ReviewedPerformanceInput;
      reviewConfirmed: true;
    };

function assertBoundedJson(input: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error(invalidInputMessage);
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).length > MAX_REVIEWED_PERFORMANCE_BYTES
  )
    throw new Error(invalidInputMessage);
}
export function parseReviewedPerformanceInput(input: unknown): ReviewedPerformanceInput {
  assertBoundedJson(input);
  const result = reviewedInput.safeParse(input);
  if (!result.success) throw new Error(invalidInputMessage);
  // Zod validates each optional field; the wire format is JSON and cannot carry undefined values.
  return result.data as ReviewedPerformanceInput;
}
export function parseActualPerformanceRequest(input: unknown): ActualPerformanceRequest {
  assertBoundedJson(input);
  const result = request.safeParse(input);
  if (!result.success) throw new Error(invalidInputMessage);
  return result.data as ActualPerformanceRequest;
}

/** Never echo raw backend/validation errors, credentials, SQL, or pasted evidence to the UI. */
export function actualPerformanceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const safeLocalMessages = [
    invalidInputMessage,
    "먼저 로그인해 주세요.",
    "검토 파일은 256KB 이하로 준비해 주세요.",
    "JSON 형식을 확인해 주세요. 검토 자료를 입력한 후 미리보기를 눌러 주세요.",
    "기존 실제 원장을 먼저 대조해 주세요.",
    "원장 버전을 확인하지 못했습니다. 다시 대조해 주세요.",
    "원장 버전을 확인하지 못했습니다.",
  ];
  if (safeLocalMessages.includes(message)) return message;
  const allowed: [RegExp, string][] = [
    [
      /allocated_cash_overdrawn/,
      "관측 종료 시 현금과 미결제현금의 합계가 음수입니다. 실제 배정자금과 체결·비용을 다시 대조해 주세요.",
    ],
    [
      /Allocated opening requires nonnegative cash only/,
      "시작 기준에는 실제 배정한 현금만 입력해 주세요. 기존 보유 종목과 미결제현금은 포함할 수 없습니다.",
    ],
    [
      /Invalid post-start source execution allocation evidence/,
      "신규 운용분에 배정한 체결의 원장·체결 ID·거래일·순서·매수/매도 구분을 확인해 주세요.",
    ],
    [
      /Trade allocation account is outside the confirmed scope/,
      "매매 배정 계좌가 확정한 신규 운용 계좌 범위에 포함되는지 확인해 주세요.",
    ],
    [
      /Source execution allocation cannot be reused/,
      "같은 실제 체결을 신규 운용분에 중복 배정할 수 없습니다.",
    ],
    [
      /Invalid allocated trade quantity, price(?:, gross)? or fee/,
      "배정 수량·체결가·체결 총액·실제 비용을 확인해 주세요. 수량은 양수 정수여야 합니다.",
    ],
    [
      /Allocated sell exceeds new-slice holdings/,
      "매도 배정 수량이 신규 운용분의 보유 수량을 넘습니다. 기존 보유분으로 대신 차감할 수 없습니다.",
    ],
    [
      /Duplicate or missing cash adjustment identity/,
      "현금 조정 내역의 고유 ID가 누락되거나 중복되지 않는지 확인해 주세요.",
    ],
    [
      /Invalid dated allocated cash adjustment/,
      "현금 조정 날짜와 배당·이자·수수료·세금 구분을 확인해 주세요.",
    ],
    [
      /Cash adjustment account is outside the confirmed scope/,
      "현금 조정 계좌가 확정한 신규 운용 계좌 범위에 포함되는지 확인해 주세요.",
    ],
    [
      /Cash adjustment direction mismatch/,
      "배당·이자는 양수, 수수료·세금은 음수 금액으로 입력해 주세요.",
    ],
    [
      /Allocated actual execution is missing or ambiguous/,
      "배정한 실제 체결을 원장에서 하나로 확인하지 못했습니다. 원본 체결을 다시 대조해 주세요.",
    ],
    [
      /Allocated execution facts differ from the original post-start actual fill/,
      "배정한 매매 내역이 시작일 이후의 원본 실제 체결과 다릅니다. 최신 체결 자료를 다시 대조해 주세요.",
    ],
    [
      /Allocated execution quantity or reviewed fee exceeds or contradicts the original fill/,
      "배정 수량과 확인한 실제 비용이 원본 체결을 넘거나 다릅니다. 전체 수량을 배정하면 원본 비용과 같아야 합니다.",
    ],
    [
      /Valuation date is later than its recording cutoff|Invalid reviewed market price date or recording cutoff/,
      "평가일과 가격 기준일이 자료 기록 시점(UTC)보다 늦지 않은지 확인해 주세요.",
    ],
    [
      /Explicit pre-start market price date required for opening holdings/,
      "시작 보유 종목의 실제 마지막 거래일을 requiredPriceDates에 명시해 주세요.",
    ],
    [/로그인 세션을 확인하세요\./, "로그인 세션을 확인하세요."],
    [
      /revision changed|source revisions|changed concurrently/i,
      "원장이 변경되었습니다. 최신 자료를 다시 불러온 뒤 재검토해 주세요.",
    ],
    [
      /acknowledgement could not be verified/i,
      "저장 결과를 확인하지 못했습니다. 중복 저장하지 말고 최신 자료를 다시 불러와 주세요.",
    ],
    [
      /Reconcile the existing actual ledger/i,
      "기존 한국·미국 실제 원장을 먼저 대조하고 확정해 주세요.",
    ],
    [
      /Future reconciliation|future observed|future position|after its confirmation|future|knowledge cutoff/i,
      "미래 시점의 자료는 확정할 수 없습니다. 평가일과 자료 확인 시점을 확인해 주세요.",
    ],
    [
      /immutable|conflicting retry/i,
      "이미 확정된 기준값이나 날짜는 덮어쓸 수 없습니다. 기존 기록을 확인해 주세요.",
    ],
    [
      /Confirm the reconciled baseline|approved baseline/i,
      "먼저 검토한 시작 기준값을 확정해 주세요.",
    ],
    [
      /must append in order|stored performance chain/i,
      "관측일과 바로 앞 관측일의 연결을 확인해 주세요.",
    ],
    [
      /nothing was frozen|positive opening NAV|account scope|opening price policy|pre-start opening FX|reviewed market price|reviewed valuation FX/i,
      "배정 현금·신규 보유 수량·가격 날짜·환율·계좌 범위·입출금 누락을 대조한 뒤 다시 미리보기해 주세요. 관측 종료 시 배정 현금이 부족한 경우에도 저장할 수 없습니다.",
    ],
    [
      /Duplicate|Flow account|flow direction|Internal transfers|Invalid dated performance flow/i,
      "계좌·종목·입출금의 중복, 범위, 방향과 내부이체 균형을 확인해 주세요.",
    ],
    [/performance start|beta boundary/i, "정식 시작일과 베타 요약 기준일을 확인해 주세요."],
    [
      /Reconciled Notion or broker|Source identity|Audited source revisions/i,
      "검토한 Notion 또는 증권사 근거 자료와 원장 리비전을 확인해 주세요.",
    ],
  ];
  for (const [pattern, safeMessage] of allowed) if (pattern.test(message)) return safeMessage;
  // Preserve only our own exact safe messages when a server error crosses the client boundary.
  if (allowed.some(([, safeMessage]) => safeMessage === message)) return message;
  return "실제 성과 자료를 처리하지 못했습니다. 입력과 최신 원장을 확인한 뒤 다시 시도해 주세요.";
}
