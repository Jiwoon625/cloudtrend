import { z } from "zod";
import { ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";
import { validDate } from "./ledger/date";
import { isReviewedKrSession } from "./assistantTradeSessions";
import calendarEvidence from "./assistantActualTradeCalendarEvidence.json";
import { fromLegacyNumber, representedLegacyNumber } from "./ledger/decimal";

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
    symbol: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(100),
    market: z.enum(["KOSPI", "KOSDAQ", "US"]),
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

const localDate = (now: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export function parseAssistantActualBuy(value: unknown, now = new Date()): AssistantActualBuy {
  const data = assistantActualBuySchema.parse(value);
  const us = data.market === "US";
  if (!(us ? /^[A-Z0-9][A-Z0-9.^/-]{0,63}$/ : /^[A-Z0-9]{6}$/).test(data.symbol))
    throw new Error("시장에 맞는 종목코드를 확인하세요.");
  if (us && data.accountLabel === "ISA")
    throw new Error("미국주식 직접 거래는 ISA 계좌로 기록할 수 없습니다.");
  if (
    !validDate(data.date) ||
    data.date < ACTUAL_PERFORMANCE_START ||
    data.date > localDate(now, us ? "America/New_York" : "Asia/Seoul")
  )
    throw new Error("신규 실제 체결일은 2026-10-12부터 현지 오늘까지의 거래일이어야 합니다.");
  if (us) {
    const day = new Date(data.date + "T00:00:00Z").getUTCDay();
    if (
      data.date < calendarEvidence.coverageStart ||
      data.date > calendarEvidence.coverageEnd ||
      day === 0 ||
      day === 6 ||
      calendarEvidence.US.holidays.includes(data.date)
    )
      throw new Error("검증된 미국 거래일이 아닙니다. 미국 거래소 일정 자료를 확인하세요.");
    try {
      fromLegacyNumber(data.price);
      fromLegacyNumber(data.fee);
      representedLegacyNumber(data.price * data.shares);
    } catch {
      throw new Error("달러 단가·수수료는 안전한 범위의 소수점 8자리 이하로 입력하세요.");
    }
  } else if (!isReviewedKrSession(data.date))
    throw new Error("검증된 한국거래소 거래일이 아닙니다. KRX 일정 자료를 확인하세요.");
  if (!us && (!Number.isSafeInteger(data.shares * data.price) || data.shares * data.price <= 0))
    throw new Error("매수금액은 안전한 정수 원 단위로 입력하세요.");
  if (!us && Math.abs(Math.round(data.fee * 100) - data.fee * 100) > 0.0000001)
    throw new Error("수수료는 소수 둘째 자리 이하로 입력하세요.");
  return data;
}

/** Match the canonical journal's eight-decimal representation, including USD fills. */
export function assistantTradeGross(trade: Pick<AssistantActualBuy, "price" | "shares">) {
  return Number(representedLegacyNumber(trade.price * trade.shares));
}

export function formatAssistantTradeMoney(value: number, market: AssistantActualBuy["market"]) {
  return market === "US"
    ? "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    : value.toLocaleString("ko-KR") + "원";
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
  existing: { id: string; sourceLinks?: { url: string }[] | undefined },
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
    market: string;
  },
) {
  return (
    existing.symbol === trade.symbol &&
    existing.market === trade.market &&
    existing.date === trade.date &&
    existing.side === "BUY" &&
    existing.shares === trade.shares &&
    existing.price === trade.price &&
    existing.fee === trade.fee
  );
}
