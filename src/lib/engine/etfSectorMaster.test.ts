import { describe, expect, it } from "vitest";
import { resolveSectorCode } from "./sectors";
import { parseManualMarketData } from "./manualDataset";
import { validateSourceText } from "../sourceData";

const cases = [
  ["0183J0", "TIGER 미국우주테크", "SHIP_DEF"],
  ["102780", "KODEX 삼성그룹", "MARKET_IDX"],
  ["278530", "KODEX 200TR", "MARKET_IDX"],
  ["294400", "KIWOOM 200TR", "MARKET_IDX"],
  ["315930", "KODEX Top5PlusTR", "MARKET_IDX"],
  ["465580", "ACE 미국빅테크TOP7 Plus", "MARKET_IDX"],
  ["483320", "ACE 엔비디아밸류체인액티브", "SEMI"],
  ["487240", "KODEX AI전력핵심설비", "ENERGY"],
];
const csv = ["symbol,name,type,market,date,open,high,low,close,volume,tradingValue,sector",
  ...cases.map(([symbol, name]) => `${symbol},${name},ETF,ETF,2026-09-11,100,110,90,100,1000,100000,ETC`),
].join("\n");
describe("curated ETF sectors", () => {
  it("resolves historical names and normalized codes without affecting stocks or other ETFs", () => {
    for (const [symbol, name, code] of cases) {
      expect(resolveSectorCode(symbol!, name!, true).code).toBe(code);
      expect(resolveSectorCode(`A${symbol}`, "old name", true).code).toBe(code);
    }
    expect(resolveSectorCode("487240", "unknown", false).code).toBe("ETC");
    expect(resolveSectorCode("069500", "KODEX 200", true).code).toBe("MARKET_IDX");
  });
  it("replaces stored ETC in the backtest parser", () => {
    const { dataset } = parseManualMarketData(csv + "\n" + Array.from({ length: 60 }, (_, n) => {
      const date = new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
      return `KOSPI,KOSPI,INDEX,INDEX,${date},100,110,90,100,1000,100000,MARKET_IDX`;
    }).join("\n"));
    expect(dataset!.instruments.map(i => i.sectorCode)).toEqual(cases.map(c => c[2]));
  });
  it("uses the same mapping during source validation", async () => {
    const result = await validateSourceText(csv);
    expect(result.stats.sectorUnmappedCount).toBe(0);
    expect(result.stats.sectorMappedCount).toBe(8);
  });
});
