import { z } from "zod";
import { ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";
import { validDate } from "./ledger/date";
import { isReviewedKrSession } from "./assistantTradeSessions";

/**
 * GPT only proposes an evidenced fill. Actual ledger writes require an
 * authenticated owner confirmation through the existing CAS/ledger bridge.
 * No service-role caller may directly confirm a fill.
 */
export const assistantActualBuySchema = z
  .object({
    sourcePageId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    date: z.string(),
    symbol: z.string().regex(/^[A-Z0-9]{6}$/),
    name: z.string().trim().min(1).max(100),
    market: z.enum(["KOSPI", "KOSDAQ"]),
    side: z.literal("BUY"),
    shares: z.number().int().positive().max(1_000_000),
    price: z.number().finite().positive().max(10_000_000),
    fee: z.number().finite().nonnegative().max(1_000_000),
    accountLabel: z.enum(["ISA", "GENERAL", "UNKNOWN"]).default("UNKNOWN"),
  })
  .strict();

export type AssistantActualBuy = z.infer<typeof assistantActualBuySchema>;
export type AssistantTradeProposal = {
  id: string;
  user_id: string;
  source_page_id: string;
  trade: AssistantActualBuy;
  status: "PENDING" | "PROCESSING" | "RECORDED" | "REJECTED";
  processing_token?: string | null;
  processing_started_at?: string | null;
  ledger_execution_id: string | null;
  created_at: string;
};

const kstDate = (now: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export function parseAssistantActualBuy(value: unknown, now = new Date()): AssistantActualBuy {
  const data = assistantActualBuySchema.parse(value);
  if (!validDate(data.date) || data.date < ACTUAL_PERFORMANCE_START || data.date > kstDate(now))
    throw new Error("신규 실제 체결일은 2026-10-12부터 오늘까지의 한국 거래일이어야 합니다.");
  if (!isReviewedKrSession(data.date))
    throw new Error("검증된 한국거래소 거래일이 아닙니다. KRX 일정 자료를 확인하세요.");
  if (!Number.isSafeInteger(data.shares * data.price) || data.shares * data.price <= 0)
    throw new Error("매수금액은 안전한 정수 원 단위로 입력하세요.");
  if (Math.abs(Math.round(data.fee * 100) - data.fee * 100) > 0.0000001)
    throw new Error("수수료는 소수 둘째 자리 이하로 입력하세요.");
  return data;
}

export function notionTradeUrl(sourcePageId: string) {
  return `https://app.notion.com/p/${sourcePageId.replace(/-/g, "")}`;
}

export function sameTradeEvidence(left: AssistantActualBuy, right: AssistantActualBuy) {
  return Object.keys(left).every(
    (key) => left[key as keyof AssistantActualBuy] === right[key as keyof AssistantActualBuy],
  );
}

/** Distinct evidence IDs can represent separate fills, even at identical prices. */
export function sourceEvidenceMatches(
  pageId: string,
  existing: { id: string; sourceLinks?: { url: string }[] },
  assignment?: { brokerReference: string } | null,
) {
  const expected = "notion:" + pageId.toLowerCase();
  return (
    assignment?.brokerReference?.toLowerCase() === expected ||
    existing.sourceLinks?.some((link) =>
      link.url.replace(/-/g, "").toLowerCase().includes(pageId.replace(/-/g, "").toLowerCase()),
    ) === true
  );
}

export function existingTradeMatches(
  trade: AssistantActualBuy,
  existing: {
    symbol: string;
    date: string;
    side: string;
    shares: number;
    price: number;
    fee: number;
  },
) {
  return (
    existing.symbol === trade.symbol &&
    existing.date === trade.date &&
    existing.side === "BUY" &&
    existing.shares === trade.shares &&
    existing.price === trade.price &&
    existing.fee === trade.fee
  );
}
