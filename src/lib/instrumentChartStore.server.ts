import { gzipSync, gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compactChartSeries,
  chartScoreHistory,
  type InstrumentChartRange,
} from "./engine/instrumentChart";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";
import type { ScoringConfig } from "./engine/scoring";
import {
  chartPath,
  chartReadyPath,
  assertChartMatchesCard,
  type ChartIdentity,
  type ChartKind,
} from "./instrumentChartContract";
const BUCKET = "cloudtrend-data";
export interface ChartContext {
  dataset: MarketDataset;
  analysis: AnalysisResult;
  config: ScoringConfig;
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
  if (recent && Date.now() - recent.at > 120000) recent = undefined;
  return recent?.key === key(uid, i) ? recent.context : undefined;
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
export type PreparedChart = ReturnType<typeof scoredChart>;
export type PriceChart = ReturnType<typeof priceChart>;
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
    .upload(`${uid}/${path}`, bytes, { contentType: "application/gzip", upsert: true });
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
export async function prepareChartBucket(
  client: SupabaseClient,
  uid: string,
  identity: ChartIdentity,
  ctx: ChartContext,
  symbol: string,
  range: InstrumentChartRange,
  kind: ChartKind,
  allowUncached = false,
) {
  const path = chartPath(identity, symbol, range, kind);
  const existing = await readChartBundle<PreparedChart | PriceChart>(client, uid, path);
  if (existing?.[symbol]) return existing[symbol]!;
  const symbols =
    range === "all"
      ? [symbol]
      : ctx.analysis.rows
          .map((r) => r.instrument.symbol)
          .filter((s) => chartPath(identity, s, range, kind) === path);
  const bundle: Record<string, PreparedChart | PriceChart> = {};
  for (const s of symbols)
    bundle[s] = kind === "prices" ? priceChart(ctx, s, range) : scoredChart(ctx, s, range);
  try {
    await writeBundle(client, uid, path, bundle);
  } catch (error) {
    if (!allowUncached) throw error;
    console.warn("차트 저장 실패: 계산 결과를 먼저 반환합니다.", error);
  }
  if (!bundle[symbol]) throw new Error("종목 차트가 없습니다.");
  return bundle[symbol]!;
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
  if (prior?.["ready"]) return prior["ready"];
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
  return result;
}
