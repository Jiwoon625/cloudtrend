import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mergeScoringConfig } from "./engine/scoring";
import { parseManualMarketData } from "./engine/manualDataset";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { deterministicAnalysis, stableCacheJson } from "./screeningCacheContract";
import { loadActiveSources, inputFingerprint } from "./screeningSources.server";
import {
  cachedChartContext,
  primeChartContext,
  prepareChartBucket,
  warmRecentCharts,
  readChartBundle,
  type ChartContext,
  type PreparedChart,
  type PriceChart,
} from "./instrumentChartStore.server";
import {
  chartReadyPath,
  chartPath,
  type ChartIdentity,
  type ChartKind,
} from "./instrumentChartContract";
import type { InstrumentChartRange } from "./engine/instrumentChart";
import type { AnalysisResult } from "./engine/pipeline";
interface Input extends ChartIdentity {
  accessToken: string;
  config?: unknown;
  symbol?: string;
  range?: InstrumentChartRange;
  kind?: ChartKind;
}
function validate(input: Input): Input {
  if (!input || typeof input.accessToken !== "string" || input.accessToken.length < 20)
    throw new Error("로그인이 필요합니다.");
  if (!/^[a-f0-9]{64}$/.test(input.inputFingerprint) || !/^[a-f0-9]{64}$/.test(input.resultDigest))
    throw new Error("Invalid chart revision");
  return input;
}
async function session(input: Input) {
  const client = createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${input.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data, error } = await client.auth.getUser(input.accessToken);
  if (error || !data.user) throw new Error("로그인 세션을 확인해 주세요.");
  const uid = data.user.id;
  const { data: blob, error: readError } = await client.storage
    .from("cloudtrend-data")
    .download(`${uid}/cache/screening/latest.json`);
  if (readError) throw new Error(`스크리닝 결과 조회 실패: ${readError.message}`);
  const saved = JSON.parse(await blob.text()) as {
    inputFingerprint: string;
    resultDigest: string;
    payload: { analysis: AnalysisResult };
  };
  if (
    saved.inputFingerprint !== input.inputFingerprint ||
    saved.resultDigest !== input.resultDigest
  )
    throw new Error("스크리닝 자료가 변경됐습니다. 페이지를 새로고침해 주세요.");
  return { client, uid };
}
const contexts = new Map<string, Promise<ChartContext>>();
async function context(input: Input, ctx: Awaited<ReturnType<typeof session>>) {
  const config = mergeScoringConfig(input.config),
    cached = cachedChartContext(ctx.uid, input);
  if (cached && stableCacheJson(cached.config) === stableCacheJson(config)) return cached;
  const key = `${ctx.uid}:${input.inputFingerprint}:${input.resultDigest}`;
  const existing = contexts.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const { sources, texts } = await loadActiveSources(ctx.client, ctx.uid);
    if (inputFingerprint(sources, config) !== input.inputFingerprint)
      throw new Error("원천자료 또는 점수 설정이 변경됐습니다. 새로고침해 주세요.");
    const parsed = parseManualMarketData(texts);
    const { dataset, analysis } = runFullMarketAnalysis(parsed.dataset, config);
    const digest = createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(analysis)))
      .digest("hex");
    if (digest !== input.resultDigest)
      throw new Error("현재 엔진과 스크리닝 결과가 다릅니다. 스크리닝을 다시 실행해 주세요.");
    const result = { dataset, analysis, config };
    primeChartContext(ctx.uid, input.inputFingerprint, input.resultDigest, result);
    return result;
  })().finally(() => contexts.delete(key));
  contexts.set(key, pending);
  return pending;
}
const warming = new Map<string, Promise<{ buckets: number }>>();
export const warmInstrumentChartsServer = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }) => {
    const ctx = await session(data),
      key = `${ctx.uid}:${data.inputFingerprint}:${data.resultDigest}`;
    const ready = await readChartBundle<{ buckets: number }>(
      ctx.client,
      ctx.uid,
      chartReadyPath(data, "scored"),
    );
    if (ready?.["ready"]) return ready["ready"];
    const existing = warming.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const ready = await context(data, ctx);
      return await warmRecentCharts(ctx.client, ctx.uid, data, ready);
    })().finally(() => warming.delete(key));
    warming.set(key, promise);
    return await promise;
  });
export const getInstrumentChartServer = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }) => {
    const symbol = String(data.symbol ?? "")
      .trim()
      .toUpperCase();
    if (data.range !== "120" && data.range !== "all") throw new Error("Invalid range");
    if (data.kind !== "prices" && data.kind !== "scored") throw new Error("Invalid chart kind");
    const path = chartPath(data, symbol, data.range, data.kind),
      ctx = await session(data);
    const cached = await readChartBundle<PreparedChart | PriceChart>(ctx.client, ctx.uid, path);
    if (cached?.[symbol]) return cached[symbol]!;
    return await prepareChartBucket(
      ctx.client,
      ctx.uid,
      data,
      await context(data, ctx),
      symbol,
      data.range,
      data.kind,
      true,
    );
  });
