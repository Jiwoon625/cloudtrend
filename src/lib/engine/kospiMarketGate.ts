import type { KospiVolatilitySource, MarketDataset } from "./dataset";
import { computeIndicators } from "./indicators";
import { evaluateMarketGate, type MarketGate } from "./scoring";

export { buildDatedVolatilityObservations } from "./kospiVolatility";

export type KospiMarketGateStatus = "RISK_ON" | "NEUTRAL" | "RISK_OFF" | "UNKNOWN";

export interface KospiMarketGateEvidence extends Omit<MarketGate, "status"> {
  date: string;
  status: KospiMarketGateStatus;
  /** Stable, inspectable reason codes. No partial flag count is a known regime. */
  issues: string[];
  benchmarkDate: string | null;
  vkospi: number | null;
  volatilitySource: KospiVolatilitySource | null;
  marketForeignNet5d: number | null;
  marketForeignDates: string[];
}

function validDate(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function duplicateDate(dates: string[]): boolean {
  return new Set(dates).size !== dates.length;
}

function emptyEvidence(date: string): KospiMarketGateEvidence {
  return {
    date,
    status: "UNKNOWN",
    issues: [],
    benchmarkAboveMa60: null,
    benchmarkAboveCloud: null,
    vkospiBelow30: null,
    foreignNet5dPositive: null,
    metCount: 0,
    evaluatedCount: 0,
    incomplete: true,
    benchmarkDate: null,
    vkospi: null,
    volatilitySource: null,
    marketForeignNet5d: null,
    marketForeignDates: [],
  };
}

/**
 * Evaluate only evidence for this exact KOSPI trading session. The dataset calendar
 * defines sessions (including holidays); calendar-day age is not a substitute.
 * Future observations are excluded before indicators or five-session sums run.
 * Old undated volatility arrays and instrument-universe flow sums are deliberately
 * not fallbacks: neither proves this date's KOSPI market-wide evidence.
 */
export function evaluateKospiMarketGateAtDate(
  dataset: MarketDataset,
  date: string,
): KospiMarketGateEvidence {
  const evidence = emptyEvidence(date);
  const issues = evidence.issues;
  if (!validDate(date)) {
    issues.push("INVALID_EVALUATION_DATE");
    return evidence;
  }
  if (!validDate(dataset.asOfDate)) {
    issues.push("INVALID_DATASET_AS_OF_DATE");
    return evidence;
  }
  if (date > dataset.asOfDate) {
    issues.push("EVALUATION_DATE_AFTER_DATASET_AS_OF");
    return evidence;
  }

  const calendar = dataset.kospiGateDates ?? dataset.tradeDates;
  if (calendar.some((day) => !validDate(day))) {
    issues.push("INVALID_KOSPI_CALENDAR_DATE");
    return evidence;
  }
  const sessions = calendar
    .filter((day) => day <= date)
    .slice()
    .sort();
  if (duplicateDate(sessions)) {
    issues.push("AMBIGUOUS_KOSPI_CALENDAR_DATE");
    return evidence;
  }
  if (sessions.at(-1) !== date) {
    issues.push("EVALUATION_DATE_NOT_IN_KOSPI_CALENDAR");
    return evidence;
  }

  const candidates = dataset.indexSeries.filter((series) => series.indexCode === "KOSPI");
  if (candidates.length !== 1) {
    issues.push(candidates.length === 0 ? "MISSING_KOSPI_INDEX" : "AMBIGUOUS_KOSPI_INDEX");
    return evidence;
  }
  const rawBars = candidates[0]!.bars;
  if (rawBars.some((bar) => !validDate(bar.tradeDate))) {
    issues.push("INVALID_KOSPI_BAR_DATE");
    return evidence;
  }
  const bars = rawBars
    .filter((bar) => bar.tradeDate <= date)
    .slice()
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  evidence.benchmarkDate = bars.at(-1)?.tradeDate ?? null;
  if (duplicateDate(bars.map((bar) => bar.tradeDate))) {
    issues.push("AMBIGUOUS_KOSPI_BAR_DATE");
    return evidence;
  }
  if (evidence.benchmarkDate !== date) {
    issues.push(evidence.benchmarkDate ? "STALE_KOSPI_INDEX" : "MISSING_KOSPI_INDEX_DATE");
    return evidence;
  }
  // MA60 and the displayed 52-session cloud shifted by 26 need at most 78 bars.
  const expectedDates = sessions.slice(-78);
  const actualDates = bars.slice(-78).map((bar) => bar.tradeDate);
  if (
    expectedDates.length !== actualDates.length ||
    expectedDates.some((day, index) => day !== actualDates[index])
  ) {
    issues.push("KOSPI_HISTORY_CALENDAR_MISMATCH");
    return evidence;
  }

  const snapshot = computeIndicators(bars, bars.length - 1);
  const priceSourceIssues = Object.entries(dataset.kospiPriceInputIssues ?? {});
  const incompletePriceDates = priceSourceIssues.filter(
    ([day, fields]) =>
      fields.length > 0 && (!validDate(day) || (day >= expectedDates[0]! && day <= date)),
  );
  for (const [day, fields] of incompletePriceDates) {
    issues.push(`KOSPI_SOURCE_OHLC_INCOMPLETE:${day}:${fields.join(",")}`);
  }
  const invalidPriceBars = bars
    .slice(-78)
    .some(
      (bar) =>
        ![bar.open, bar.high, bar.low, bar.close].every((value) => finite(value) && value > 0) ||
        bar.high < Math.max(bar.open, bar.close) ||
        bar.low > Math.min(bar.open, bar.close),
    );
  if (invalidPriceBars) issues.push("NONFINITE_OR_INVALID_KOSPI_OHLC");
  const closeValid = finite(snapshot.close);
  if (!closeValid) issues.push("NONFINITE_KOSPI_CLOSE");
  const maBars = bars.slice(-60);
  if (maBars.length !== 60 || !maBars.every((bar) => finite(bar.close)) || !finite(snapshot.ma60)) {
    issues.push("MISSING_OR_NONFINITE_KOSPI_MA60");
    snapshot.ma60 = null;
  }
  const cloudBars = bars.slice(Math.max(0, bars.length - 78), Math.max(0, bars.length - 26));
  if (
    cloudBars.length !== 52 ||
    !cloudBars.every((bar) => finite(bar.high) && finite(bar.low)) ||
    !finite(snapshot.ichimoku.cloudTop)
  ) {
    issues.push("MISSING_OR_NONFINITE_KOSPI_CLOUD");
    snapshot.ichimoku.cloudTop = null;
  }
  // A nonfinite close must not produce false (a known failed flag).
  if (!closeValid || incompletePriceDates.length > 0 || invalidPriceBars) {
    snapshot.ma60 = null;
    snapshot.ichimoku.cloudTop = null;
  }

  const observations = dataset.vkospiObservations;
  if (!dataset.capabilities.volatilityIndex) {
    issues.push("VOLATILITY_INPUT_UNAVAILABLE");
  } else if (!observations?.length) {
    issues.push("MISSING_DATED_VOLATILITY");
  } else if (observations.some((point) => !validDate(point.date))) {
    issues.push("INVALID_VOLATILITY_DATE");
  } else {
    const matches = observations.filter((point) => point.date === date);
    if (matches.length > 1) {
      issues.push("AMBIGUOUS_VOLATILITY_DATE");
    } else if (matches.length === 0) {
      issues.push(
        observations.some((point) => point.date < date)
          ? "STALE_VOLATILITY_INPUT"
          : "MISSING_VOLATILITY_DATE",
      );
    } else {
      const observation = matches[0]!;
      const sources: KospiVolatilitySource[] = [
        "VKOSPI",
        "REALIZED_VOLATILITY_KOSPI",
        "REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30",
        "MOCK_VKOSPI",
      ];
      if (
        !sources.includes(observation.source) ||
        (dataset.isLive && observation.source === "MOCK_VKOSPI")
      ) {
        issues.push("INVALID_VOLATILITY_PROVENANCE");
      } else {
        evidence.volatilitySource = observation.source;
        if (observation.issues?.length) issues.push(...observation.issues);
        if (!finite(observation.value)) issues.push("MISSING_OR_NONFINITE_VOLATILITY");
        else if (!observation.issues?.length) evidence.vkospi = observation.value;
      }
    }
  }

  const lastFive = bars.slice(-5);
  evidence.marketForeignDates = lastFive.map((bar) => bar.tradeDate);
  if (lastFive.length !== 5) {
    issues.push("INSUFFICIENT_KOSPI_FOREIGN_FLOW_SESSIONS");
  } else if (!lastFive.every((bar) => finite(bar.foreignNetBuyValue))) {
    issues.push("MISSING_OR_NONFINITE_KOSPI_MARKET_FOREIGN_FLOW");
  } else {
    const total = lastFive.reduce((sum, bar) => sum + bar.foreignNetBuyValue!, 0);
    if (!finite(total)) issues.push("NONFINITE_KOSPI_MARKET_FOREIGN_FLOW_SUM");
    else evidence.marketForeignNet5d = total;
  }

  const gate = evaluateMarketGate({
    benchmark: snapshot,
    vkospi: evidence.vkospi,
    marketForeignNet5d: evidence.marketForeignNet5d,
  });
  return {
    ...evidence,
    ...gate,
    status: issues.length > 0 || gate.incomplete ? "UNKNOWN" : gate.status,
    incomplete: issues.length > 0 || gate.incomplete,
  };
}
