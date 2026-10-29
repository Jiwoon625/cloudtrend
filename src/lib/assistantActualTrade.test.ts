import { describe, expect, it } from "vitest";
import {
  existingTradeMatches,
  sameTradeEvidence,
  sourceEvidenceMatches,
  notionTradeUrl,
  parseAssistantActualBuy,
  parseAssistantActualTrade,
  normalizeAssistantTradeMarket,
  assistantTradeGross,
  formatAssistantTradeMoney,
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
    { date: "2028-04-12" }, // statutory National Assembly election
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
  it("accepts evidenced SELL with all commission and tax costs but keeps BUY-only legacy input strict", () => {
    const sell = {
      ...valid,
      sourcePageId: "408d908c-ac2f-8133-8dbb-e4086df779d4",
      date: "2026-10-29",
      side: "SELL",
      shares: 20,
      price: 63500,
      fee: 2627,
    };
    const approved = parseAssistantActualTrade(sell, new Date("2026-10-29T08:00:00Z"));
    expect(approved.side).toBe("SELL");
    expect(approved.shares).toBe(20);
    expect(approved.fee).toBe(2627);
    expect(assistantTradeGross(approved)).toBe(1270000);
    expect(() => parseAssistantActualBuy(sell, new Date("2026-10-29T08:00:00Z"))).toThrow();
    expect(
      existingTradeMatches(approved, {
        symbol: approved.symbol,
        market: approved.market,
        date: approved.date,
        side: "SELL",
        shares: 20,
        price: 63500,
        fee: 2627,
      }),
    ).toBe(true);
    expect(
      existingTradeMatches(approved, {
        symbol: approved.symbol,
        market: approved.market,
        date: approved.date,
        side: "BUY",
        shares: 20,
        price: 63500,
        fee: 2627,
      }),
    ).toBe(false);
    expect(() =>
      parseAssistantActualTrade({ ...sell, side: "SHORT" }, new Date("2026-10-29T08:00:00Z")),
    ).toThrow();
    expect(() =>
      parseAssistantActualTrade({ ...sell, shares: 0 }, new Date("2026-10-29T08:00:00Z")),
    ).toThrow();
    expect(() =>
      parseAssistantActualTrade({ ...sell, fee: -1 }, new Date("2026-10-29T08:00:00Z")),
    ).toThrow();
  });

  it("keeps domestic ETF execution market distinct from its KOSPI listing", () => {
    const evidence = parseAssistantActualBuy(
      {
        ...valid,
        date: "2026-10-21",
        symbol: "423160",
        name: "KODEX KOFR",
        market: "KOSPI",
        shares: 17,
        price: 110864.82352941,
        fee: 68,
      },
      new Date("2026-10-21T07:00:00Z"),
    );
    const trade = normalizeAssistantTradeMarket(evidence, { market: "KOSPI", assetType: "ETF" });
    expect(trade.market).toBe("ETF");
    expect(assistantTradeGross(trade)).toBeCloseTo(1884702, 6);
    expect(() =>
      parseAssistantActualBuy(
        { ...evidence, price: 1884702 / 17 },
        new Date("2026-10-21T07:00:00Z"),
      ),
    ).toThrow();
    expect(normalizeAssistantTradeMarket(trade, { market: "KOSPI", assetType: "ETF" })).toEqual(
      trade,
    );
    expect(() =>
      normalizeAssistantTradeMarket(
        { ...evidence, market: "KOSDAQ" },
        { market: "KOSPI", assetType: "ETF" },
      ),
    ).toThrow();
    expect(() =>
      normalizeAssistantTradeMarket(
        { ...evidence, market: "ETF" },
        { market: "KOSPI", assetType: "STOCK" },
      ),
    ).toThrow();
  });
  it("detects an indistinguishable owner-side duplicate", () => {
    expect(
      existingTradeMatches(valid as never, {
        symbol: "064290",
        date: "2026-10-19",
        side: "BUY",
        market: "KOSDAQ",
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
        market: "KOSDAQ",
        shares: 8,
        price: 60300,
        fee: 15,
      }),
    ).toBe(false);
  });
  const us = {
    ...valid,
    market: "US",
    symbol: "AAPL",
    accountLabel: "GENERAL",
    price: 123.45,
    fee: 0.012345,
  };
  it("accepts USD decimals, preserves fees and uses the journal gross representation", () => {
    const trade = parseAssistantActualBuy(us, now);
    expect(trade.fee).toBe(0.012345);
    expect(assistantTradeGross(trade)).toBe(864.15);
    expect(formatAssistantTradeMoney(trade.price, trade.market)).toBe("$123.45");
    expect(formatAssistantTradeMoney(trade.fee, trade.market)).toBe("$0.012345");
    expect(formatAssistantTradeMoney(valid.price, "KOSDAQ")).toBe("60,300원");
    expect(assistantTradeGross({ price: 0.1, shares: 3 })).toBe(0.3);
  });
  it("uses the US date when Korea has already moved to the next day", () => {
    const beforeNyMidnight = new Date("2026-10-20T02:00:00Z");
    expect(() => parseAssistantActualBuy(us, beforeNyMidnight)).not.toThrow();
    expect(() =>
      parseAssistantActualBuy({ ...us, date: "2026-10-20" }, beforeNyMidnight),
    ).toThrow();
    expect(() =>
      parseAssistantActualBuy({ ...valid, date: "2026-10-20" }, beforeNyMidnight),
    ).not.toThrow();
  });
  it.each([
    { date: "2026-10-17" },
    { date: "2026-11-26" },
    { date: "2026-12-25" },
    { symbol: "AAPL!" },
    { accountLabel: "ISA" },
    { price: 1.123456789 },
    { fee: 0.123456789 },
  ])("rejects invalid US evidence %s", (change) => {
    expect(() =>
      parseAssistantActualBuy({ ...us, ...change }, new Date("2027-01-05T20:00:00Z")),
    ).toThrow();
  });
  it("accepts reviewed 2027 sessions for both markets and rejects listed closures", () => {
    const nextYear = new Date("2027-07-20T20:00:00Z");
    expect(() => parseAssistantActualBuy({ ...us, date: "2027-01-04" }, nextYear)).not.toThrow();
    expect(() => parseAssistantActualBuy({ ...valid, date: "2027-07-20" }, nextYear)).not.toThrow();
    for (const date of ["2027-01-01", "2027-03-26", "2027-11-25", "2027-12-24"])
      expect(() => parseAssistantActualBuy({ ...us, date }, nextYear)).toThrow();
    for (const date of ["2027-05-03", "2027-07-19", "2027-09-15", "2027-12-27"])
      expect(() => parseAssistantActualBuy({ ...valid, date }, nextYear)).toThrow();
    expect(() =>
      parseAssistantActualBuy({ ...valid, date: "2028-01-03" }, new Date("2028-01-04T20:00:00Z")),
    ).not.toThrow();
    expect(() =>
      parseAssistantActualBuy({ ...us, date: "2028-01-03" }, new Date("2028-01-04T20:00:00Z")),
    ).toThrow();
  });
  it("does not confuse the same ticker and amounts across markets", () => {
    const trade = parseAssistantActualBuy({ ...us, symbol: "064290", price: 60300, fee: 15 }, now);
    expect(existingTradeMatches(trade, { ...valid, market: "KOSDAQ" })).toBe(false);
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
        market: first.market,
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

describe("exact approval notionals", () => {
  it("multiplies the eight-place unit price before number conversion", () => {
    expect(assistantTradeGross({ price: 123.45678912, shares: 1_000_000 })).toBe(123456789.12);
    expect(assistantTradeGross({ price: 0.00000001, shares: 1_000_000 })).toBe(0.01);
  });
});
