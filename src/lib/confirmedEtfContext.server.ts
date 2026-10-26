import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisResult } from "./engine/pipeline";
import { projectKrDashboard, type DashboardIndex } from "./dashboardOperations";
import { downloadFreshObject } from "./freshStorage";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "./screeningCacheContract";

const BUCKET = "cloudtrend-data";
const VERSION = "confirmed-etf-context-v1";
const location = (uid: string) => `${uid}/cache/screening/confirmed-etf-context.json`;
const digest = (value: unknown) =>
  createHash("sha256").update(stableCacheJson(value)).digest("hex");

/** Preserve verified FINAL marks before the latest-view pointer is replaced by a preview.
 * This is a read-only price projection, not a portfolio update or a financial journal. */
export async function preserveConfirmedEtfContext(
  client: SupabaseClient,
  uid: string,
  cached: unknown,
) {
  const candidate = cached as {
    version?: string;
    resultDigest?: string;
    payload?: { analysis?: AnalysisResult };
  } | null;
  const analysis = candidate?.payload?.analysis;
  if (!analysis || analysis.krPublication?.phase === "PRELIMINARY") return;
  if (
    candidate?.version !== SCREENING_CACHE_VERSION ||
    !candidate.resultDigest ||
    digest(deterministicAnalysis(analysis)) !== candidate.resultDigest
  )
    throw new Error("Cannot preserve unverified confirmed ETF marks");
  const full = projectKrDashboard(analysis);
  const index: DashboardIndex = { ...full, rows: full.rows.filter((row) => row.market === "ETF") };
  const value = {
    version: VERSION,
    sourceDigest: candidate.resultDigest,
    index,
    indexDigest: digest(index),
  };
  const { error } = await client.storage
    .from(BUCKET)
    .upload(location(uid), new Blob([JSON.stringify(value)], { type: "application/json" }), {
      upsert: true,
      contentType: "application/json",
      cacheControl: "0",
    });
  if (error)
    throw new Error("Confirmed ETF marks could not be preserved before preliminary publication");
  const restored = await loadConfirmedEtfContext(client, uid);
  if (!restored || digest(restored) !== value.indexDigest)
    throw new Error("Confirmed ETF marks failed readback before preliminary publication");
}

export async function loadConfirmedEtfContext(
  client: SupabaseClient,
  uid: string,
): Promise<DashboardIndex | null> {
  const { data, error } = await downloadFreshObject(client, BUCKET, location(uid));
  if (error) {
    if (String(error.statusCode) === "404" || /object not found/i.test(error.message)) return null;
    throw new Error("Confirmed ETF marks unavailable");
  }
  if (!data) return null;
  const saved = JSON.parse(await data.text()) as {
    version?: string;
    sourceDigest?: string;
    index?: DashboardIndex;
    indexDigest?: string;
  };
  if (
    saved.version !== VERSION ||
    !/^[a-f0-9]{64}$/.test(saved.sourceDigest ?? "") ||
    !saved.index ||
    !Array.isArray(saved.index.rows) ||
    saved.index.rows.some((row) => row.market !== "ETF") ||
    digest(saved.index) !== saved.indexDigest
  )
    throw new Error("Confirmed ETF mark integrity check failed");
  return saved.index;
}
