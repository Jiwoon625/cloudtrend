import type { MarketDataset } from "./engine/dataset";
import type { ScoringConfig } from "./engine/scoring";
import type { DataStatusPayload } from "./marketPayload";
import { buildFullUniverseSectorDataset } from "./engine/sectorRotationFullUniverse";
import { dataStatusStrategyVersion, dataStatusVolatility } from "./dataStatusPresentation";
const SOURCE = { live: true, credentialsConfigured: true, fallbackReason: null };
export function computeDatasetDataStatus(
  raw: MarketDataset,
  _config: ScoringConfig,
  checkedAt: Date = new Date(),
): DataStatusPayload {
  const dataset = buildFullUniverseSectorDataset(raw);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error("Invalid quality-check time");
  const today = checkedAt.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const asOfDate = dataset.asOfDate;
  let afterAsOfDates = 0;

  let ohlcErrors = 0;
  let negativeVolume = 0;
  let duplicates = 0;
  let futureDates = 0;
  let insufficient = 0;
  let abnormalMoves = 0;
  let priceRecords = 0;
  const barCoverage: DataStatusPayload["barCoverage"] = [];

  for (const inst of dataset.instruments) {
    const bars = dataset.bars[inst.symbol] ?? [];
    const observed = dataset.observedBars?.[inst.symbol] ?? bars;
    for (const bar of observed) {
      if (bar.tradeDate > today) futureDates++;
      if (bar.tradeDate > asOfDate) afterAsOfDates++;
    }
    priceRecords += bars.length;
    if (bars.length < 120) insufficient++;
    const seen = new Set<string>();
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      if (
        b.high < b.low ||
        b.high < b.open ||
        b.high < b.close ||
        b.low > b.open ||
        b.low > b.close
      )
        ohlcErrors++;
      if (b.volume < 0) negativeVolume++;
      if (seen.has(b.tradeDate)) duplicates++;
      seen.add(b.tradeDate);
      if (i > 0 && Math.abs(b.close / bars[i - 1]!.close - 1) > 0.29) abnormalMoves++;
    }
    barCoverage.push({
      symbol: inst.symbol,
      name: inst.name,
      bars: bars.length,
      first: bars[0]?.tradeDate ?? "-",
      last: bars[bars.length - 1]?.tradeDate ?? "-",
    });
  }

  for (const series of dataset.indexSeries)
    for (const bar of series.bars) {
      if (bar.tradeDate > today) futureDates++;
      if (bar.tradeDate > asOfDate) afterAsOfDates++;
    }
  // Raw VKOSPI is stored outside indexSeries; derived proxy observations already
  // share the underlying index dates and must not be counted a second time.
  for (const point of dataset.vkospiObservations ?? []) {
    if (point.source !== "VKOSPI") continue;
    if (point.date > today) futureDates++;
    if (point.date > asOfDate) afterAsOfDates++;
  }
  const currentBars = dataset.instruments.map((instrument) => ({
    instrument,
    bar: (dataset.observedBars?.[instrument.symbol] ?? dataset.bars[instrument.symbol] ?? []).find(
      (bar) => bar.tradeDate === asOfDate,
    ),
  }));
  const marketCapCount = currentBars.filter(
    ({ bar }) => bar?.marketCap != null && Number.isFinite(bar.marketCap) && bar.marketCap > 0,
  ).length;
  const investorFlowCount = currentBars.filter(
    ({ instrument, bar }) =>
      instrument.instrumentType === "STOCK" &&
      bar?.foreignNetBuyValue != null &&
      Number.isFinite(bar.foreignNetBuyValue) &&
      bar.institutionNetBuyValue != null &&
      Number.isFinite(bar.institutionNetBuyValue),
  ).length;
  const stockCount = dataset.instruments.filter((i) => i.instrumentType === "STOCK").length;
  const etfCount = dataset.instruments.length - stockCount;
  const indexRecords = dataset.indexSeries.reduce((a, s) => a + s.bars.length, 0);

  return {
    source: SOURCE,
    qualityDate: today,
    qualityTimezone: "Asia/Seoul",
    asOfDate: dataset.asOfDate,
    dataProvider: dataset.provider,
    dataVersion: dataset.version,
    strategyVersion: dataStatusStrategyVersion(dataset.asOfDate),
    volatilityObservation: dataStatusVolatility(dataset),
    isLive: dataset.isLive,
    notes: dataset.notes,
    capabilities: dataset.capabilities,
    coverage: [
      {
        provider: dataset.provider,
        kind: "종목 일봉(직접 입력)",
        count: priceRecords,
        entities: dataset.instruments.length,
        ok: priceRecords > 0,
      },
      {
        provider: dataset.provider,
        kind: "지수 일봉(직접 입력)",
        count: indexRecords,
        entities: dataset.indexSeries.length,
        ok: indexRecords > 0,
      },
      {
        provider: dataset.provider,
        kind: "시가총액",
        count: marketCapCount,
        availableEntities: marketCapCount,
        asOfDate,
        entities: dataset.instruments.length,
        ok: marketCapCount === dataset.instruments.length && marketCapCount > 0,
      },
      {
        provider: dataset.provider,
        kind: "투자자별 순매수",
        count: investorFlowCount,
        availableEntities: investorFlowCount,
        asOfDate,
        entities: stockCount,
        ok: investorFlowCount === stockCount && investorFlowCount > 0,
      },
      {
        provider: dataset.provider,
        kind: "ETF 상품 메타데이터",
        count: 0,
        entities: etfCount,
        ok: false,
      },
      {
        provider: dataset.provider,
        kind: "재무 스냅샷",
        count: 0,
        entities: stockCount,
        ok: false,
      },
    ],
    checks: {
      ohlcErrors,
      negativeVolume,
      duplicates,
      futureDates,
      afterAsOfDates,
      insufficient,
      abnormalMoves,
    },
    barCoverage,
  };
}
