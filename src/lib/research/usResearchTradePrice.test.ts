import { describe, expect, it } from "vitest";
import { decimal, format, representedLegacyNumber } from "../ledger/decimal";
import type { UsProspectiveInputRow } from "../engine/usProspective";
import {
  initializeAdoptedUsBacktest,
  replayAdoptedUsBacktest,
  type AdoptedUsBacktestSession,
} from "./adoptedUsBacktest";
import { US_LAST_VALID_CLOSE_POLICY_ID } from "./usLastValidClosePolicy";
import {
  US_RESEARCH_TRADE_PRICE_POLICY_ID,
  representedUsResearchTradePrice,
  researchPriceExceedsExactBudget,
} from "./usResearchTradePrice";

const hash = `sha256:${"d".repeat(64)}` as const;
const dates = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08"];
const rawOpen = 100.123456789,
  rawClose = 91.987654321;
const contract = (enabled = true, proxy = false) =>
  initializeAdoptedUsBacktest({
    sessions: dates,
    codeHash: hash,
    sourceManifestHash: hash,
    calendarSourceHash: hash,
    ...(enabled ? { tradePricePolicy: { policyId: US_RESEARCH_TRADE_PRICE_POLICY_ID } } : {}),
    ...(proxy
      ? {
          missingClosePolicy: {
            policyId: US_LAST_VALID_CLOSE_POLICY_ID,
            sourceCoverageEndDate: dates.at(-1)!,
            sessionClocks: dates.map((date) => ({
              date,
              openAt: `${date}T14:30:00Z`,
              closeAvailableAt: `${date}T21:15:00Z`,
            })),
          },
        }
      : {}),
  });
function session(date: string, stage: number): AdoptedUsBacktestSession {
  const rows: UsProspectiveInputRow[] = Array.from({ length: 21 }, (_, i) => ({
    date,
    symbol: `T${String(i).padStart(2, "0")}`,
    name: `Test ${i}`,
    market: "NASDAQ",
    sector: "TECH",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: i === 0 ? rawOpen : 100,
    high: 101,
    low: 90,
    close: i === 0 ? rawClose : 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: i === 0 && stage > 0 ? 30 : i,
    ret252: i === 0 && stage > 0 ? 30 : i,
    beta60Spy: i === 0 ? 30 : i,
    ichimokuTkGap: i === 0 ? 30 : i,
    relvol1_20: i,
    adv20Usd: 500_000,
    amihud20: 0.001,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: null,
  }));
  rows.push({ ...rows[0]!, symbol: "SPY", name: "SPY", isCommonShare: false, close: 100 });
  return { date, sourceHash: hash, rows, marketDataComplete: true };
}
const grossAndFee = (price: number, shares: number) => {
  const gross = decimal(representedLegacyNumber(price)) * BigInt(shares),
    scale = decimal("1");
  return { gross, fee: (gross * decimal("0.0015") + scale - 1n) / scale };
};

describe("research-only comparison price journal representation", () => {
  it("treats a provably unaffordable extreme quote as zero shares without changing the quote", async () => {
    const inputs = dates.map(session), huge = 1e30;
    inputs[2]!.rows.find((r) => r.symbol === "T00")!.open = huge;
    const original = JSON.stringify(inputs);
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    expect(JSON.stringify(inputs)).toBe(original);
    expect(runs[2]!.result.state.positions["T00"]).toBeUndefined();
    expect(runs[2]!.result.state.pendingTargets["T00"]).toBeUndefined();
    expect(runs[2]!.result.state.modelCashExact).toBe("74671.44");
    expect(runs[2]!.result.trades.filter(t => t.executionDate)).toEqual([]);
    expect(() => representedUsResearchTradePrice(huge)).toThrow("not safely representable");
    expect(researchPriceExceedsExactBudget(huge, "3733.572")).toBe(true);
    expect(researchPriceExceedsExactBudget(1e20, "100000000000000000000")).toBe(false);
    expect(researchPriceExceedsExactBudget(1e20, "100000000000000000001")).toBe(false);
    expect(researchPriceExceedsExactBudget(Infinity, "1")).toBe(false);
    expect(researchPriceExceedsExactBudget(100, "1")).toBe(false);
    await expect(replayAdoptedUsBacktest(await contract(false), inputs)).rejects.toThrow("not safely representable");
  });
  it("preserves raw observations/NAV but uses the same represented price for quantity, gross and fee", async () => {
    const inputs = dates.map(session),
      original = JSON.stringify(inputs);
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    expect(JSON.stringify(inputs)).toBe(original);
    const buy = runs[2]!.result.trades.find((t) => t.executionDate)!;
    const { gross, fee } = grossAndFee(rawOpen, 37);
    expect(buy.modelShares).toBe(37);
    expect(buy.modelPrice).toBe(100.12345679);
    expect(buy.modelNotional).toBe(Number(format(gross)));
    expect(buy.feeUsd).toBe(Number(format(fee)));
    expect(buy.detail).toMatchObject({
      source_price: rawOpen,
      accounted_price: 100.12345679,
      price_representation_policy: US_RESEARCH_TRADE_PRICE_POLICY_ID,
      source_and_valuation_prices_unchanged: true,
    });
    expect(runs[2]!.result.state.modelCashExact).toBe(format(decimal("74671.44") - gross - fee));
    expect(runs[2]!.result.state.positions["T00"]?.lastPrice).toBe(rawClose);
    expect(runs[2]!.result.nav).toBe(runs[2]!.result.cash + 37 * rawClose);
  });

  it("retains the original reference close in proxy audit and books its 8-decimal representation", async () => {
    const inputs = dates.map(session);
    inputs[3]!.rows = inputs[3]!.rows.filter((r) => r.symbol !== "T00");
    const runs = await replayAdoptedUsBacktest(await contract(true, true), inputs);
    const sell = runs[3]!.result.trades.find((t) => t.reason === US_LAST_VALID_CLOSE_POLICY_ID)!;
    const { gross, fee } = grossAndFee(rawClose, 37);
    expect(sell.modelPrice).toBe(91.98765432);
    expect(sell.modelNotional).toBe(Number(format(gross)));
    expect(sell.feeUsd).toBe(Number(format(fee)));
    expect(sell.detail).toMatchObject({
      reference_price: rawClose,
      source_price: rawClose,
      accounted_price: 91.98765432,
      recognition_at: "2020-01-07T21:15:00Z",
      cash_available_at: "2020-01-07T21:15:00Z",
    });
    expect(runs[3]!.result.state.modelCashExact).toBe(
      format(decimal(runs[2]!.result.state.modelCashExact!) + gross - fee),
    );
  });

  it("uses the representation for an ordinary SELL while leaving source close untouched", async () => {
    const inputs = dates.map(session);
    Object.assign(
      inputs[3]!.rows.find((r) => r.symbol === "T00")!,
      { ret120: -10, ret252: -10 },
    );
    inputs[4]!.rows.find((r) => r.symbol === "T00")!.open = 83.987654321;
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    const sell = runs[4]!.result.trades.find((t) => t.executionDate)!;
    expect(sell.side).toBe("SELL");
    expect(sell.modelPrice).toBe(83.98765432);
    expect(sell.detail["source_price"]).toBe(83.987654321);
  });

  it("keeps an exit pending when an extreme quote makes participation capacity zero", async () => {
    const inputs = dates.map(session);
    Object.assign(inputs[3]!.rows.find(r => r.symbol === "T00")!, { ret120: -10, ret252: -10 });
    inputs[4]!.rows.find(r => r.symbol === "T00")!.open = 1e30;
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    expect(runs[4]!.result.trades.filter(t => t.executionDate)).toEqual([]);
    expect(runs[4]!.result.state.positions["T00"]?.shares).toBe(37);
    expect(runs[4]!.result.state.pendingExits["T00"]).toBeDefined();
    expect(runs[4]!.result.state.modelCashExact).toBe(runs[3]!.result.state.modelCashExact);
  });

  it("preserves existing strict default behavior and binds a different contract", async () => {
    expect((await contract()).contractHash).not.toBe((await contract(false)).contractHash);
    await expect(
      replayAdoptedUsBacktest(await contract(false), dates.map(session)),
    ).rejects.toThrow("more than eight decimal places");
    const inputs = dates.map(session);
    for (const input of inputs)
      for (const row of input.rows) {
        row.open = 100;
        row.close = 100;
      }
    const enabled = await replayAdoptedUsBacktest(await contract(), inputs);
    const legacy = await replayAdoptedUsBacktest(await contract(false), inputs);
    for (let i = 0; i < dates.length; i++) {
      expect(enabled[i]!.result.nav).toBe(legacy[i]!.result.nav);
      expect(enabled[i]!.result.state.modelCashExact).toBe(legacy[i]!.result.state.modelCashExact);
      expect(enabled[i]!.result.state.modelFeesExact).toBe(legacy[i]!.result.state.modelFeesExact);
      expect(enabled[i]!.result.state.positions).toEqual(legacy[i]!.result.state.positions);
    }
  });

  it("fails closed when a positive source price would be represented as zero", async () => {
    expect(() => representedUsResearchTradePrice(0.000000001)).toThrow("represented as zero");
    const inputs = dates.map(session);
    inputs[2]!.rows.find((r) => r.symbol === "T00")!.open = 0.000000001;
    await expect(replayAdoptedUsBacktest(await contract(), inputs)).rejects.toThrow(
      "represented as zero",
    );
  });
});
