import process from "node:process";

import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { computeIndicators } from "../src/lib/engine/indicators";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  DEFAULT_SCORING_CONFIG,
  mergeScoringConfig,
  strictRawTechnicalScore,
  v8FinalStockScore,
} from "../src/lib/engine/scoring";
import { computeV8SectorPriceLeadership } from "../src/lib/engine/v8SectorPriceLeadership";
import {
  KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE,
  KOSDAQ_UPSIDE_EXIT_RAW_SCORE,
  VF_DOWNSIDE_EXIT_RAW_SCORE,
  VF_ENTRY_RAW_SCORE,
  VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
  VF_UPSIDE_EXIT_RAW_SCORE,
} from "../src/lib/engine/vfConfig";
import { trustedSupabaseClient } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const userId = process.env["SUPABASE_USER_ID"];
if (!userId) throw new Error("Missing SUPABASE_USER_ID");

const client = trustedSupabaseClient();
const inputs = await loadAnalysisSourceInputs(client, userId, "screening");
const parsed = parseManualMarketData(inputs.map((input) => input.text));
const config = mergeScoringConfig(DEFAULT_SCORING_CONFIG);
const { analysis } = runFullMarketAnalysis(parsed.dataset, config);

const stockPl = computeV8SectorPriceLeadership(parsed.dataset, 0, "STOCK");
const previousStockPl = computeV8SectorPriceLeadership(parsed.dataset, 1, "STOCK");

function crossedUp(prev: number | null, cur: number | null, threshold: number) {
  return prev !== null && cur !== null && prev < threshold && cur >= threshold;
}
function crossedDown(prev: number | null, cur: number | null, threshold: number) {
  return prev !== null && cur !== null && prev > threshold && cur <= threshold;
}
function exitSignal(
  market: "KOSPI" | "KOSDAQ",
  previousScore: number | null,
  currentScore: number | null,
  onset: boolean,
) {
  if (previousScore === null || currentScore === null || onset) return null;
  const up = market === "KOSDAQ" ? KOSDAQ_UPSIDE_EXIT_RAW_SCORE : VF_UPSIDE_EXIT_RAW_SCORE;
  const down =
    market === "KOSDAQ" ? KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE : VF_DOWNSIDE_EXIT_RAW_SCORE;
  if (crossedUp(previousScore, currentScore, up)) return `UP_${up}`;
  if (crossedDown(previousScore, currentScore, down)) return `DOWN_${down}`;
  return null;
}

const rows = [];
for (const hybrid of analysis.rows) {
  if (hybrid.instrument.instrumentType !== "STOCK") continue;
  const bars = parsed.dataset.bars[hybrid.instrument.symbol] ?? [];
  if (bars.length < 2) continue;
  const currentSnap = computeIndicators(bars, bars.length - 1);
  const previousSnap = computeIndicators(bars, bars.length - 2);
  const currentPl = stockPl.get(hybrid.instrument.sectorCode) ?? null;
  const previousPl = previousStockPl.get(hybrid.instrument.sectorCode) ?? null;
  const baselineCurrent = strictRawTechnicalScore(
    v8FinalStockScore(currentSnap, config, {
      sectorPriceLeadership: currentPl,
      sectorPriceLeadershipThreshold: VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
    }),
  );
  const baselinePrevious = strictRawTechnicalScore(
    v8FinalStockScore(previousSnap, config, {
      sectorPriceLeadership: previousPl,
      sectorPriceLeadershipThreshold: VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
    }),
  );
  const hybridCurrent = hybrid.operatingScore10;
  const market = hybrid.instrument.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const baselineOnset = crossedUp(baselinePrevious, baselineCurrent, VF_ENTRY_RAW_SCORE);
  const hybridOnset =
    market === "KOSDAQ" ? hybrid.kosdaq80Onset : hybrid.kospiEightPointEntry;
  rows.push({
    symbol: hybrid.instrument.symbol,
    name: hybrid.instrument.name,
    market,
    sectorCode: hybrid.instrument.sectorCode,
    baselineCurrent,
    hybridCurrent,
    delta:
      baselineCurrent !== null && hybridCurrent !== null
        ? Math.round((hybridCurrent - baselineCurrent) * 100) / 100
        : null,
    baselineOnset,
    hybridOnset,
    baselineExit: exitSignal(market, baselinePrevious, baselineCurrent, baselineOnset),
    hybridExit: hybrid.exitSignal,
    hybridSectorPl: hybrid.sectorPriceLeadership,
  });
}

const changed = rows.filter((row) => row.delta !== null && row.delta !== 0);
const onsetChanged = rows.filter((row) => row.baselineOnset !== row.hybridOnset);
const exitChanged = rows.filter(
  (row) => String(row.baselineExit ?? "") !== String(row.hybridExit ?? "").replace("UP90", "UP_9").replace("DOWN30", "DOWN_3").replace("UP95", "UP_9.5").replace("DOWN25", "DOWN_2.5"),
);
const byMarket = Object.fromEntries(
  (["KOSPI", "KOSDAQ"] as const).map((market) => {
    const marketRows = rows.filter((row) => row.market === market);
    const marketChanged = changed.filter((row) => row.market === market);
    return [
      market,
      {
        stocks: marketRows.length,
        changedScores: marketChanged.length,
        increased: marketChanged.filter((row) => (row.delta ?? 0) > 0).length,
        decreased: marketChanged.filter((row) => (row.delta ?? 0) < 0).length,
        maxAbsDelta: marketChanged.length
          ? Math.max(...marketChanged.map((row) => Math.abs(row.delta ?? 0)))
          : 0,
        onsetChanges: onsetChanged.filter((row) => row.market === market).length,
        exitChanges: exitChanged.filter((row) => row.market === market).length,
      },
    ];
  }),
);

process.stdout.write(
  JSON.stringify(
    {
      asOfDate: analysis.asOfDate,
      sourceFiles: inputs.map((input) => input.fileName),
      policy: {
        KOSPI: "ETF PL 84, Stock PL 80 fallback",
        KOSDAQ: "Stock PL 80 unchanged",
      },
      totals: {
        stocks: rows.length,
        changedScores: changed.length,
        onsetChanges: onsetChanged.length,
        exitChanges: exitChanged.length,
      },
      byMarket,
      onsetChanged,
      exitChanged,
      changedScores: changed
        .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
        .slice(0, 100),
    },
    null,
    2,
  ) + "\n",
);
