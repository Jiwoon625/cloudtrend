import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const SOURCE = "scripts/run-v8-priority-index-weight-portfolio-3fos.ts";
const GENERATED = "scripts/.generated-v8-15-priority-index-bull-only-3fos.ts";

const regimeHelper = String.raw`
type MarketRegime = "BULL" | "SIDEWAYS" | "BEAR";

function buildMarketRegimeMap(bars: Array<{ tradeDate: string; close: number }>) {
  const lookback = 60;
  const out = new Map<string, MarketRegime>();
  for (let i = lookback; i < bars.length; i++) {
    const cur = bars[i]!, prev = bars[i - lookback]!;
    if (!finite(cur.close) || !finite(prev.close) || prev.close <= 0) continue;
    const r = cur.close / prev.close - 1;
    out.set(cur.tradeDate, r >= 0.10 ? "BULL" : r <= -0.10 ? "BEAR" : "SIDEWAYS");
  }
  return out;
}

function effectiveIndexWeight(strategy: PriorityStrategy, signalDate: string, regimeMap: Map<string, MarketRegime>) {
  return strategy === "BULL_ONLY_0_5" && regimeMap.get(signalDate) === "BULL" ? 0.5 : 0;
}
`;

async function main() {
  const original = await readFile(SOURCE, "utf8");
  let patched = original;

  patched = patched.replace(
    'const STUDY_VERSION = "CloudTrend V8-13 Priority Index Weight Portfolio 3-FOS" as const;',
    'const STUDY_VERSION = "CloudTrend V8-15 Bull-Only Index Weight Portfolio 3-FOS" as const;'
  );
  patched = patched.replace(
    'const INDEX_WEIGHTS = [0, 0.5, 1, 2] as const;',
    'const PRIORITY_STRATEGIES = ["ZERO", "BULL_ONLY_0_5"] as const;'
  );
  patched = patched.replace(
    'type IndexWeight = (typeof INDEX_WEIGHTS)[number];',
    'type PriorityStrategy = (typeof PRIORITY_STRATEGIES)[number];'
  );
  patched = patched.replaceAll('indexWeight: IndexWeight;', 'strategy: PriorityStrategy;');
  patched = patched.replace('async function main() {', regimeHelper + '\nasync function main() {');

  patched = patched.replace(
`function priorityScore(c: Candidate, indexWeight: IndexWeight) {
  return c.basePriorityNoIndex + (c.indexMember ? indexWeight : 0);
}
function candidateSort(indexWeight: IndexWeight) {
  return (a: Candidate, b: Candidate) => {
    const pa = priorityScore(a, indexWeight), pb = priorityScore(b, indexWeight);`,
`function priorityScore(c: Candidate, strategy: PriorityStrategy, regimeMap: Map<string, MarketRegime>) {
  const indexWeight = effectiveIndexWeight(strategy, c.signalDate, regimeMap);
  return c.basePriorityNoIndex + (c.indexMember ? indexWeight : 0);
}
function candidateSort(strategy: PriorityStrategy, regimeMap: Map<string, MarketRegime>) {
  return (a: Candidate, b: Candidate) => {
    const pa = priorityScore(a, strategy, regimeMap), pb = priorityScore(b, strategy, regimeMap);`
  );

  patched = patched.replace(
`  indexWeight: IndexWeight,
  maxPositions: PositionLimit,
): Simulation {`,
`  strategy: PriorityStrategy,
  maxPositions: PositionLimit,
  regimeMap: Map<string, MarketRegime>,
): Simulation {`
  );
  patched = patched.replace('for (const list of byEntry.values()) list.sort(candidateSort(indexWeight));', 'for (const list of byEntry.values()) list.sort(candidateSort(strategy, regimeMap));');
  patched = patched.replace('priorityScore: priorityScore(c, indexWeight)', 'priorityScore: priorityScore(c, strategy, regimeMap)');
  patched = patched.replace('return { fold, indexWeight, maxPositions, points, trades: accepted, candidateSignals: candidates.length, skippedCapacity, skippedAlreadyHeld, skippedCash };', 'return { fold, strategy, maxPositions, points, trades: accepted, candidateSignals: candidates.length, skippedCapacity, skippedAlreadyHeld, skippedCash };');

  patched = patched.replace('fold: sim.fold, indexWeight: sim.indexWeight, maxPositions: sim.maxPositions,', 'fold: sim.fold, strategy: sim.strategy, maxPositions: sim.maxPositions,');

  patched = patched.replace(
`  const kosdaqReturns = benchmarkReturnMap(kosdaq.bars);
  const candidates = buildCandidates(context.series, sectorCodeBySymbol, rotationMap, membership, kosdaqReturns);`,
`  const kosdaqReturns = benchmarkReturnMap(kosdaq.bars);
  const regimeMap = buildMarketRegimeMap(kosdaq.bars);
  const candidates = buildCandidates(context.series, sectorCodeBySymbol, rotationMap, membership, kosdaqReturns);`
  );

  patched = patched.replace(
`    for (const indexWeight of INDEX_WEIGHTS) for (const maxPositions of POSITION_LIMITS) {
      const sim = simulate(fold, foldCandidates, dates, series, indexWeight, maxPositions);`,
`    for (const strategy of PRIORITY_STRATEGIES) for (const maxPositions of POSITION_LIMITS) {
      const sim = simulate(fold, foldCandidates, dates, series, strategy, maxPositions, regimeMap);`
  );

  patched = patched.replace(
`  const summary = INDEX_WEIGHTS.flatMap((indexWeight) => POSITION_LIMITS.map((maxPositions) => {
    const rows = foldMetrics.filter((r) => r.indexWeight === indexWeight && r.maxPositions === maxPositions);`,
`  const summary = PRIORITY_STRATEGIES.flatMap((strategy) => POSITION_LIMITS.map((maxPositions) => {
    const rows = foldMetrics.filter((r) => r.strategy === strategy && r.maxPositions === maxPositions);`
  );
  patched = patched.replace('      indexWeight, maxPositions, folds: rows.length,', '      strategy, maxPositions, folds: rows.length,');
  patched = patched.replace(
`  const baseline = new Map(summary.filter((r) => r.indexWeight === 0).map((r) => [r.maxPositions, r]));`,
`  const baseline = new Map(summary.filter((r) => r.strategy === "ZERO").map((r) => [r.maxPositions, r]));`
  );
  patched = patched.replaceAll('deltaMeanFoldReturnVs0', 'deltaMeanFoldReturnVsZero');
  patched = patched.replaceAll('deltaVolVs0', 'deltaVolVsZero');
  patched = patched.replaceAll('deltaWorstMddVs0', 'deltaWorstMddVsZero');
  patched = patched.replaceAll('deltaMemberShareVs0', 'deltaMemberShareVsZero');

  patched = patched.replace(
`      indexWeights: [...INDEX_WEIGHTS], positionLimits: [...POSITION_LIMITS], initialCapital: INITIAL_CAPITAL,`,
`      priorityStrategies: [...PRIORITY_STRATEGIES], positionLimits: [...POSITION_LIMITS], initialCapital: INITIAL_CAPITAL,`
  );
  patched = patched.replace(
`      priority: "indexWeight*KOSDAQ150 + size>=3,000억(+1) + benchmark excess return>=2%p(+1) + sectorRotation/100(+0~1) + SupplyRisk(0~-1)",`,
`      priority: "ZERO: no index points; BULL_ONLY_0_5: KOSDAQ150 +0.5 only when point-in-time KOSDAQ trailing 60D return >= +10%; both retain size>=3,000억(+1) + benchmark excess return>=2%p(+1) + sectorRotation/100(+0~1) + SupplyRisk(0~-1)",`
  );
  patched = patched.replace(
`      roundTripCostBps: ROUND_TRIP_COST_BPS,`,
`      roundTripCostBps: ROUND_TRIP_COST_BPS,
      marketRegime: "point-in-time KOSDAQ trailing 60-trading-day return; BULL >= +10%; dynamic +0.5 applies only to BULL signal dates",`
  );
  patched = patched.replaceAll('v8-13-priority-index-weight-portfolio-3fos', 'v8-15-priority-index-bull-only-3fos');
  patched = patched.replaceAll('V8-13 Priority Index Weight Portfolio 3-FOS', 'V8-15 Bull-Only Index Weight Portfolio 3-FOS');

  await writeFile(GENERATED, patched, "utf8");

  const args = process.argv.slice(2);
  const child = spawn(process.execPath, ["./node_modules/vite-node/vite-node.mjs", GENERATED, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  await unlink(GENERATED).catch(() => {});
  if (code !== 0) process.exit(Number(code) || 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
