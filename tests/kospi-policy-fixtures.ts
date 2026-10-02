import type {
  KospiMarketGateEvidence,
  KospiMarketGateStatus,
} from "../src/lib/engine/kospiMarketGate";
import type { DailyPrice } from "../src/lib/engine/types";
export const kospiGate = (
  date: string,
  status: KospiMarketGateStatus = "RISK_ON",
): KospiMarketGateEvidence => ({
  date,
  status,
  issues: status === "UNKNOWN" ? ["MISSING_INPUT"] : [],
  benchmarkDate: date,
  benchmarkAboveMa60: true,
  benchmarkAboveCloud: true,
  vkospiBelow30: status === "RISK_ON",
  foreignNet5dPositive: status === "RISK_ON",
  metCount: status === "RISK_ON" ? 4 : status === "NEUTRAL" ? 2 : 1,
  evaluatedCount: status === "UNKNOWN" ? 3 : 4,
  incomplete: status === "UNKNOWN",
  vkospi: 15,
  volatilitySource: "VKOSPI",
  marketForeignNet5d: 10,
  marketForeignDates: [date],
});
export const kospiEntryGates = (origin = "2026-10-01", confirmation = "2026-10-02") => ({
  origin: kospiGate(origin),
  confirmation: kospiGate(confirmation),
});
export function kospiGateDataset(dates: string[]) {
  const start = new Date(`${dates[0]}T00:00:00Z`);
  const warmup: string[] = [];
  for (let i = 1; warmup.length < 120; i++) {
    const d = new Date(start.getTime() - i * 86400000);
    if (d.getUTCDay() > 0 && d.getUTCDay() < 6) warmup.unshift(d.toISOString().slice(0, 10));
  }
  const tradeDates = [...warmup, ...dates];
  const index = tradeDates.map(
    (tradeDate, i) =>
      ({
        tradeDate,
        open: 100 + i,
        close: 100 + i,
        high: 101 + i,
        low: 99 + i,
        volume: 1000,
        tradingValue: 100000,
        marketCap: null,
        foreignNetBuyValue: 10,
        institutionNetBuyValue: null,
      }) as DailyPrice,
  );
  return {
    tradeDates,
    indexSeries: [{ indexCode: "KOSPI", indexName: "코스피", bars: index }],
    capabilities: {
      marketCap: false,
      fundamentals: false,
      etfFacts: false,
      sectors: false,
      investorFlow: true,
      volatilityIndex: true,
      exactTradingValue: false,
    },
    vkospiObservations: tradeDates.map((date) => ({ date, value: 15, source: "VKOSPI" as const })),
  };
}
