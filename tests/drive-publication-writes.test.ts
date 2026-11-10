import { currentScreeningEngineIdentity } from "../src/lib/screeningEngineIdentity";
import { expect, test, vi } from "vitest";
import { driveFixture } from "./drive-publication-fixture";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { stableCacheJson } from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { LoadedSourceInput } from "../scripts/source-registry-store";
const writes = vi.hoisted(() => ({ paths: [] as string[], saved: null as unknown }));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  downloadJson: vi.fn(async () => writes.saved),
  uploadJson: vi.fn(async (_client, path: string, value: unknown) => {
    writes.paths.push(path);
    if (path.endsWith("/cache/screening/latest.json")) writes.saved = value;
    return { body: JSON.stringify(value) };
  }),
}));
vi.mock("../src/lib/confirmedEtfContext.server", () => ({ preserveConfirmedEtfContext: vi.fn() }));
vi.mock("../src/lib/screeningCacheContract", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningCacheContract")>()),
  buildDashboardSummary: vi.fn((analysis, inputFingerprint, resultDigest) => ({
    asOfDate: analysis.asOfDate,
    inputFingerprint,
    resultDigest,
    counts: {},
  })),
}));
import { persistWebScreeningCaches } from "../scripts/web-screening-cache-store";
test("result-only cache publishing never uploads CSV, kr.json, registry or financial history", async () => {
  writes.paths = [];
  writes.saved = null;
  const proof = driveFixture();
  const p = { ...proof.sources[0]!.record.validation_result.krPublication };
  const analysis = {
    asOfDate: proof.asOfDate,
    calculatedAt: "now",
    krPublication: { phase: p.phase },
  } as AnalysisResult;
  const inputs = proof.sources.map((s) => ({ sourceRecord: s.record })) as LoadedSourceInput[];
  const client = {
    storage: {
      from: () => ({
        upload: () => {
          throw new Error("Unexpected raw upload");
        },
      }),
    },
  };
  const result = await persistWebScreeningCaches({
    engineIdentity: currentScreeningEngineIdentity,
    client: client as never,
    userId: "synthetic-owner",
    inputs,
    config: DEFAULT_SCORING_CONFIG,
    analysis,
    snapshot: {} as never,
    previous: null,
    resultOnly: proof,
  });
  expect(writes.paths).toEqual([
    "synthetic-owner/cache/screening/latest.json",
    "synthetic-owner/cache/dashboard/latest.json",
  ]);
  expect(result.bytes.raw).toBe(0);
  expect(result.paths.krPath).toBeNull();
  expect(stableCacheJson(writes.saved)).toContain("drive-result-publication-v1");
});
