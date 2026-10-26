import { beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMockDataset } from "./engine/mockProvider";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "./screeningCacheContract";
import { loadConfirmedEtfContext, preserveConfirmedEtfContext } from "./confirmedEtfContext.server";
import type { AnalysisResult } from "./engine/pipeline";
let analysis: AnalysisResult;
beforeAll(() => {
  analysis = runFullMarketAnalysis(getMockDataset(), DEFAULT_SCORING_CONFIG).analysis;
});
function store() {
  const objects = new Map<string, string>();
  const upload = vi.fn(async (path: string, blob: Blob) => {
    objects.set(path, await blob.text());
    return { error: null };
  });
  const client = {
    storage: {
      from: () => ({
        upload,
        download: async (path: string) =>
          objects.has(path)
            ? { data: new Blob([objects.get(path)!]), error: null }
            : { data: null, error: { statusCode: "404", message: "Object not found" } },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, objects, upload };
}
function cached() {
  return {
    version: SCREENING_CACHE_VERSION,
    resultDigest: createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(analysis)))
      .digest("hex"),
    payload: { analysis },
  };
}
it("preserves verified FINAL ETF quotes/dates and repeated preview cannot replace them", async () => {
  const s = store();
  await preserveConfirmedEtfContext(s.client, "owner", cached());
  const before = await loadConfirmedEtfContext(s.client, "owner");
  expect(before?.rows.length).toBeGreaterThan(0);
  expect(before?.rows.every((row) => row.market === "ETF")).toBe(true);
  expect(before?.date).toBe(analysis.asOfDate);
  const preview = {
    ...cached(),
    payload: { analysis: { ...analysis, krPublication: { phase: "PRELIMINARY" }, rows: [] } },
  };
  await preserveConfirmedEtfContext(s.client, "owner", preview);
  expect(s.upload).toHaveBeenCalledTimes(1);
  expect(await loadConfirmedEtfContext(s.client, "owner")).toEqual(before);
});
it("missing confirmed cache stays missing; invalid prior result cannot be preserved", async () => {
  const s = store();
  expect(await loadConfirmedEtfContext(s.client, "owner")).toBeNull();
  await preserveConfirmedEtfContext(s.client, "owner", null);
  await expect(
    preserveConfirmedEtfContext(s.client, "owner", { ...cached(), resultDigest: "bad" }),
  ).rejects.toThrow(/unverified/);
  expect(s.upload).not.toHaveBeenCalled();
});
it("fails closed on corrupted confirmed quote content", async () => {
  const s = store();
  await preserveConfirmedEtfContext(s.client, "owner", cached());
  const path = "owner/cache/screening/confirmed-etf-context.json";
  const changed = JSON.parse(s.objects.get(path)!);
  changed.index.rows[0].price = 1;
  s.objects.set(path, JSON.stringify(changed));
  await expect(loadConfirmedEtfContext(s.client, "owner")).rejects.toThrow(/integrity/);
});
