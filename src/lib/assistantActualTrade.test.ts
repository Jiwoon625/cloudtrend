import { describe, expect, it } from "vitest";
import {
  existingTradeMatches,
  sameTradeEvidence,
  sourceEvidenceMatches,
  notionTradeUrl,
  parseAssistantActualBuy,
} from "./assistantActualTrade";

const now = new Date("2026-10-19T14:00:00Z");
const valid = {
  sourcePageId: "3fed908c-ac2f-817e-bf54-c58ab0cde580",
  date: "2026-10-19",
  symbol: "064290",
  name: "인텍플러스",
  market: "KOSDAQ",
  side: "BUY",
  shares: 7,
  price: 60300,
  fee: 15,
  accountLabel: "ISA",
};
describe("Assistant actual trade proposals", () => {
  it("accepts only evidenced post-start KR BUY fills and preserves leading zeros", () => {
    expect(parseAssistantActualBuy(valid, now).symbol).toBe("064290");
    expect(notionTradeUrl(valid.sourcePageId)).toBe(
      "https://app.notion.com/p/3fed908cac2f817ebf54c58ab0cde580",
    );
  });
  it.each([
    { date: "2026-10-11" },
    { date: "2026-10-20" },
    { date: "2026-02-31" },
    { date: "2026-10-17" }, // Saturday
    { date: "2026-12-25" }, // XKRX holiday
    { date: "2026-12-31" }, // KRX year-end close
    { date: "2029-01-02" }, // outside reviewed calendar
    { symbol: "64290" },
    { side: "SELL" },
    { market: "US" },
    { shares: 0 },
    { price: 0 },
    { fee: -1 },
    { accountLabel: "unexpected" },
    { unknown: true },
  ])("rejects invalid entry %s", (change) => {
    expect(() => parseAssistantActualBuy({ ...valid, ...change }, now)).toThrow();
  });
  it("detects an indistinguishable owner-side duplicate", () => {
    expect(
      existingTradeMatches(valid as never, {
        symbol: "064290",
        date: "2026-10-19",
        side: "BUY",
        shares: 7,
        price: 60300,
        fee: 15,
      }),
    ).toBe(true);
    expect(
      existingTradeMatches(valid as never, {
        symbol: "064290",
        date: "2026-10-19",
        side: "BUY",
        shares: 8,
        price: 60300,
        fee: 15,
      }),
    ).toBe(false);
  });
  it("normalizes uppercase evidence UUID before storage and comparison", () => {
    const parsed = parseAssistantActualBuy(
      {
        ...valid,
        sourcePageId: valid.sourcePageId.toUpperCase(),
      },
      now,
    );
    expect(parsed.sourcePageId).toBe(valid.sourcePageId);
  });
  it("accepts separately evidenced identical executions without weakening duplicate-source detection", () => {
    const first = parseAssistantActualBuy(valid, now);
    const second = parseAssistantActualBuy(
      {
        ...valid,
        sourcePageId: "3fed908c-ac2f-8158-b8e5-c02d17965774",
        accountLabel: "GENERAL",
      },
      now,
    );
    expect(
      existingTradeMatches(first, {
        symbol: first.symbol,
        date: first.date,
        side: first.side,
        shares: first.shares,
        price: first.price,
        fee: first.fee,
      }),
    ).toBe(true);
    expect(sameTradeEvidence(first, second)).toBe(false);
    expect(
      sourceEvidenceMatches(first.sourcePageId, {
        id: "first",
        sourceLinks: [{ url: "https://app.notion.com/p/" + first.sourcePageId.replace(/-/g, "") }],
      }),
    ).toBe(true);
    expect(
      sourceEvidenceMatches(second.sourcePageId, {
        id: "first",
        sourceLinks: [{ url: "https://app.notion.com/p/" + first.sourcePageId.replace(/-/g, "") }],
      }),
    ).toBe(false);
  });
});
