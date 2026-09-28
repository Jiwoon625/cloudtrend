import type { MarketDataset } from "./engine/dataset";
import type { ScoringConfig } from "./engine/scoring";
import type { DataStatusPayload } from "./market.functions";
import { buildFullUniverseSectorDataset } from "./engine/sectorRotationFullUniverse";
import { runAnalysis } from "./engine/pipeline";
const SOURCE = { live: true, credentialsConfigured: true, fallbackReason: null };
export function computeDatasetDataStatus(
  raw: MarketDataset,
  config: ScoringConfig,
): DataStatusPayload {
  const dataset = buildFullUniverseSectorDataset(raw);
  const today = dataset.asOfDate;

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
      if (b.tradeDate > today) futureDates++;
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

  const stockCount = dataset.instruments.filter((i) => i.instrumentType === "STOCK").length;
  const etfCount = dataset.instruments.length - stockCount;
  const indexRecords = dataset.indexSeries.reduce((a, s) => a + s.bars.length, 0);

  return {
    source: SOURCE,
    asOfDate: dataset.asOfDate,
    dataProvider: dataset.provider,
    dataVersion: dataset.version,
    strategyVersion: runAnalysis(dataset, config).strategyVersion,
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
        count: dataset.capabilities.marketCap ? dataset.instruments.length : 0,
        entities: dataset.instruments.length,
        ok: dataset.capabilities.marketCap,
      },
      {
        provider: dataset.provider,
        kind: "투자자별 순매수",
        count: dataset.capabilities.investorFlow ? priceRecords : 0,
        entities: dataset.instruments.length,
        ok: dataset.capabilities.investorFlow,
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
    checks: { ohlcErrors, negativeVolume, duplicates, futureDates, insufficient, abnormalMoves },
    barCoverage,
  };
}
