import { describe, it, expect } from "vitest";
import {
  newMasterRow,
  validateMasterRows,
  applyMasterPaste,
  masterChanges,
  masterPositionProjection,
  parseMasterNumber,
} from "./manualMaster";
const date = "2026-11-28";
const base = {
  ...newMasterRow(),
  symbol: "005930",
  name: "Synthetic",
  quantity: "2",
  averageKrw: "1,000",
  amountKrw: "2,000",
  start: "2026-11-01",
};
const valid = (rows: unknown) => validateMasterRows(rows, date, date);
describe("manual master", () => {
  it("preserves leading zeros, normalizes won and supports US fractions", () => {
    const rows = valid([
      base,
      {
        ...base,
        symbol: "VOO",
        listing: "미국",
        currency: "USD",
        assetType: "ETF",
        quantity: "0.5",
      },
    ]);
    expect(rows[0]?.symbol).toBe("005930");
    expect(rows[0]?.averageKrw).toBe("1000");
    expect(masterPositionProjection(rows).positions[1]?.shares).toBe(0.5);
  });
  it("keeps sold records and refuses missing quantities", () => {
    const closed = { ...base, quantity: "0", averageKrw: "", amountKrw: "0", lastSell: date };
    const rows = valid([closed]);
    expect(masterPositionProjection(rows).positions).toEqual([]);
    expect(masterPositionProjection(rows).recentSells).toHaveLength(1);
    expect(masterChanges(valid([base]), rows).closed).toHaveLength(1);
    expect(() => valid([{ ...base, quantity: "" }])).toThrow();
    expect(() => valid([])).toThrow();
  });
  it("rejects conflicting identity, future dates and wrong currency", () => {
    expect(() => valid([base, { ...base, assetType: "ETF" }])).toThrow();
    expect(() => valid([{ ...base, start: "2026-11-29" }])).toThrow();
    expect(() => valid([{ ...base, currency: "USD" }])).toThrow();
    expect(() => valid([{ ...base, averageKrw: "" }])).toThrow();
    expect(() => parseMasterNumber("1,23")).toThrow();
    expect(() => parseMasterNumber("NaN")).toThrow();
  });
  it("pastes into selected cells and accepts header mapping without retaining transaction relations", () => {
    const rows = applyMasterPaste([base], "3\t1,200", 0, 5);
    expect(rows[0]?.quantity).toBe("3");
    expect(rows[0]?.averageKrw).toBe("1,200");
    const imported = applyMasterPaste(
      [],
      "종목명\t종목코드\t사람\t거래내역\t시장\t종목구분\t통화\t보유수량\nETF synthetic\t0046A0\towner\tignored\tKOSPI\tETF\tKRW\t0",
      0,
      0,
    );
    expect(masterPositionProjection(valid(imported)).positions).toHaveLength(0);
    expect(imported[0]?.symbol).toBe("0046A0");
    expect(JSON.stringify(imported)).not.toContain("ignored");
    expect(() => applyMasterPaste([], "종목코드\t종목명\tunknown\nA\tB\tC", 0, 0)).toThrow();
  });
  it("reports removed rows separately", () => {
    expect(masterChanges(valid([base]), []).removed).toHaveLength(1);
  });
});
