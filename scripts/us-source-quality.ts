/** Additive transport contract; no scoring formulas or historical artifact migration. */
import type { UsProspectiveInputRow } from "../src/lib/engine/usProspective";

export const US_SOURCE_QUALITY_VERSION = "us-source-quality-v1";
export const US_SCORING_HOLD_REASON =
  "unverified_pre_event_history_and_insufficient_post_event_lookback";
export interface UsScoringHold {
  reason: typeof US_SCORING_HOLD_REASON;
  postEventBars: number;
  minimumBars: 253;
  historyStartDate: string;
}
export interface UsSourceQuality {
  version: typeof US_SOURCE_QUALITY_VERSION;
  priceCoverageComplete: boolean;
  /** Only explicit guarded-history holds; this does not claim all other rows can be ranked. */
  scoringHolds: Record<string, UsScoringHold>;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const validDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + "T00:00:00Z")) &&
  new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

export function assertUsSourceQuality(
  quality: unknown,
  sourceCoverageComplete: unknown,
  quarantinedSymbols: string[],
  date: string,
  rows?: UsProspectiveInputRow[],
): asserts quality is UsSourceQuality {
  if (
    !record(quality) ||
    !keys(quality, ["version", "priceCoverageComplete", "scoringHolds"]) ||
    quality["version"] !== US_SOURCE_QUALITY_VERSION ||
    typeof quality["priceCoverageComplete"] !== "boolean" ||
    !record(quality["scoringHolds"]) ||
    !validDate(date) ||
    typeof sourceCoverageComplete !== "boolean" ||
    new Set(quarantinedSymbols).size !== quarantinedSymbols.length ||
    quarantinedSymbols.some((s) => typeof s !== "string" || !/^[A-Z0-9.^-]+$/.test(s))
  )
    throw new Error("Invalid US source quality contract");
  const holds = quality["scoringHolds"];
  if (
    quality["priceCoverageComplete"] !== (quarantinedSymbols.length === 0) ||
    sourceCoverageComplete !== (quarantinedSymbols.length === 0 && Object.keys(holds).length === 0)
  )
    throw new Error("US source coverage contradicts explicit price/score holds");
  const bySymbol = rows && new Map(rows.map((r) => [r.symbol, r]));
  for (const [symbol, hold] of Object.entries(holds)) {
    if (
      !/^[A-Z0-9.^-]+$/.test(symbol) ||
      symbol === "SPY" ||
      quarantinedSymbols.includes(symbol) ||
      !record(hold) ||
      !keys(hold, ["reason", "postEventBars", "minimumBars", "historyStartDate"]) ||
      hold["reason"] !== US_SCORING_HOLD_REASON ||
      !Number.isSafeInteger(hold["postEventBars"]) ||
      Number(hold["postEventBars"]) <= 0 ||
      Number(hold["postEventBars"]) >= 253 ||
      hold["minimumBars"] !== 253 ||
      !validDate(hold["historyStartDate"]) ||
      hold["historyStartDate"] > date
    )
      throw new Error(`Invalid US history-length hold evidence: ${symbol}`);
    if (bySymbol) {
      const row = bySymbol.get(symbol);
      if (
        row &&
        (![row.open, row.high, row.low, row.close].every(
          (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
        ) ||
          !(
            Number(row.low) <= Math.min(Number(row.open), Number(row.close)) &&
            Math.max(Number(row.open), Number(row.close)) <= Number(row.high)
          ) ||
          typeof row.volume !== "number" ||
          !Number.isFinite(row.volume) ||
          row.volume < 0)
      )
        throw new Error(`Unsafe US scoring hold prices: ${symbol}`);
      if (
        !row ||
        row.active20 !== false ||
        !(Number(row.open) > 0) ||
        !(Number(row.close) > 0) ||
        [
          row.ret120,
          row.ret252,
          row.beta60Spy,
          row.ichimokuTkGap,
          row.relvol1_20,
          row.adv20Usd,
          row.amihud20,
        ].some((v) => v !== null)
      )
        throw new Error(`Unsafe US history-length hold: ${symbol}`);
    }
  }
}

/** Omit for legacy artifacts: adding fields on retry would rewrite immutable evidence. */
export function usSourceQualityMetadata(source: { sourceQuality?: UsSourceQuality }) {
  return source.sourceQuality ? { sourceQuality: structuredClone(source.sourceQuality) } : {};
}

/** Compact publication rows intentionally omit raw features: prove unavailable ranks/no entry. */
export function assertUsPublishedScoringHolds(
  quality: UsSourceQuality,
  rows: Array<{
    symbol: string;
    open: number | null;
    close: number | null;
    ret120: number | null;
    ret252: number | null;
    ret120Rank: number | null;
    ret252Rank: number | null;
    coreRank: number | null;
    betaRank: number | null;
    tkRank: number | null;
    relvolRank: number | null;
    liquidityRank: number | null;
    amihudRank: number | null;
    adv20Usd: number | null;
    eligibleBase?: boolean;
    onset80: boolean;
    a0Entry: boolean;
    a2Entry: boolean;
    b3Entry: boolean;
  }>,
) {
  for (const symbol of Object.keys(quality.scoringHolds)) {
    const row = rows.find((r) => r.symbol === symbol);
    if (
      !row ||
      !(Number(row.open) > 0) ||
      !(Number(row.close) > 0) ||
      row.eligibleBase !== false ||
      row.onset80 ||
      row.a0Entry ||
      row.a2Entry ||
      row.b3Entry ||
      [
        row.ret120,
        row.ret252,
        row.ret120Rank,
        row.ret252Rank,
        row.coreRank,
        row.betaRank,
        row.tkRank,
        row.relvolRank,
        row.liquidityRank,
        row.amihudRank,
        row.adv20Usd,
      ].some((v) => v !== null)
    )
      throw new Error(`Published US scoring hold became available or entry-eligible: ${symbol}`);
  }
}
