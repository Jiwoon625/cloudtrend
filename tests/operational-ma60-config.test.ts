import { describe, it, expect, vi } from "vitest";
import { mergeScoringConfig, DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
const st = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock("../src/lib/screeningSources.server", () => ({
  loadActiveSources: async () => ({ sources: [], texts: [] }),
  listActiveSources: async () => [],
}));
vi.mock("../src/lib/underlyingIndexDiagnostics.server", () => ({
  readArtifactText: async () => JSON.stringify({}),
  datasetDigest: () => "dataset-hash",
  sourceSetDigest: () => "source-hash",
  indexSha256: (s: string) => s,
}));
vi.mock("../src/lib/underlyingIndexSupplement", () => ({
  parseUnderlyingIndexArtifact: () => ({}),
}));
vi.mock("../src/lib/krxReviewReferenceParser", () => ({
  parseManualMarketDataWithReferences: () => ({ dataset: { asOfDate: "2026-10-19" } }),
}));
vi.mock("../src/lib/operationalUnderlyingIndex", () => ({
  OPERATIONAL_INDEX_START: "2026-10-19",
  buildOperationalIndexProvider: () => ({
    version: "v1",
    artifactSha256: "artifact-hash",
    asOfDate: "2026-10-19",
    rows: {},
  }),
}));
vi.mock("../src/lib/screeningPublicationAnalysis", () => ({
  screeningPublicationAnalysis: (a: unknown) => a,
}));
vi.mock("../src/lib/engine/fullMarketAnalysis", () => ({
  runFullMarketAnalysis: (_ds: unknown, config: unknown) => {
    st.config = config;
    return { analysis: { asOfDate: "2026-10-19", rows: [] }, dataset: { asOfDate: "2026-10-19" } };
  },
}));
vi.mock("../src/lib/operationalEtfMa60", () => ({ withOperationalEtfMa60: (a: unknown) => a }));
import { compareOperationalIndex } from "../src/lib/operationalUnderlyingIndex.server";
import type { SupabaseClient } from "@supabase/supabase-js";
describe("operational impact audit config", () => {
  it("passes the same merged active config to the full engine and reports its provenance", async () => {
    const config = mergeScoringConfig({
      ...DEFAULT_SCORING_CONFIG,
      priority: { ...DEFAULT_SCORING_CONFIG.priority, minMarketCap: 123456789 },
    });
    const result = await compareOperationalIndex(
      {} as SupabaseClient,
      "owner",
      "2026-10-19T12:00:00Z",
      config,
    );
    expect(st.config).toBe(config);
    expect(result.usesDefaultScoringConfig).toBe(false);
    expect(result.writesPerformed).toBe(0);
    expect(result.scoringConfigSha256).toBeTypeOf("string");
  });
  it("keeps default config only for callers that omit it", async () => {
    const result = await compareOperationalIndex(
      {} as SupabaseClient,
      "owner",
      "2026-10-19T12:00:00Z",
    );
    expect(st.config).toBe(DEFAULT_SCORING_CONFIG);
    expect(result.usesDefaultScoringConfig).toBe(true);
  });
});
