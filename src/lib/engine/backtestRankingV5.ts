import { computeIndicators } from "./indicators";
import { evaluateFeatures, type BacktestParams } from "./backtest";
import {
  BACKTEST_FEATURES,
  RANKING_HORIZON,
  RANKING_QUANTILE_BUCKETS,
  TOP_SELECTION_COUNT,
  type BacktestInputSeries,
  type BacktestMarket,
  type BacktestMarketContext,
  type QuantileSpreadStat,
  type RankIcDateStat,
  type RankIcSummary,
  type TopSelectionDateStat,
  type TopSelectionSummary,
} from "./backtestV4";

interface RankingObservation {
  symbol: string;
  market: BacktestMarket;
  date: string;
  score: number;
  ret: number;
  benchmarkRet: number | null;
  excessRet: number | null;
}

export interface AlignedRankingResult {
  rankIcByDate: RankIcDateStat[];
  rankIcSummary: RankIcSummary;
  topSelection: TopSelectionSummary;
  quantileSpreads: QuantileSpreadStat[];
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const winRate = (xs: number[]): number | null =>
  xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null;

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  if (mx === null || my === null) return null;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

function averageRanks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end++;
    const avgRank = (start + end + 2) / 2;
    for (let i = start; i <= end; i++) ranks[order[i]!.index] = avgRank;
    start = end + 1;
  }
  return ranks;
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

function hacMeanStats(xs: number[], lag: number): {
  mean: number | null;
  t: number | null;
  low: number | null;
  high: number | null;
} {
  const m = mean(xs);
  if (m === null || xs.length < 3) return { mean: m, t: null, low: null, high: null };
  const n = xs.length;
  const centered = xs.map((x) => x - m);
  let longRun = centered.reduce((a, x) => a + x * x, 0) / n;
  const maxLag = Math.min(Math.max(0, lag), n - 1);
  for (let l = 1; l <= maxLag; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += centered[t]! * centered[t - l]!;
    gamma /= n;
    const weight = 1 - l / (maxLag + 1);
    longRun += 2 * weight * gamma;
  }
  const se = Math.sqrt(Math.max(0, longRun) / n);
  if (!(se > 0)) return { mean: m, t: null, low: m, high: m };
  return { mean: m, t: m / se, low: m - 1.96 * se, high: m + 1.96 * se };
}

function emptyResult(): AlignedRankingResult {
  return {
    rankIcByDate: [],
    rankIcSummary: {
      horizon: RANKING_HORIZON,
      dates: 0,
      avgRawRankIc: null,
      medianRawRankIc: null,
      rawPositiveRate: null,
      avgMarketAdjustedRankIc: null,
      medianMarketAdjustedRankIc: null,
      marketAdjustedPositiveRate: null,
    },
    topSelection: {
      horizon: RANKING_HORIZON,
      topN: TOP_SELECTION_COUNT,
      dates: 0,
      avgReturn: null,
      medianReturn: null,
      winRate: null,
      marketAdjustedAvgReturn: null,
      dateReturns: [],
    },
    quantileSpreads: RANKING_QUANTILE_BUCKETS.map((bucketCount) => ({
      horizon: RANKING_HORIZON,
      bucketCount,
      dates: 0,
      topAvgReturn: null,
      bottomAvgReturn: null,
      rawSpread: null,
      topMarketAdjustedAvgReturn: null,
      bottomMarketAdjustedAvgReturn: null,
      marketAdjustedSpread: null,
      robustTStat: null,
      ci95Low: null,
      ci95High: null,
    })),
  };
}

/**
 * V5 ranking 전용 계산.
 * 종목별 i=120에서 따로 시작하는 5일 grid를 그대로 합치면 관측일이 어긋나므로,
 * KOSPI 거래일을 공통 anchor로 사용해 모든 종목을 동일한 날짜에서만 비교한다.
 */
export function buildAlignedRankingAnalysis(
  series: BacktestInputSeries[],
  params: BacktestParams,
  marketContext?: BacktestMarketContext,
): AlignedRankingResult {
  const kospi = marketContext?.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSPI");
  if (!kospi?.bars.length) return emptyResult();

  const sampleEvery = Math.max(1, Math.min(20, Math.round(params.sampleEvery)));
  const active = BACKTEST_FEATURES.filter((f) => params.features.includes(f.id));
  if (!active.length) return emptyResult();

  const marketIndex = new Map<BacktestMarket, Map<string, number>>();
  for (const market of ["KOSPI", "KOSDAQ"] as BacktestMarket[]) {
    const idx =
      marketContext?.indexSeries.find((s) => s.indexCode.toUpperCase() === market) ?? kospi;
    marketIndex.set(market, new Map(idx.bars.map((b) => [b.tradeDate, b.close])));
  }

  const commonDates = new Set<string>();
  for (let i = 120; i + RANKING_HORIZON < kospi.bars.length; i += sampleEvery)
    commonDates.add(kospi.bars[i]!.tradeDate);

  const byDate = new Map<string, RankingObservation[]>();
  for (const s of series) {
    const bars = s.bars;
    if (bars.length < 252 + RANKING_HORIZON) continue;
    const market: BacktestMarket = s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
    const benchmark = marketIndex.get(market)!;

    for (let i = 251; i + RANKING_HORIZON < bars.length; i++) {
      const bar = bars[i]!;
      if (!commonDates.has(bar.tradeDate) || !(bar.close > 0)) continue;

      const snap = computeIndicators(bars, i);
      const flags = evaluateFeatures(snap, params, bar);
      // Score ranking은 종목 간 비교이므로 모든 활성 피처가 같은 정보량으로 계산되는 행만 사용한다.
      if (active.some((f) => flags[f.id] === null || flags[f.id] === undefined)) continue;

      let weighted = 0;
      let totalWeight = 0;
      for (const f of active) {
        const w = Math.max(0, params.weights[f.id] ?? f.defaultWeight);
        totalWeight += w;
        if (flags[f.id] === true) weighted += w;
      }
      if (!(totalWeight > 0)) continue;

      const exit = bars[i + RANKING_HORIZON]!;
      if (!(exit.close > 0)) continue;
      const ret = (exit.close / bar.close - 1) * 100;
      const benchEntry = benchmark.get(bar.tradeDate);
      const benchExit = benchmark.get(exit.tradeDate);
      const benchmarkRet =
        benchEntry && benchExit && benchEntry > 0 && benchExit > 0
          ? (benchExit / benchEntry - 1) * 100
          : null;
      const row: RankingObservation = {
        symbol: s.symbol,
        market,
        date: bar.tradeDate,
        score: (weighted / totalWeight) * 100,
        ret,
        benchmarkRet,
        excessRet: benchmarkRet === null ? null : ret - benchmarkRet,
      };
      const rows = byDate.get(row.date);
      if (rows) rows.push(row);
      else byDate.set(row.date, [row]);
    }
  }

  const minCrossSection = Math.max(50, TOP_SELECTION_COUNT, Math.max(...RANKING_QUANTILE_BUCKETS));
  const rankIcByDate: RankIcDateStat[] = [];
  const topDateReturns: TopSelectionDateStat[] = [];
  const quantileDaily = new Map<
    number,
    Array<{
      topRaw: number;
      bottomRaw: number;
      rawSpread: number;
      topAdjusted: number | null;
      bottomAdjusted: number | null;
      adjustedSpread: number | null;
    }>
  >();
  for (const q of RANKING_QUANTILE_BUCKETS) quantileDaily.set(q, []);

  for (const [date, rows] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < minCrossSection) continue;
    const ranked = [...rows].sort(
      (a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol),
    );
    const rawIc = spearman(
      ranked.map((r) => r.score),
      ranked.map((r) => r.ret),
    );
    const adjustedRows = ranked.filter((r) => r.excessRet !== null);
    const adjustedIc = spearman(
      adjustedRows.map((r) => r.score),
      adjustedRows.map((r) => r.excessRet!),
    );
    rankIcByDate.push({
      date,
      observations: ranked.length,
      rawRankIc: rawIc,
      marketAdjustedRankIc: adjustedIc,
    });

    const selected = ranked.slice(0, TOP_SELECTION_COUNT);
    if (selected.length === TOP_SELECTION_COUNT) {
      topDateReturns.push({
        date,
        symbols: selected.map((r) => r.symbol),
        count: selected.length,
        avgScore: mean(selected.map((r) => r.score)),
        avgReturn: mean(selected.map((r) => r.ret)),
        benchmarkAvgReturn: mean(
          selected.map((r) => r.benchmarkRet).filter((r): r is number => r !== null),
        ),
        marketAdjustedAvgReturn: mean(
          selected.map((r) => r.excessRet).filter((r): r is number => r !== null),
        ),
      });
    }

    for (const bucketCount of RANKING_QUANTILE_BUCKETS) {
      const bucketSize = Math.floor(ranked.length / bucketCount);
      if (bucketSize < TOP_SELECTION_COUNT) continue;
      const top = ranked.slice(0, bucketSize);
      const bottom = ranked.slice(-bucketSize);
      const topRaw = mean(top.map((r) => r.ret));
      const bottomRaw = mean(bottom.map((r) => r.ret));
      if (topRaw === null || bottomRaw === null) continue;
      const topAdjusted = mean(top.map((r) => r.excessRet).filter((r): r is number => r !== null));
      const bottomAdjusted = mean(
        bottom.map((r) => r.excessRet).filter((r): r is number => r !== null),
      );
      quantileDaily.get(bucketCount)!.push({
        topRaw,
        bottomRaw,
        rawSpread: topRaw - bottomRaw,
        topAdjusted,
        bottomAdjusted,
        adjustedSpread:
          topAdjusted !== null && bottomAdjusted !== null ? topAdjusted - bottomAdjusted : null,
      });
    }
  }

  const rawIcs = rankIcByDate.map((r) => r.rawRankIc).filter((r): r is number => r !== null);
  const adjustedIcs = rankIcByDate
    .map((r) => r.marketAdjustedRankIc)
    .filter((r): r is number => r !== null);
  const topRaw = topDateReturns.map((r) => r.avgReturn).filter((r): r is number => r !== null);
  const topAdjusted = topDateReturns
    .map((r) => r.marketAdjustedAvgReturn)
    .filter((r): r is number => r !== null);

  const rankIcSummary: RankIcSummary = {
    horizon: RANKING_HORIZON,
    dates: rankIcByDate.length,
    avgRawRankIc: mean(rawIcs),
    medianRawRankIc: median(rawIcs),
    rawPositiveRate: winRate(rawIcs),
    avgMarketAdjustedRankIc: mean(adjustedIcs),
    medianMarketAdjustedRankIc: median(adjustedIcs),
    marketAdjustedPositiveRate: winRate(adjustedIcs),
  };

  const topSelection: TopSelectionSummary = {
    horizon: RANKING_HORIZON,
    topN: TOP_SELECTION_COUNT,
    dates: topDateReturns.length,
    avgReturn: mean(topRaw),
    medianReturn: median(topRaw),
    winRate: winRate(topRaw),
    marketAdjustedAvgReturn: mean(topAdjusted),
    dateReturns: topDateReturns,
  };

  const quantileSpreads: QuantileSpreadStat[] = RANKING_QUANTILE_BUCKETS.map((bucketCount) => {
    const rows = quantileDaily.get(bucketCount)!;
    const adjustedSpreads = rows
      .map((r) => r.adjustedSpread)
      .filter((r): r is number => r !== null);
    const robust = hacMeanStats(
      adjustedSpreads,
      Math.max(1, Math.ceil(RANKING_HORIZON / sampleEvery) - 1),
    );
    return {
      horizon: RANKING_HORIZON,
      bucketCount,
      dates: rows.length,
      topAvgReturn: mean(rows.map((r) => r.topRaw)),
      bottomAvgReturn: mean(rows.map((r) => r.bottomRaw)),
      rawSpread: mean(rows.map((r) => r.rawSpread)),
      topMarketAdjustedAvgReturn: mean(
        rows.map((r) => r.topAdjusted).filter((r): r is number => r !== null),
      ),
      bottomMarketAdjustedAvgReturn: mean(
        rows.map((r) => r.bottomAdjusted).filter((r): r is number => r !== null),
      ),
      marketAdjustedSpread: robust.mean,
      robustTStat: robust.t,
      ci95Low: robust.low,
      ci95High: robust.high,
    };
  });

  return { rankIcByDate, rankIcSummary, topSelection, quantileSpreads };
}
