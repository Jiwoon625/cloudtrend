import { describe, expect, it } from "vitest";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { calculateEtfStrategies } from "../src/lib/engine/etfStrategy";
import {
  createEtfChartFixture,
  ETF_CHART_TEST_SYMBOL as symbol,
} from "./fixtures/etf-chart-fixture";

const day = "2026-11-09";
const row = (fields: Record<string, unknown> = {}) => ({
  symbol,
  type: "ETF",
  market: "ETF",
  date: day,
  close: 100,
  volume: 100,
  tradingValue: 123456789,
  tradingValueSource: "KRX_ETF",
  etfTradingValue: "",
  ...fields,
});
const withCalendar = (rows: Record<string, unknown>[]) =>
  rows.some((r) => r.symbol === "KOSPI")
    ? rows
    : [...rows, { symbol: "KOSPI", type: "INDEX", market: "INDEX", date: day, close: 100 }];
const parse = (rows: Record<string, unknown>[]) =>
  parseManualMarketDataWithReferences(JSON.stringify(withCalendar(rows)), {
    allowIncompleteIndex: true,
  }).dataset;
const bar = (rows: Record<string, unknown>[]) => parse(rows).bars[symbol]!.at(-1)!;

describe("verified ETF turnover input adapter", () => {
  it("bridges the same-row KRW amount without changing the frozen replay parser", () => {
    const input = JSON.stringify(withCalendar([row()]));
    const frozen = parseManualMarketData(input, { allowIncompleteIndex: true }).dataset;
    const adapted = parse([row()]);
    expect(frozen.bars[symbol]![0]!.etfTradingValue).toBeNull();
    expect(adapted.bars[symbol]![0]).toEqual({
      ...frozen.bars[symbol]![0],
      etfTradingValue: 123456789,
    });
    expect(adapted.krxReviewObservations![symbol]![0]!.values.tradingValue).toBe(123456789);
  });
  it.each([0, 1, 123456789, "1,234,567"])("preserves valid amount %s exactly", (value) => {
    expect(bar([row({ tradingValue: value })]).etfTradingValue).toBe(
      Number(String(value).replaceAll(",", "")),
    );
  });
  it.each([null, "", -1, "NaN", "Infinity", "bad"])(
    "does not bridge unusable canonical amount %s",
    (value) => {
      expect(bar([row({ tradingValue: value })]).etfTradingValue).toBeNull();
    },
  );
  it.each(["", "KRX_STOCK", "CLOSE_X_VOLUME_PROXY", "OTHER"])(
    "does not upgrade provenance %s",
    (source) => {
      expect(bar([row({ tradingValueSource: source })]).etfTradingValue).toBeNull();
    },
  );
  it.each([0, 77, -1, "bad", "Infinity", "NaN"])("preserves explicit ETF field %s", (dedicated) => {
    const input = JSON.stringify([row({ etfTradingValue: dedicated })]);
    expect(bar([row({ etfTradingValue: dedicated })]).etfTradingValue).toEqual(
      parseManualMarketData(input, { allowIncompleteIndex: true }).dataset.bars[symbol]![0]!
        .etfTradingValue,
    );
  });
  it("does not join an amount and provenance from separate duplicate rows", () => {
    expect(
      bar([row({ tradingValueSource: "" }), row({ tradingValue: "" })]).etfTradingValue,
    ).toBeNull();
    expect(bar([row(), row({ tradingValue: "" })]).etfTradingValue).toBeNull();
    expect(
      bar([row(), row({ tradingValue: 456, tradingValueSource: "" })]).etfTradingValue,
    ).toBeNull();
  });
  it("does not borrow from another day or overwrite a dedicated prior-source value", () => {
    const data = parse([row({ date: "2026-11-06" }), row({ tradingValue: "" })]);
    expect(data.bars[symbol]![0]!.etfTradingValue).toBe(123456789);
    expect(data.bars[symbol]![1]!.etfTradingValue).toBeNull();
    expect(bar([row({ etfTradingValue: 55 }), row()]).etfTradingValue).toBe(55);
  });
  it("rejects negative-close rows, non-ETF duplicates and another symbol", () => {
    expect(bar([row({ tradingValue: "" }), row({ close: -1 })]).etfTradingValue).toBeNull();
    expect(
      bar([row({ tradingValue: "" }), row({ type: "STOCK", market: "KOSPI" })]).etfTradingValue,
    ).toBeNull();
    expect(bar([row({ tradingValue: "" }), row({ symbol: "069500" })]).etfTradingValue).toBeNull();
  });
  it("matches CSV last-column and JSON canonical-first aliases", () => {
    const csv =
      "symbol,market,type,date,close,tradingValue,amount,tradingValueSource,etfTradingValue\n" +
      `${symbol},ETF,ETF,${day},100,123,456,KRX_ETF,\nKOSPI,INDEX,INDEX,${day},100,0,0,,`;
    const parsed = parseManualMarketDataWithReferences(csv, { allowIncompleteIndex: true });
    expect(parsed.dataset.bars[symbol]![0]!.etfTradingValue).toBe(456);
    expect(bar([row({ amount: 456 })]).etfTradingValue).toBe(123456789);
  });
  it("leaves STOCK and INDEX inputs unchanged", () => {
    const rows = [
      row({ type: "STOCK", market: "KOSPI" }),
      row({ symbol: "KOSPI", type: "INDEX", market: "INDEX" }),
    ];
    const adapted = parse(rows);
    const frozen = parseManualMarketData(JSON.stringify(rows), {
      allowIncompleteIndex: true,
    }).dataset;
    expect(adapted.bars).toEqual(frozen.bars);
    expect(adapted.indexSeries).toEqual(frozen.indexSeries);
  });
});

function scoreRows() {
  const ds = createEtfChartFixture();
  return [
    ...ds.bars[symbol]!.map((b) => row({ ...b, date: b.tradeDate, etfTradingValue: "" })),
    ...ds.indexSeries[0]!.bars.map((b) => ({
      ...b,
      date: b.tradeDate,
      symbol: "KOSPI",
      type: "INDEX",
      market: "INDEX",
    })),
  ];
}
const score = (rows: Record<string, unknown>[]) => calculateEtfStrategies(parse(rows)).get(symbol)!;

describe("ETF strategy gates after the input repair", () => {
  it("restores a complete 20-session amount window and the same score as explicit values", () => {
    const rows = scoreRows();
    const actual = score(rows);
    const explicit = rows.map((r) =>
      r.type === "ETF" ? { ...r, etfTradingValue: r.tradingValue } : r,
    );
    expect(actual).toEqual(score(explicit));
    expect(actual.dataStatus).toBe("ready");
    expect(actual.averageTradingValue20).toBe(2e9);
  });
  it.each(["missing", "proxy", "date", "cap"])(
    "keeps incomplete %s evidence unconfirmed",
    (failure) => {
      const rows = scoreRows();
      const index = failure === "cap" ? 179 : 170;
      if (failure === "missing") rows[index]!.tradingValue = "";
      if (failure === "proxy") rows[index]!.tradingValueSource = "CLOSE_X_VOLUME_PROXY";
      if (failure === "date") rows.splice(index, 1);
      if (failure === "cap") Object.assign(rows[index]!, { etfMarketCap: null });
      expect(score(rows).dataStatus).not.toBe("ready");
      expect(score(rows).issues).toContain("KRX 시총·20일 거래대금 필요");
    },
  );
});
