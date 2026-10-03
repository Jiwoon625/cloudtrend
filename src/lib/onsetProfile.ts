import type { MarketDataset } from "./engine/dataset";
import { computeIndicators } from "./engine/indicators";
import {
  strictRawTechnicalScore,
  v8FinalStockScore,
  type RuleRow,
  type ScoreBlock,
  type ScoringConfig,
} from "./engine/scoring";
import type { AnalysisResult, ScreeningRow } from "./engine/pipeline";
import { computeV8SectorPriceLeadership } from "./engine/v8SectorPriceLeadership";
import { selectV8SectorPriceLeadership } from "./engine/v8SectorPriceLeadershipPolicy";

export type OnsetPathType = "A" | "B" | "C";
export type OnsetFeatureKey =
  | "cloud"
  | "TK"
  | "BB"
  | "MA"
  | "volume"
  | "nearHigh"
  | "foreign"
  | "PL";

export interface OnsetAddedFeature {
  key: OnsetFeatureKey;
  label: string;
  points: number;
  category: "structural" | "breakout";
}

export interface OnsetProfile {
  version: "v8-onset-path-v1";
  type: OnsetPathType;
  label: "구조개선형" | "복합형" | "돌파형";
  originDate: string;
  addedFeatures: OnsetAddedFeature[];
  addedPoints: number;
  ma20Extension: number | null;
}

const FEATURE_META: Record<
  OnsetFeatureKey,
  { label: string; category: OnsetAddedFeature["category"] }
> = {
  cloud: { label: "일목구름", category: "structural" },
  TK: { label: "전환선>기준선", category: "structural" },
  BB: { label: "볼린저 돌파", category: "breakout" },
  MA: { label: "MA 정배열", category: "structural" },
  volume: { label: "고가마감·거래량", category: "breakout" },
  nearHigh: { label: "52주 고점 근접", category: "structural" },
  foreign: { label: "외국인 20일 순매수", category: "structural" },
  PL: { label: "Sector PL", category: "structural" },
};

function featureKey(row: RuleRow): OnsetFeatureKey | null {
  if (row.group === "Vf Breakout") return "BB";
  if (row.group === "Vf Volume") return "volume";
  if (row.group === "Vf Momentum") return "TK";
  if (row.group === "Vf Leadership") return "nearHigh";
  if (row.group === "Vf Flow") return "foreign";
  if (row.group === "V8 Sector") return "PL";
  if (row.group === "Vf Trend" && row.rule.includes("일목")) return "cloud";
  if (row.group === "Vf Trend" && row.rule.includes("이동평균")) return "MA";
  return null;
}

function scoreMap(block: ScoreBlock): Map<OnsetFeatureKey, number> {
  const result = new Map<OnsetFeatureKey, number>();
  for (const row of block.rows) {
    const key = featureKey(row);
    if (key) result.set(key, Number.isFinite(row.points) ? row.points : 0);
  }
  return result;
}

export function buildOnsetProfile(
  previous: ScoreBlock,
  current: ScoreBlock,
  ma20Extension: number | null,
  originDate: string,
): OnsetProfile | null {
  const before = scoreMap(previous);
  const now = scoreMap(current);
  const addedFeatures = ([...now.keys()] as OnsetFeatureKey[])
    .map((key) => {
      const points = Math.round(Math.max(0, (now.get(key) ?? 0) - (before.get(key) ?? 0)) * 100) / 100;
      if (points <= 0) return null;
      return { key, label: FEATURE_META[key].label, points, category: FEATURE_META[key].category };
    })
    .filter((item): item is OnsetAddedFeature => item !== null);
  if (!addedFeatures.length) return null;

  const structural = addedFeatures.some((item) => item.category === "structural");
  const breakout = addedFeatures.some((item) => item.category === "breakout");
  const type: OnsetPathType = structural && breakout ? "B" : breakout ? "C" : "A";
  const label = type === "A" ? "구조개선형" : type === "B" ? "복합형" : "돌파형";
  return {
    version: "v8-onset-path-v1",
    type,
    label,
    originDate,
    addedFeatures,
    addedPoints: Math.round(addedFeatures.reduce((sum, item) => sum + item.points, 0) * 100) / 100,
    ma20Extension:
      ma20Extension !== null && Number.isFinite(ma20Extension) ? ma20Extension : null,
  };
}

function scoreAt(
  dataset: MarketDataset,
  row: ScreeningRow,
  date: string,
  config: ScoringConfig,
  plCache: Map<string, Map<string, number>>,
): { block: ScoreBlock; ma20Extension: number | null } | null {
  const bars = dataset.bars[row.instrument.symbol] ?? [];
  const index = bars.findIndex((bar) => bar.tradeDate === date);
  if (index < 0) return null;
  const snapshot = computeIndicators(bars, index);
  const benchmark = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  const benchmarkIndex = benchmark?.bars.findIndex((bar) => bar.tradeDate === date) ?? -1;
  if (!benchmark || benchmarkIndex < 0) return null;
  const offset = benchmark.bars.length - 1 - benchmarkIndex;
  const getPl = (source: "STOCK" | "ETF") => {
    const key = `${source}:${date}`;
    let value = plCache.get(key);
    if (!value) {
      value = computeV8SectorPriceLeadership(dataset, offset, source);
      plCache.set(key, value);
    }
    return value;
  };
  const market = row.instrument.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const selection = selectV8SectorPriceLeadership(
    market,
    row.instrument.sectorCode,
    getPl("STOCK"),
    market === "KOSPI" ? getPl("ETF") : new Map(),
  );
  return {
    block: v8FinalStockScore(snapshot, config, {
      sectorPriceLeadership: selection.value,
      sectorPriceLeadershipThreshold: selection.threshold,
    }),
    ma20Extension: snapshot.extensionFromMa20,
  };
}

function originDateFor(row: ScreeningRow): string | null {
  if (row.instrument.instrumentType !== "STOCK") return null;
  if (row.instrument.market === "KOSDAQ")
    return row.kosdaq80Onset ? row.snapshot.tradeDate : null;
  if (row.instrument.market !== "KOSPI") return null;
  if (row.kospiEntry?.originDate && row.kospiEntry.state !== "none") return row.kospiEntry.originDate;
  return row.kospi80Onset ? row.snapshot.tradeDate : null;
}

function previousDateFor(dataset: MarketDataset, row: ScreeningRow, originDate: string): string | null {
  if (row.instrument.market === "KOSPI") {
    const benchmark = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
    const dates = benchmark?.bars.map((bar) => bar.tradeDate) ?? [];
    const index = dates.indexOf(originDate);
    return index > 0 ? dates[index - 1]! : null;
  }
  const bars = dataset.bars[row.instrument.symbol] ?? [];
  const index = bars.findIndex((bar) => bar.tradeDate === originDate);
  return index > 0 ? bars[index - 1]!.tradeDate : null;
}

/**
 * Adds research-derived Onset explanation metadata after the frozen trading engine has finished.
 * It never changes scores, signals, ordering, eligibility, exits, or portfolio decisions.
 */
export function withOnsetProfiles(
  analysis: AnalysisResult,
  dataset: MarketDataset,
  config: ScoringConfig,
): AnalysisResult {
  const plCache = new Map<string, Map<string, number>>();
  return {
    ...analysis,
    rows: analysis.rows.map((row) => {
      const originDate = originDateFor(row);
      if (!originDate) return row;
      const previousDate = previousDateFor(dataset, row, originDate);
      if (!previousDate) return row;
      const current = scoreAt(dataset, row, originDate, config, plCache);
      const previous = scoreAt(dataset, row, previousDate, config, plCache);
      if (!current || !previous) return row;
      const previousScore = strictRawTechnicalScore(previous.block);
      const currentScore = strictRawTechnicalScore(current.block);
      if (
        previousScore === null ||
        currentScore === null ||
        previousScore >= 8 ||
        currentScore < 8
      )
        return row;
      const onsetProfile = buildOnsetProfile(
        previous.block,
        current.block,
        current.ma20Extension,
        originDate,
      );
      return onsetProfile ? { ...row, onsetProfile } : row;
    }),
  };
}
