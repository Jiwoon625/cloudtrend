import { describe, expect, it } from "vitest";
import {
  calculateEtfStrategies,
  createEtfScoreEvaluator,
  ETF_MAPPING,
  ETF_POLICY,
} from "../src/lib/engine/etfStrategy";
import {
  buildEtfInstrumentChart,
  etfInstrumentChartSeries,
  etfObservedPriceChart,
} from "../src/lib/engine/etfInstrumentChart";
import { etfPartialEvidence } from "../src/lib/etfPartialEvidence";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";

import {
  createEtfChartFixture as fixture,
  addEtfChartPeers as peers,
  addEtfChartDomesticSector,
  ETF_CHART_TEST_SYMBOL as symbol,
} from "./fixtures/etf-chart-fixture";

describe("ETF historical M0 and real underlying evidence", () => {
  it("plots total M0 with the exact 62.5/7.5/15/15 policy and matches the current card", () => {
    const ds = fixture(179);
    ds.bars[symbol]!.at(-1)!.etfMarketCap = 50e9;
    const before = JSON.stringify(ds),
      snapshot = calculateEtfStrategies(ds).get(symbol)!;
    const chart = etfInstrumentChartSeries(ds, symbol, "all");
    expect(chart.chart.at(-1)!.m0Score).toBeCloseTo(
      snapshot.technical! * 0.625 +
        snapshot.priority! * 0.075 +
        snapshot.health! * 0.15 +
        snapshot.environment! * 0.15,
      12,
    );
    expect(chart.chart.at(-1)!.m0Score).not.toBe(snapshot.technical);
    const analysis = runAnalysis(ds),
      row = analysis.rows.find((value) => value.instrument.symbol === symbol)!;
    expect(chart.chart.at(-1)!.m0Score).toBe(etfPartialEvidence(row, ds.asOfDate).score);
    expect(chart).toMatchObject({
      symbol,
      asOfDate: ds.asOfDate,
      version: ETF_POLICY.version,
      previousTradingDate: ds.tradeDates.at(-2),
      underlyingSource: "KRX_ETF",
    });
    expect(JSON.stringify(ds)).toBe(before);
  });
  it("preserves complete historical dates, warmup, and read-only pre-operational observations", async () => {
    const ds = fixture();
    const all = etfInstrumentChartSeries(ds, symbol, "all"),
      recent = await buildEtfInstrumentChart(ds, symbol, "120");
    expect(all.chart).toHaveLength(180);
    expect(recent.chart).toEqual(all.chart.slice(-120));
    expect(recent.underlying).toEqual(all.underlying.slice(-120));
    expect(all.chart.slice(0, 119).every((point) => point.m0Score === null)).toBe(true);
    expect(
      all.chart.filter((point) => point.tradeDate < "2026-10-12" && point.m0Score !== null).length,
    ).toBeGreaterThan(0);
    expect(all.chart.every((point) => !("onset" in point) && !("entryState" in point))).toBe(true);
    expect(all.underlying[58]!.ma60).toBeNull();
    expect(all.underlying[59]!.ma60).toBe(129.5);
  });
  it("evaluates each peer history with its own original as-of window, including late peers", () => {
    const ds = fixture(190);
    peers(ds);
    const peerSymbols = ds.instruments.slice(1).map((value) => value.symbol);
    ds.bars[peerSymbols[0]!] = ds.bars[peerSymbols[0]!]!.slice(90);
    const evaluator = createEtfScoreEvaluator(ds, ETF_MAPPING, true);
    let peerCount = 0;
    for (const index of [60, 100, 119, 130, 155, 175, 189]) {
      const date = ds.tradeDates[index]!,
        historical = calculateEtfStrategies({ ...ds, asOfDate: date }).get(symbol)!;
      const evaluated = evaluator.at(symbol, date)!;
      expect(evaluated.score).toBe(historical.score);
      expect(evaluated.environment).toBe(historical.environment);
      expect(evaluated.environmentSource).toBe(historical.environmentSource);
      if (evaluated.environmentSource === "peer_mix_lag1") peerCount++;
    }
    expect(peerCount).toBeGreaterThan(0);
  });
  it("cannot see future prices, KRX fields, index observations or peer coverage", () => {
    const ds = fixture(170);
    peers(ds);
    const past = structuredClone(ds);
    past.asOfDate = past.tradeDates[140]!;
    const expected = etfInstrumentChartSeries(past, symbol, "all");
    for (const bars of Object.values(ds.bars))
      for (const bar of bars) {
        if (bar.tradeDate > past.asOfDate) {
          bar.close = 1e8;
          bar.etfUnderlyingIndexClose = 1;
          bar.etfMarketCap = 1;
        }
      }
    ds.asOfDate = past.asOfDate;
    expect(etfInstrumentChartSeries(ds, symbol, "all")).toEqual(expected);
  });
  it("uses the exact prior trading date, and never skips a missing session to find an older score", () => {
    const ds = fixture();
    const missingDate = ds.tradeDates.at(-2)!;
    ds.bars[symbol]!.splice(-2, 1);
    const chart = etfInstrumentChartSeries(ds, symbol, "all");
    expect(chart.previousTradingDate).toBe(missingDate);
    expect(chart.previousM0).toBeNull();
    expect(chart.chart.find((point) => point.tradeDate === missingDate)).toMatchObject({
      close: null,
      volume: null,
      m0Score: null,
    });
    expect(chart.chart.at(-1)!.m0Score).toBeNull();
    expect(chart.underlying.at(-1)!.ma60).toBeNull();
  });
  it("displays a validated prior total while today's KRX batch remains absent", () => {
    const ds = fixture(),
      expectedPrevious = calculateEtfStrategies({ ...ds, asOfDate: ds.tradeDates.at(-2)! }).get(
        symbol,
      )!.score;
    Object.assign(ds.bars[symbol]!.at(-1)!, {
      etfMarketCap: null,
      etfTradingValue: null,
      etfUnderlyingIndexClose: null,
      marketCapSource: "",
      tradingValueSource: "",
    });
    const chart = etfInstrumentChartSeries(ds, symbol, "120");
    expect(chart.chart.at(-1)!.m0Score).toBeNull();
    expect(chart.previousM0).toEqual({ date: ds.tradeDates.at(-2), score: expectedPrevious });
    expect(chart.underlying.at(-1)).toMatchObject({ close: null, ma60: null });
    expect(chart.underlyingAsOfDate).toBe(ds.tradeDates.at(-2));
    expect(chart.asOfDate).toBe(ds.asOfDate);
  });
  it.each(["price", "amount", "underlying"])("fails closed for missing %s evidence", (field) => {
    const ds = fixture();
    if (field === "price") ds.bars[symbol]!.at(-2)!.priceSource = "TOSS_RAW";
    if (field === "amount") ds.bars[symbol]!.at(-2)!.etfTradingValue = null;
    if (field === "underlying") ds.bars[symbol]!.at(-3)!.etfUnderlyingIndexClose = null;
    if (field === "mapping") ds.bars[symbol]!.at(-2)!.etfUnderlyingIndexName = "Different index";
    expect(etfInstrumentChartSeries(ds, symbol).previousM0).toBeNull();
  });
  it("does not proxy an underlying with ETF price, NAV, a latest reference, or a benchmark", () => {
    const ds = fixture();
    for (const bar of ds.bars[symbol]!) {
      bar.etfUnderlyingIndexClose = 999;
      bar.marketCapSource = "OTHER";
      bar.tradingValueSource = "OTHER";
    }
    ds.krxReviewObservations = {
      [symbol]: [
        {
          date: ds.asOfDate,
          source: "KRX_ETF",
          values: { underlyingIndexClose: 9999, underlyingIndexName: "Latest name" },
        },
      ],
    };
    const chart = etfInstrumentChartSeries(ds, symbol);
    expect(chart.underlying.every((point) => point.close === null && point.ma60 === null)).toBe(
      true,
    );
    expect(chart.underlyingAsOfDate).toBeNull();
    expect(chart.underlyingName).toBeNull();
  });
  it("breaks underlying MA60 for a missing dated observation and across actual name changes", () => {
    const ds = fixture();
    ds.bars[symbol]![90]!.etfUnderlyingIndexClose = null;
    ds.bars[symbol]!.slice(150).forEach((bar) => {
      bar.etfUnderlyingIndexName = "A new actual index";
    });
    const chart = etfInstrumentChartSeries(ds, symbol, "all");
    expect(chart.underlying[89]!.ma60).not.toBeNull();
    expect(chart.underlying[90]!.ma60).toBeNull();
    expect(chart.underlying[149]!.ma60).toBeNull();
    expect(chart.underlying[150]!.ma60).toBeNull();
    expect(chart.underlying.at(-1)!.ma60).toBeNull();
    expect(chart.underlyingName).toBe("A new actual index");
  });
  it("shows anonymous actual values without assigning today's mapped name to older rows", () => {
    const ds = fixture();
    ds.bars[symbol]!.forEach((bar) => {
      delete bar.etfUnderlyingIndexName;
    });
    const chart = etfInstrumentChartSeries(ds, symbol);
    expect(chart.underlyingName).toBeNull();
    expect(chart.underlyingSource).toBe("KRX_ETF");
    expect(chart.underlying.at(-1)!.ma60).toBeNull();
    expect(chart.issues.join(" ")).toContain("당시 지수명 미보존");
  });
  it("preserves genuinely observed zero volume but not parser fallback zero", () => {
    const ds = fixture();
    ds.bars[symbol]!.at(-1)!.volume = 0;
    ds.bars[symbol]!.at(-2)!.volumeObserved = false;
    const chart = etfInstrumentChartSeries(ds, symbol);
    expect(chart.chart.at(-1)!.volume).toBe(0);
    expect(chart.chart.at(-2)!.volume).toBeNull();
  });
  it("retains dated underlying names through the canonical source parser", () => {
    const ds = fixture();
    const rows = ds.bars[symbol]!.map((bar) => ({
      ...bar,
      symbol,
      name: "TIGER 미국S&P500",
      market: "ETF",
      type: "ETF",
      date: bar.tradeDate,
    }));
    const marketRows = ds.indexSeries[0]!.bars.map((bar) => ({
      ...bar,
      symbol: "KOSPI",
      name: "KOSPI",
      market: "INDEX",
      type: "INDEX",
      date: bar.tradeDate,
    }));
    const parsed = parseManualMarketData(JSON.stringify([...rows, ...marketRows])).dataset;
    expect(parsed.bars[symbol]!.at(-1)!.etfUnderlyingIndexName).toBe(
      ETF_MAPPING[symbol]!.underlyingIndexName,
    );
  });
  it("returns null totals for unmapped ETFs while retaining actual observed prices", () => {
    const ds = fixture();
    ds.instruments[0]!.symbol = "UNMAPPED";
    ds.bars["UNMAPPED"] = ds.bars[symbol]!;
    const chart = etfInstrumentChartSeries(ds, "UNMAPPED");
    expect(chart.chart.every((point) => point.m0Score === null)).toBe(true);
    expect(chart.chart.at(-1)!.close).not.toBeNull();
    expect(chart.previousM0).toBeNull();
  });
  it.each(["leverage", "bond", "name", "underlying-current"])(
    "matches the current card without confusing %s eligibility with total score",
    (variant) => {
      const ds = fixture();
      let target = symbol;
      if (variant === "leverage") ds.instruments[0]!.isLeveraged = true;
      if (variant === "bond") {
        target = Object.keys(ETF_MAPPING).find(
          (key) => ETF_MAPPING[key]!.assetClass === "bond_cash",
        )!;
        ds.instruments[0]!.symbol = target;
        ds.bars[target] = ds.bars[symbol]!;
      }
      if (variant === "name")
        ds.bars[symbol]!.at(-1)!.etfUnderlyingIndexName = "Different observed spelling";
      if (variant === "underlying-current") {
        peers(ds);
        ds.bars[symbol]!.at(-1)!.etfUnderlyingIndexClose = null;
      }
      const analysis = runAnalysis(ds),
        row = analysis.rows.find((value) => value.instrument.symbol === target)!;
      const chart = etfInstrumentChartSeries(ds, target);
      expect(chart.chart.at(-1)!.m0Score).toBe(etfPartialEvidence(row, ds.asOfDate).score);
    },
  );
  it("uses the same stock-sector environment for original domestic historical dates", () => {
    const ds = fixture(270),
      target = addEtfChartDomesticSector(ds);
    const evaluator = createEtfScoreEvaluator(ds, ETF_MAPPING, true);
    for (const index of [119, 180, 252, 269]) {
      const date = ds.tradeDates[index]!,
        expected = calculateEtfStrategies({ ...ds, asOfDate: date }).get(target)!;
      expect(evaluator.at(target, date)!.environment).toBe(expected.environment);
      expect(evaluator.at(target, date)!.score).toBe(expected.score);
    }
  });
  it("keeps a recent request bounded to dated peer warmup and does not score other ETFs", () => {
    const ds = fixture(1000);
    peers(ds);
    for (const instrument of ds.instruments.slice(1)) {
      const bars = ds.bars[instrument.symbol]!;
      for (let index = 0; index < bars.length; index++) {
        Object.defineProperty(bars[index]!, "etfTradingValue", {
          get() {
            throw new Error("Unrequested ETF score evaluated");
          },
        });
        if (index < 742)
          Object.defineProperty(bars[index]!, "etfUnderlyingIndexClose", {
            get() {
              throw new Error("Unrequested full peer history evaluated");
            },
          });
      }
    }
    const chart = etfInstrumentChartSeries(ds, symbol, "120");
    expect(chart.chart).toHaveLength(120);
    expect(chart.chart.at(-1)!.m0Score).not.toBeNull();
  });
  it("fails closed for duplicate current or prior observations", () => {
    for (const offset of [-1, -2]) {
      const ds = fixture();
      ds.bars[symbol]!.push({ ...ds.bars[symbol]!.at(offset)! });
      const chart = etfInstrumentChartSeries(ds, symbol);
      if (offset === -1) expect(chart.chart.at(-1)!.m0Score).toBeNull();
      else expect(chart.previousM0).toBeNull();
    }
  });
  it("keeps known, changed, and unknown underlying identities visibly discontinuous", () => {
    const ds = fixture();
    ds.bars[symbol]![174]!.etfUnderlyingIndexName = "Changed index";
    ds.bars[symbol]![175]!.etfUnderlyingIndexName = null;
    ds.bars[symbol]![176]!.etfUnderlyingIndexName = null;
    const chart = etfInstrumentChartSeries(ds, symbol, "all");
    expect(chart.underlying[174]).toMatchObject({
      identityBreak: true,
      name: "Changed index",
      ma60: null,
    });
    expect(chart.underlying[175]).toMatchObject({ identityBreak: true, name: null, ma60: null });
    expect(chart.underlying[176]).toMatchObject({ identityBreak: false, name: null, ma60: null });
    expect(chart.underlying[177]).toMatchObject({ identityBreak: true, ma60: null });
  });
});

it("price-first ETF cache retains canonical gaps and unknown volume without scoring", () => {
  const ds = fixture();
  ds.observedBars = { [symbol]: ds.bars[symbol]!.map((bar) => ({ ...bar })) };
  const missingDate = ds.tradeDates.at(-3)!;
  ds.observedBars[symbol]!.find((bar) => bar.tradeDate === missingDate)!.close = 0;
  ds.bars[symbol] = ds.bars[symbol]!.filter((bar) => bar.tradeDate !== missingDate);
  ds.observedBars[symbol]!.at(-2)!.volume = 0;
  ds.observedBars[symbol]!.at(-2)!.volumeObserved = false;
  const expected = etfInstrumentChartSeries(ds, symbol, "120").chart.map(
    ({ tradeDate, close, volume }) => ({ tradeDate, close, volume }),
  );
  // Prove the fast price phase cannot inspect score dependencies.
  Object.defineProperty(ds, "indexSeries", {
    get: () => {
      throw new Error("must not score");
    },
  });
  const prices = etfObservedPriceChart(ds, symbol, "120");
  expect(prices.chart).toEqual(expected);
  expect(prices.chart.find((point) => point.tradeDate === missingDate)?.close).toBeNull();
  expect(prices.chart.at(-2)?.volume).toBeNull();
  expect(prices.chart.at(-1)?.volume).toBeGreaterThan(0);
});
