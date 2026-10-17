import { createHash } from "node:crypto";
import { buildFullUniverseSectorDataset } from "./engine/sectorRotationFullUniverse";
import { deterministicAnalysis, stableCacheJson } from "./screeningCacheContract";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compactChartSeries,
  instrumentChartPoint,
  chartScoreHistory,
  type InstrumentChart,
  type InstrumentChartRange,
} from "./engine/instrumentChart";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";
import type { ScoringConfig } from "./engine/scoring";
import type { OperationalIndexProvider } from "./operationalUnderlyingIndex";
import {
  buildEtfInstrumentChart,
  etfObservedPriceChart,
  type EtfInstrumentChartBundle,
} from "./engine/etfInstrumentChart";
import {
  chartPath,
  chartReadyPath,
  assertChartMatchesCard,
  assertEtfChartMatchesCard,
  type ChartIdentity,
  type ChartKind,
} from "./instrumentChartContract";
const BUCKET = "cloudtrend-data";
export interface ChartContext {
  dataset: MarketDataset;
  analysis: AnalysisResult;
  config: ScoringConfig;
  operationalIndex?: OperationalIndexProvider | undefined;
}
/** Restore chart inputs without rerunning portfolio/onset/full-screening analysis. */
export function restoreChartContext(
  rawDataset: MarketDataset,
  analysis: AnalysisResult,
  config: ScoringConfig,
  expectedDigest: string,
  operationalIndex?: OperationalIndexProvider,
): ChartContext {
  const digest = createHash("sha256")
    .update(stableCacheJson(deterministicAnalysis(analysis)))
    .digest("hex");
  if (digest !== expectedDigest)
    throw new Error("저장된 스크리닝 결과 검증에 실패했습니다. 스크리닝을 다시 실행해 주세요.");
  return {
    dataset: buildFullUniverseSectorDataset(rawDataset),
    analysis,
    config,
    ...(operationalIndex ? { operationalIndex } : {}),
  };
}
// Bounded opportunistic server memory reuse, always scoped to user and immutable revision.
let recent: { key: string; at: number; context: ChartContext } | undefined;
const key = (uid: string, i: ChartIdentity) => `${uid}:${i.inputFingerprint}:${i.resultDigest}`;
export function primeChartContext(
  uid: string,
  inputFingerprint: string,
  resultDigest: string,
  context: ChartContext,
) {
  recent = { key: key(uid, { inputFingerprint, resultDigest }), at: Date.now(), context };
}
export function cachedChartContext(uid: string, i: ChartIdentity) {
  if (recent && Date.now() - recent.at > 5 * 60_000) recent = undefined;
  if (recent?.key !== key(uid, i)) return undefined;
  recent.at = Date.now();
  return recent.context;
}
export function priceChart(ctx: ChartContext, symbol: string, range: InstrumentChartRange) {
  const bars = ctx.dataset.bars[symbol] ?? [];
  return {
    chart: (range === "120" ? bars.slice(-120) : bars).map((b) => ({
      tradeDate: b.tradeDate,
      close: b.close,
      volume: b.volume,
    })),
    history: [],
  };
}
export function scoredChart(ctx: ChartContext, symbol: string, range: InstrumentChartRange) {
  const chart = compactChartSeries(ctx.dataset, symbol, range, ctx.config);
  assertChartMatchesCard(chart, ctx.analysis, symbol);
  return { chart, history: chartScoreHistory(chart) };
}
/** Same point evaluator, yielding on a time budget instead of a timer per five points. */
async function responsiveScoredChart(
  ctx: ChartContext,
  symbol: string,
  range: InstrumentChartRange,
) {
  const bars = ctx.dataset.bars[symbol] ?? [];
  const chart: InstrumentChart = [];
  // Give the parallel price-only request a turn even for short, already-warm series.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  let batchStarted = performance.now();
  for (
    let index = range === "all" ? 0 : Math.max(0, bars.length - 120);
    index < bars.length;
    index++
  ) {
    chart.push(instrumentChartPoint(ctx.dataset, symbol, index, ctx.config));
    if (index < bars.length - 1 && performance.now() - batchStarted >= 32) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      batchStarted = performance.now();
    }
  }
  assertChartMatchesCard(chart, ctx.analysis, symbol);
  return { chart, history: chartScoreHistory(chart) };
}
export type PreparedChart = ReturnType<typeof scoredChart>;
export type PriceChart = ReturnType<typeof priceChart>;
export type EtfPriceChart = ReturnType<typeof etfObservedPriceChart>;
export type ChartBundle = PreparedChart | PriceChart | EtfPriceChart | EtfInstrumentChartBundle;
export async function readChartBundle<T>(
  client: SupabaseClient,
  uid: string,
  path: string,
): Promise<Record<string, T> | null> {
  const { data, error } = await client.storage.from(BUCKET).download(`${uid}/${path}`);
  if (error) {
    if (String(error.statusCode) === "404" || error.message === "Object not found") return null;
    throw new Error(`차트 캐시 읽기 실패: ${error.message}`);
  }
  try {
    return JSON.parse(gunzipSync(new Uint8Array(await data.arrayBuffer())).toString()) as Record<
      string,
      T
    >;
  } catch (error) {
    console.warn("손상된 차트 캐시를 다시 생성합니다.", error);
    return null;
  }
}
async function writeBundle(
  client: SupabaseClient,
  uid: string,
  path: string,
  bundle: Record<string, unknown>,
) {
  const bytes = gzipSync(JSON.stringify(bundle));
  const { error } = await client.storage
    .from(BUCKET)
    .upload(`${uid}/${path}`, bytes, { contentType: "application/octet-stream", upsert: true });
  if (error) throw new Error(`차트 캐시 저장 실패: ${error.message}`);
}
export async function publishRecentPrices(
  client: SupabaseClient,
  uid: string,
  inputFingerprint: string,
  resultDigest: string,
  ctx: ChartContext,
) {
  const identity = { inputFingerprint, resultDigest };
  if (await readChartBundle(client, uid, chartReadyPath(identity, "prices"))) return;
  const buckets = new Map<string, Record<string, unknown>>();
  for (const row of ctx.analysis.rows) {
    const symbol = row.instrument.symbol,
      path = chartPath(identity, symbol, "120", "prices");
    const bucket = buckets.get(path) ?? {};
    bucket[symbol] = priceChart(ctx, symbol, "120");
    buckets.set(path, bucket);
  }
  // Bounded upload concurrency; no detached writes on a serverless runtime.
  const entries = [...buckets];
  for (let i = 0; i < entries.length; i += 8)
    await Promise.all(
      entries.slice(i, i + 8).map(([path, bundle]) => writeBundle(client, uid, path, bundle)),
    );
  await writeBundle(client, uid, chartReadyPath(identity, "prices"), { ready: true });
}
// Only in-flight computations are shared; completed bundles remain in existing owner paths.
const preparing = new Map<string, Promise<Record<string, ChartBundle>>>();
export async function prepareChartBucket(
  client: SupabaseClient,
  uid: string,
  identity: ChartIdentity,
  ctx: ChartContext,
  symbol: string,
  range: InstrumentChartRange,
  kind: ChartKind,
  allowUncached = false,
  cacheAlreadyChecked = false,
) {
  const path = chartPath(identity, symbol, range, kind);
  // Keep strict warmup writes separate from best-effort on-demand writes.
  const pendingKey = `${uid}:${path}:${stableCacheJson(ctx.config)}:${ctx.operationalIndex?.version ?? ""}:${ctx.operationalIndex?.artifactSha256 ?? ""}:${allowUncached}`;
  let pending = preparing.get(pendingKey);
  if (!pending) {
    pending = prepare().finally(() => preparing.delete(pendingKey));
    preparing.set(pendingKey, pending);
  }
  const result = (await pending)[symbol];
  if (!result) throw new Error("종목 차트가 없습니다.");
  return result;

  async function prepare() {
    const symbols =
      range === "all"
        ? [symbol]
        : ctx.analysis.rows
            .filter((r) => !kind.startsWith("etf") || r.instrument.instrumentType === "ETF")
            .map((r) => r.instrument.symbol)
            .filter((s) => chartPath(identity, s, range, kind) === path);
    const existing = cacheAlreadyChecked
      ? null
      : await readChartBundle<ChartBundle>(client, uid, path);
    // A partial legacy/corrupt bundle must not satisfy a coalesced request for another symbol.
    if (existing?.[symbol] && symbols.every((s) => existing[s])) return existing;
    const bundle: Record<string, ChartBundle> = {};
    for (const s of symbols) {
      if (kind === "prices") bundle[s] = priceChart(ctx, s, range);
      else if (kind === "etf-prices") bundle[s] = etfObservedPriceChart(ctx.dataset, s, range);
      else if (kind === "etf") {
        const chart = await buildEtfInstrumentChart(ctx.dataset, s, range, ctx.operationalIndex);
        assertEtfChartMatchesCard(chart, ctx.analysis, s);
        bundle[s] = chart;
      } else {
        // Let independent price responses and other requests progress between score batches.
        bundle[s] = await responsiveScoredChart(ctx, s, range);
      }
    }
    try {
      await writeBundle(client, uid, path, bundle);
    } catch (error) {
      if (!allowUncached) throw error;
      console.warn("차트 저장 실패: 계산 결과를 먼저 반환합니다.", error);
    }
    return bundle;
  }
}
// Each completed bucket is resumable; a failed request cannot publish a partial bucket.
export async function warmRecentCharts(
  client: SupabaseClient,
  uid: string,
  identity: ChartIdentity,
  ctx: ChartContext,
) {
  const readyPath = chartReadyPath(identity, "scored");
  const prior = await readChartBundle<{ buckets: number }>(client, uid, readyPath);
  if (prior?.["ready"]) {
    await warmRecentEtfCharts(client, uid, identity, ctx);
    return prior["ready"];
  }
  await publishRecentPrices(client, uid, identity.inputFingerprint, identity.resultDigest, ctx);
  const representatives = new Map<string, string>();
  for (const row of ctx.analysis.rows) {
    const symbol = row.instrument.symbol;
    representatives.set(chartPath(identity, symbol, "120", "scored"), symbol);
  }
  const symbols = [...representatives.values()];
  for (let i = 0; i < symbols.length; i += 4) {
    const results = await Promise.allSettled(
      symbols
        .slice(i, i + 4)
        .map((symbol) => prepareChartBucket(client, uid, identity, ctx, symbol, "120", "scored")),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  const result = { buckets: representatives.size };
  await writeBundle(client, uid, readyPath, { ready: result });
  await warmRecentEtfCharts(client, uid, identity, ctx);
  return result;
}

/** Recent-only ETF preparation; full history remains opt-in like the stock chart. */
export async function warmRecentEtfCharts(
  client: SupabaseClient,
  uid: string,
  identity: ChartIdentity,
  ctx: ChartContext,
) {
  const readyPath = chartReadyPath(identity, "etf");
  if (await readChartBundle(client, uid, readyPath)) return;
  const representatives = new Map<string, string>();
  for (const row of ctx.analysis.rows) {
    if (row.instrument.instrumentType !== "ETF") continue;
    const symbol = row.instrument.symbol;
    representatives.set(chartPath(identity, symbol, "120", "etf"), symbol);
  }
  const symbols = [...representatives.values()];
  for (let i = 0; i < symbols.length; i += 4) {
    const results = await Promise.allSettled(
      symbols.slice(i, i + 4).map(async (symbol) => {
        await prepareChartBucket(client, uid, identity, ctx, symbol, "120", "etf-prices");
        return prepareChartBucket(client, uid, identity, ctx, symbol, "120", "etf");
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  await writeBundle(client, uid, readyPath, { ready: { buckets: representatives.size } });
}
