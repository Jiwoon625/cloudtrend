import { currentScreeningEngineIdentity } from "../src/lib/screeningEngineIdentity";
import { expect, test, vi } from "vitest";
import { driveFixture } from "./drive-publication-fixture";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { stableCacheJson } from "../src/lib/screeningCacheContract";
import { gunzipJson, gzipJson } from "../src/lib/cacheObjectEncoding";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { LoadedSourceInput } from "../scripts/source-registry-store";
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
test("result-only cache publishing writes only the two gzip pointers and no raw or financial objects", async () => {
  const uploads = new Map<string, unknown>();
  const client = {
    storage: {
      from: () => ({
        upload: async (path: string, body: Blob | Uint8Array) => {
          const bytes = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new Uint8Array(body);
          uploads.set(path, await gunzipJson(bytes));
          return { error: null };
        },
        download: async (path: string) =>
          uploads.has(path)
            ? {
                data: new Blob([new Uint8Array(await gzipJson(uploads.get(path)))]),
                error: null,
              }
            : { data: null, error: { message: "Object not found", statusCode: "404" } },
      }),
    },
  };
  const proof = driveFixture();
  const p = { ...proof.sources[0]!.record.validation_result.krPublication };
  const analysis = {
    asOfDate: proof.asOfDate,
    calculatedAt: "now",
    krPublication: { phase: p.phase },
  } as AnalysisResult;
  const inputs = proof.sources.map((s) => ({ sourceRecord: s.record })) as LoadedSourceInput[];
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
  expect([...uploads.keys()]).toEqual([
    "synthetic-owner/cache/screening/latest.json.gz",
    "synthetic-owner/cache/dashboard/latest.json.gz",
  ]);
  expect(result.roundTripVerified).toBe(true);
  expect(result.bytes.raw).toBe(0);
  expect(result.paths.krPath).toBeNull();
  expect(result.paths.screeningPath).toBe("synthetic-owner/cache/screening/latest.json.gz");
  expect(stableCacheJson(uploads.get("synthetic-owner/cache/screening/latest.json.gz"))).toContain(
    "drive-result-publication-v1",
  );
});
