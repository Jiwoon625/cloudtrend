import { FULL_CAPABILITIES, type MarketDataset } from "../../src/lib/engine/dataset";
import type { DailyPrice, Instrument } from "../../src/lib/engine/types";
import { ETF_MAPPING, etfFamily } from "../../src/lib/engine/etfStrategy";

export const ETF_CHART_TEST_SYMBOL = "360750";
const symbol = ETF_CHART_TEST_SYMBOL;
export function createEtfChartFixture(count = 180): MarketDataset {
  const days: string[] = [];
  for (
    let date = new Date("2026-02-04T00:00:00Z");
    days.length < count;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6) days.push(date.toISOString().slice(0, 10));
  }
  const instrument: Instrument = {
    id: symbol,
    symbol,
    name: "TIGER 미국S&P500",
    instrumentType: "ETF",
    market: "ETF",
    sectorCode: "MARKET_IDX",
    sectorName: "시장대표",
    isPreferredStock: false,
    isManagementIssue: false,
    isInvestmentWarning: false,
    isLeveraged: false,
    isInverse: false,
    isActive: true,
    indexMemberships: [],
  };
  const bars: DailyPrice[] = days.map((tradeDate, index) => {
    const close = 100 * Math.exp(index * 0.0015 + 0.02 * Math.sin(index / 5));
    return {
      tradeDate,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: index * 10,
      volumeObserved: true,
      tradingValue: 2e9,
      marketCap: 200e9,
      foreignNetBuyValue: null,
      institutionNetBuyValue: null,
      etfMarketCap: 200e9,
      etfTradingValue: 2e9,
      etfUnderlyingIndexClose: 100 + index,
      etfUnderlyingIndexName: ETF_MAPPING[symbol]!.underlyingIndexName,
      priceSource: "TOSS_ADJUSTED_CANDLE",
      marketCapSource: "KRX_ETF",
      tradingValueSource: "KRX_ETF",
    };
  });
  return {
    provider: "TEST",
    version: "1",
    asOfDate: days.at(-1)!,
    isLive: true,
    capabilities: FULL_CAPABILITIES,
    notes: [],
    sectors: [],
    tradeDates: days,
    instruments: [instrument],
    bars: { [symbol]: bars },
    indexSeries: [
      { indexCode: "KOSPI", indexName: "KOSPI", bars: bars.map((bar) => ({ ...bar, close: 100 })) },
    ],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  };
}
export function addEtfChartPeers(ds: MarketDataset) {
  const used = new Set([etfFamily(ETF_MAPPING[symbol]!.underlyingIndexName)]);
  for (const [peerSymbol, mapping] of Object.entries(ETF_MAPPING)) {
    const family = etfFamily(mapping.underlyingIndexName);
    if (mapping.assetClass !== "equity" || mapping.region !== "US" || used.has(family)) continue;
    used.add(family);
    const n = used.size;
    ds.instruments.push({ ...ds.instruments[0]!, id: peerSymbol, symbol: peerSymbol });
    ds.bars[peerSymbol] = ds.bars[symbol]!.map((bar, i) => ({
      ...bar,
      etfUnderlyingIndexName: mapping.underlyingIndexName,
      etfUnderlyingIndexClose: 100 * Math.exp(i * 0.0007 * n + 0.025 * Math.sin(i / (n + 3))),
    }));
    if (used.size === 6) break;
  }
}

/** Add a real frozen domestic-sector mapping and stock-only sector inputs. */
export function addEtfChartDomesticSector(ds: MarketDataset, stockCount = 12) {
  const selected = Object.entries(ETF_MAPPING).find(
    ([, mapping]) =>
      mapping.rotationSource === "domestic_stock_sector" && mapping.assetClass === "equity",
  )!;
  const [domesticSymbol, mapping] = selected;
  ds.instruments.push({
    ...ds.instruments[0]!,
    id: domesticSymbol,
    symbol: domesticSymbol,
    sectorCode: mapping.sectorCode,
  });
  ds.bars[domesticSymbol] = ds.bars[symbol]!.map((bar) => ({
    ...bar,
    etfUnderlyingIndexName: mapping.underlyingIndexName,
  }));
  for (let index = 0; index < stockCount; index++) {
    const stockSymbol = `STOCK${index}`;
    const sectorCode = index % 3 === 0 ? mapping.stockSectorCode : `sector${index % 3}`;
    ds.instruments.push({
      ...ds.instruments[0]!,
      id: stockSymbol,
      symbol: stockSymbol,
      instrumentType: "STOCK",
      market: "KOSPI",
      sectorCode,
    });
    ds.bars[stockSymbol] = ds.bars[symbol]!.map((bar, dateIndex) => {
      const close = 100 * Math.exp(dateIndex * 0.0005 * ((index % 3) + 1));
      return { ...bar, close, open: close, high: close * 1.01, low: close * 0.99 };
    });
  }
  return domesticSymbol;
}
