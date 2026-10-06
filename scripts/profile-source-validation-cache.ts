/** Read-only production profiling. Never uploads source data or changes registry state. */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAnalysisSourceInputs, type LoadedSourceInput } from "./source-registry-store";
import { SourceValidationCache } from "./source-validation-cache";

function identity(inputs: LoadedSourceInput[]) {
  const digest = createHash("sha256");
  for (const input of inputs) {
    digest.update(
      JSON.stringify([
        input.id,
        input.fileName,
        input.savedAt,
        input.bytes,
        input.fileHash,
        input.dataHash,
        input.schemaHash,
        input.validation.stats,
      ]),
    );
    digest.update(input.text);
  }
  return digest.digest("hex");
}

export async function profileSourceValidationCache(client: SupabaseClient, userId: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "cloudtrend-validation-profile-"));
  async function pass() {
    const cache = new SourceValidationCache({ directory });
    const started = performance.now();
    const inputs = await loadAnalysisSourceInputs(client, userId, "screening", {
      compact: true,
      validationCache: cache,
    });
    if (!inputs.length || inputs.some((input) => !input.sourceRecord))
      throw new Error("Profiling requires registered screening sources");
    const result = {
      durationMs: Math.round(performance.now() - started),
      sources: inputs.length,
      logicalBytes: inputs.reduce((sum, input) => sum + input.bytes, 0),
      metrics: { ...cache.metrics },
      identity: identity(inputs),
    };
    for (const input of inputs) {
      input.text = "";
      input.validation.canonicalCsv = "";
      input.validation.rows = [];
    }
    return result;
  }
  try {
    const cold = await pass(),
      warm = await pass();
    if (cold.identity !== warm.identity)
      throw new Error("Source set or validated contents changed during profile");
    const { identity: _coldIdentity, ...coldSummary } = cold;
    const { identity: _warmIdentity, ...warmSummary } = warm;
    return {
      version: "source-validation-profile-v1",
      readOnly: true,
      identityMatched: true,
      cold: coldSummary,
      warm: warmSummary,
      warmReusedAll: warm.metrics.hits === warm.sources,
      speedup: warm.durationMs > 0 ? Number((cold.durationMs / warm.durationMs).toFixed(3)) : null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
