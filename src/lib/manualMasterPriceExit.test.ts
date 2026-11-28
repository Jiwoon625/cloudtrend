import { expect, it } from "vitest";
import { newMasterRow } from "./manualMaster";
import { evaluateMasterExit, applyMasterPriceExits } from "./manualMasterPriceExit";
import type { DashboardIndex, DashboardMarketSignals } from "./dashboardOperations";

const start = "2026-11-24", date = "2026-11-27";
const row = { ...newMasterRow(), symbol: "005930", name: "test", quantity: "10", averageKrw: "10000", start };
const dates = [start, "2026-11-25", "2026-11-26", date];
function index(price: number, market: "KOSPI" | "ETF" = "KOSPI"): DashboardIndex {
  return { date, tradeDates: dates, rows: [{ symbol: row.symbol, name: row.name, market, date, sector: "-", price, score: null, priority: 0, onset: false, exitReason: null }] };
}
it("K4 uses exact current won average and inclusive close boundary", () => {
  expect(evaluateMasterExit(row, start, index(9200), []).reason).toBe("K4");
  expect(evaluateMasterExit(row, start, index(9201), []).reason).toBeNull();
  expect(evaluateMasterExit({...row, averageKrw: "9000"}, start, index(9200), []).reason).toBeNull();
  expect(evaluateMasterExit(row, "2026-11-28", index(9200), []).auditStatus).toBe("PENDING");
});
it("E4 uses the complete first-entry close peak, not current average or later purchase", () => {
  const etf = {...row, assetType: "ETF", averageKrw: "20000"};
  const bars = dates.map((tradeDate, i) => ({tradeDate, close: [10000, 13000, 12500, 11700][i]!}));
  const result = evaluateMasterExit(etf, start, index(11700, "ETF"), bars);
  expect(result.reason).toBe("E4");
  expect(result.peak).toBe(13000);
  expect(evaluateMasterExit(etf, start, index(11700, "ETF"), bars.slice(1)).auditStatus).toBe("PENDING");
  expect(evaluateMasterExit(etf, start, index(11700, "ETF"), [...bars, {tradeDate:"2026-11-30",close:99999}]).auditStatus).toBe("PENDING");
});
it("deduplicates price and score exits and keeps a latched signal even if no current screening", () => {
  const exit = evaluateMasterExit(row, start, index(9200), []);
  const group: DashboardMarketSignals = {market:"KOSPI",date:null,holdingsKnown:false,onsetCount:null,exitCount:null,onsets:[],exits:[]};
  const evidence = {[row.symbol]:{...exit,auditStatus:"LATCHED" as const}};
  const out = applyMasterPriceExits([group],[row],evidence);
  expect(out[0]?.exits[0]?.reason).toContain("K4");
  expect(out[0]?.exitCount).toBe(1);
  const withScore = { ...group, exits: [{ ...out[0]!.exits[0]!, reason: "UP95" }], exitCount: 1 };
  const combined = applyMasterPriceExits([withScore], [row], evidence);
  expect(combined[0]?.exitCount).toBe(1);
  expect(combined[0]?.exits[0]?.reason).toContain("UP95");
  expect(applyMasterPriceExits([group], [{ ...row, quantity: "5", averageKrw: "8000" }], evidence)[0]?.exitCount).toBe(1);
  expect(applyMasterPriceExits([group],[{...row,quantity:"0"}],evidence)[0]?.exits).toEqual([]);
  expect(applyMasterPriceExits([group],[{...row,start:"2026-11-28"}],evidence)[0]?.exits).toEqual([]);
});
