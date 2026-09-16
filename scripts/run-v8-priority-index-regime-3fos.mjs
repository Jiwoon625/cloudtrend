import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const SOURCE = "scripts/run-v8-priority-index-weight-portfolio-3fos.ts";
const GENERATED = "scripts/.generated-v8-14-priority-index-regime-3fos.ts";

const helperBlock = String.raw`
type MarketRegime = "BULL" | "SIDEWAYS" | "BEAR";

function buildMarketRegimeMap(bars: Array<{ tradeDate: string; close: number }>) {
  const lookback = 60;
  const out = new Map<string, MarketRegime>();
  const trailing60 = new Map<string, number>();
  for (let i = lookback; i < bars.length; i++) {
    const cur = bars[i]!, prev = bars[i - lookback]!;
    if (!finite(cur.close) || !finite(prev.close) || prev.close <= 0) continue;
    const r = cur.close / prev.close - 1;
    trailing60.set(cur.tradeDate, r * 100);
    out.set(cur.tradeDate, r >= 0.10 ? "BULL" : r <= -0.10 ? "BEAR" : "SIDEWAYS");
  }
  return { regimeMap: out, trailing60 };
}

function worstEpisodeMdd(points: EquityPoint[], regimeMap: Map<string, MarketRegime>, regime: MarketRegime) {
  let worst = 0;
  let inEpisode = false;
  let equity = 1;
  let peak = 1;
  for (const p of points) {
    if (regimeMap.get(p.date) !== regime) {
      inEpisode = false;
      equity = 1;
      peak = 1;
      continue;
    }
    if (!inEpisode) {
      inEpisode = true;
      equity = 1;
      peak = 1;
    }
    equity *= 1 + p.dailyReturn / 100;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, (equity / peak - 1) * 100);
  }
  return worst;
}

function marketRegimeMetrics(sim: Simulation, regimeMap: Map<string, MarketRegime>) {
  const regimes: MarketRegime[] = ["BULL", "SIDEWAYS", "BEAR"];
  return regimes.map((regime) => {
    const points = sim.points.filter((p) => regimeMap.get(p.date) === regime);
    const trades = sim.trades.filter((t) => regimeMap.get(t.signalDate) === regime);
    const daily = points.map((p) => p.dailyReturn / 100);
    const sd = stdev(daily);
    const down = daily.filter((r) => r < 0);
    const downsideDev = down.length ? Math.sqrt(down.reduce((s, r) => s + r * r, 0) / down.length) : null;
    const tradeReturns = trades.map((t) => t.netReturn);
    const wins = tradeReturns.filter((r) => r > 0);
    const losses = tradeReturns.filter((r) => r < 0);
    const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0));
    return {
      fold: sim.fold,
      indexWeight: sim.indexWeight,
      maxPositions: sim.maxPositions,
      regime,
      days: points.length,
      regimeContributionReturn: round(compound(daily)),
      annualizedVolatility: round(sd === null ? null : sd * Math.sqrt(252) * 100),
      downsideDeviation: round(downsideDev === null ? null : downsideDev * Math.sqrt(252) * 100),
      worstEpisodeMdd: round(worstEpisodeMdd(sim.points, regimeMap, regime)),
      worstDailyReturn: round(points.length ? Math.min(...points.map((p) => p.dailyReturn)) : null),
      avgCashWeight: round(mean(points.map((p) => p.cashWeight))),
      avgActivePositions: round(mean(points.map((p) => p.activePositions)), 2),
      trades: trades.length,
      winRate: round(trades.length ? wins.length / trades.length * 100 : null),
      avgTradeReturn: round(mean(tradeReturns)),
      medianTradeReturn: round(median(tradeReturns)),
      profitFactor: round(lossSum > 0 ? wins.reduce((a, b) => a + b, 0) / lossSum : null),
      avgMae: round(mean(trades.map((t) => t.mae))),
      avgMfe: round(mean(trades.map((t) => t.mfe))),
      indexMemberTradeShare: round(trades.length ? trades.filter((t) => t.indexMember).length / trades.length * 100 : null),
      avgPriorityScore: round(mean(trades.map((t) => t.priorityScore))),
    };
  });
}
`;

const regimeMainBlock = String.raw`
  const { regimeMap, trailing60 } = buildMarketRegimeMap(kosdaq.bars);
  const regimeMetrics = simulations.flatMap((sim) => marketRegimeMetrics(sim, regimeMap));
  const regimeDateSummary = ["BULL", "SIDEWAYS", "BEAR"].map((regime) => {
    const dates = [...regimeMap.entries()].filter(([, r]) => r === regime).map(([d]) => d);
    const foldDays = FOLD_YEARS.map((fold) => ({
      fold,
      days: dates.filter((d) => Number(d.slice(0, 4)) === fold).length,
    }));
    return { regime, days: dates.length, foldDays };
  });
`;

async function main() {
  const original = await readFile(SOURCE, "utf8");
  let patched = original;
  patched = patched.replace(
    'const STUDY_VERSION = "CloudTrend V8-13 Priority Index Weight Portfolio 3-FOS" as const;',
    'const STUDY_VERSION = "CloudTrend V8-14 Priority Index Weight Market Regime 3-FOS" as const;'
  );
  patched = patched.replace(
    'const INDEX_WEIGHTS = [0, 0.5, 1, 2] as const;',
    'const INDEX_WEIGHTS = [0, 0.5] as const;'
  );
  patched = patched.replace('async function main() {', helperBlock + '\nasync function main() {');
  patched = patched.replace('  const result = {', regimeMainBlock + '\n  const result = {');
  patched = patched.replace(
    'roundTripCostBps: ROUND_TRIP_COST_BPS,',
    'roundTripCostBps: ROUND_TRIP_COST_BPS,\n      marketRegime: "point-in-time KOSDAQ trailing 60-trading-day return: BULL >= +10%, BEAR <= -10%, otherwise SIDEWAYS",'
  );
  patched = patched.replace(
    '    foldMetrics, summary: comparison,',
    '    foldMetrics, summary: comparison, regimeDateSummary, regimeMetrics,'
  );
  patched = patched.replaceAll('v8-13-priority-index-weight-portfolio-3fos', 'v8-14-priority-index-regime-3fos');
  patched = patched.replaceAll('V8-13 Priority Index Weight Portfolio 3-FOS', 'V8-14 Priority Index Weight Market Regime 3-FOS');
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
