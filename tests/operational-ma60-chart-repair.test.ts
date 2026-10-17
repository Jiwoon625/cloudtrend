import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trusted: vi.fn(),
  sources: vi.fn(),
  parse: vi.fn(),
  provider: vi.fn(),
  read: vi.fn(),
  warm: vi.fn(),
}));
vi.mock("../scripts/analysis-run-store", () => ({ trustedSupabaseClient: mocks.trusted }));
vi.mock("../src/lib/screeningSources.server", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningSources.server")>()),
  loadActiveSources: mocks.sources,
}));
vi.mock("../src/lib/krxReviewReferenceParser", async (original) => ({
  ...(await original<typeof import("../src/lib/krxReviewReferenceParser")>()),
  parseManualMarketDataWithReferences: mocks.parse,
}));
vi.mock("../src/lib/operationalUnderlyingIndex.server", () => ({
  loadOperationalIndex: mocks.provider,
}));
vi.mock("../src/lib/instrumentChartStore.server", async (original) => ({
  ...(await original<typeof import("../src/lib/instrumentChartStore.server")>()),
  readChartBundle: mocks.read,
  warmRecentCharts: mocks.warm,
}));

import { repairChartCache, repairConfigPath } from "../scripts/repair-chart-cache";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { withOperationalEtfMa60 } from "../src/lib/operationalEtfMa60";
import { inputFingerprint, type ActiveSourceRecord } from "../src/lib/screeningSources.server";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "../src/lib/screeningCacheContract";
import { savedOperationalIdentity } from "../src/lib/screeningInputIdentity";
import { createEtfChartFixture } from "./fixtures/etf-chart-fixture";
import type { OperationalIndexProvider } from "../src/lib/operationalUnderlyingIndex";
import { OPERATIONAL_INDEX_VERSION } from "../src/lib/operationalUnderlyingIndex";
import { UNDERLYING_INDEX_RELEASE } from "../src/lib/underlyingIndexSupplementRelease";

const trustedCallsOnImport = mocks.trusted.mock.calls.length;
const now = "2026-10-20T10:00:00Z";
const sourceRows = ["first", "second"].map((id) => ({
  id,
  data_hash: id,
  schema_hash: "schema",
  activated_at: "2026-10-19T00:00:00Z",
  created_at: "2026-10-19T00:00:00Z",
})) as ActiveSourceRecord[];
const digest = (analysis: Parameters<typeof deterministicAnalysis>[0]) =>
  createHash("sha256")
    .update(stableCacheJson(deterministicAnalysis(analysis)))
    .digest("hex");

function fixture(operational = true) {
  const dataset = createEtfChartFixture(190);
  const base = runFullMarketAnalysis(dataset).analysis;
  const provider: OperationalIndexProvider = {
    version: OPERATIONAL_INDEX_VERSION,
    artifactSha256: UNDERLYING_INDEX_RELEASE.sha256,
    asOfDate: dataset.asOfDate,
    availableFrom: "2026-10-17T07:21:29Z",
    rows: {},
  };
  const analysis = operational ? withOperationalEtfMa60(base, provider) : base;
  const saved = {
    version: SCREENING_CACHE_VERSION,
    inputFingerprint: inputFingerprint(
      sourceRows,
      DEFAULT_SCORING_CONFIG,
      savedOperationalIdentity(analysis),
    ),
    resultDigest: digest(analysis),
    payload: { analysis },
  };
  const download = vi.fn(async () => ({ data: new Blob([JSON.stringify(saved)]), error: null }));
  const list = vi.fn(async () => ({ data: [{ name: "scored-ready.json.gz" }], error: null }));
  const client = {
    storage: { from: vi.fn(() => ({ download, list })) },
  } as unknown as SupabaseClient;
  mocks.sources.mockResolvedValue({ sources: sourceRows, texts: ["synthetic-only"] });
  mocks.parse.mockReturnValue({ dataset });
  mocks.provider.mockResolvedValue(provider);
  return { dataset, provider, saved, client, download, list };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockReset().mockResolvedValue(null);
  mocks.warm.mockResolvedValue({ buckets: 1 });
});

it("imports inertly and accepts only the original-config CLI option", () => {
  expect(trustedCallsOnImport).toBe(0);
  expect(repairConfigPath([])).toBeUndefined();
  expect(repairConfigPath(["--config", "original.json"])).toBe("original.json");
  for (const args of [["--config"], ["--config", "--force"], ["--force"], ["extra"]])
    expect(() => repairConfigPath(args)).toThrow("Usage");
});

it("restores the saved pinned provider on rollback and warms only that exact saved generation", async () => {
  const f = fixture();
  const metadata = savedOperationalIdentity(f.saved.payload.analysis)!;
  const result = await repairChartCache({ client: f.client, uid: "owner", now });
  expect(result).toEqual({
    reused: false,
    inputFingerprint: f.saved.inputFingerprint,
    resultDigest: f.saved.resultDigest,
  });
  expect(mocks.provider).toHaveBeenCalledWith(f.client, "owner", f.dataset, now, false, metadata);
  expect(mocks.warm).toHaveBeenCalledOnce();
  const [client, uid, identity, ctx] = mocks.warm.mock.calls[0]!;
  expect(client).toBe(f.client);
  expect(uid).toBe("owner");
  expect(identity).toEqual({
    inputFingerprint: f.saved.inputFingerprint,
    resultDigest: f.saved.resultDigest,
  });
  expect(ctx.operationalIndex).toBe(f.provider);
  expect(ctx.analysis).toEqual(f.saved.payload.analysis);
  expect(ctx.config).toEqual(DEFAULT_SCORING_CONFIG);
  expect(f.download).toHaveBeenCalledWith(
    "owner/cache/screening/latest.json",
    { cacheNonce: expect.any(String) },
    { cache: "no-store" },
  );
  expect(mocks.trusted).not.toHaveBeenCalled();
});

it("never adds an optional provider to a legacy saved publication", async () => {
  const f = fixture(false);
  await repairChartCache({ client: f.client, uid: "owner", now });
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(mocks.warm.mock.calls[0]![3].operationalIndex).toBeUndefined();
});

it("requires the exact original non-default config rather than silently warming with defaults", async () => {
  const f = fixture();
  const config = structuredClone(DEFAULT_SCORING_CONFIG);
  config.universe.minPrice += 100;
  f.saved.inputFingerprint = inputFingerprint(
    sourceRows,
    config,
    savedOperationalIdentity(f.saved.payload.analysis),
  );
  await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow(
    "original --config",
  );
  expect(mocks.warm).not.toHaveBeenCalled();
  await repairChartCache({ client: f.client, uid: "owner", now, config });
  expect(mocks.warm.mock.calls[0]![3].config).toEqual(config);
});

it("rejects a corrupt result digest before even accepting ready markers", async () => {
  const f = fixture();
  f.saved.resultDigest = "0".repeat(64);
  mocks.read.mockResolvedValue({ ready: true });
  await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow("digest");
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.sources).not.toHaveBeenCalled();
  expect(mocks.warm).not.toHaveBeenCalled();
});

it("rejects altered metadata even if the result digest was recomputed", async () => {
  const f = fixture();
  Object.assign(f.saved.payload.analysis, {
    operationalIndex: {
      ...savedOperationalIdentity(f.saved.payload.analysis),
      artifactSha256: "0".repeat(64),
    },
  });
  f.saved.resultDigest = digest(f.saved.payload.analysis);
  await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow("MA60");
  expect(mocks.warm).not.toHaveBeenCalled();
});

it("rejects changed source precedence and never restores or warms a mismatched context", async () => {
  const f = fixture();
  mocks.sources.mockResolvedValue({
    sources: [...sourceRows].reverse(),
    texts: ["synthetic-only"],
  });
  await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow(
    "fingerprint",
  );
  expect(mocks.parse).not.toHaveBeenCalled();
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(mocks.warm).not.toHaveBeenCalled();
});

it.each(["missing", "version", "artifactSha256", "asOfDate", "availableFrom"])(
  "fails closed without chart writes when the pinned provider is %s",
  async (field) => {
    const f = fixture();
    mocks.provider.mockResolvedValue(
      field === "missing" ? undefined : { ...f.provider, [field]: "mismatch" },
    );
    await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow(
      "provider identity",
    );
    expect(mocks.warm).not.toHaveBeenCalled();
  },
);

it("propagates artifact read errors without writing charts or downgrading to legacy", async () => {
  const f = fixture();
  mocks.provider.mockRejectedValue(new Error("pinned artifact unavailable"));
  await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow(
    "artifact unavailable",
  );
  expect(mocks.warm).not.toHaveBeenCalled();
});

it("refuses a parsed dataset with a different as-of date", async () => {
  const f = fixture();
  f.dataset.asOfDate = "2026-10-16";
  await expect(repairChartCache({ client: f.client, uid: "owner", now })).rejects.toThrow(
    "dataset date",
  );
  expect(mocks.warm).not.toHaveBeenCalled();
});

it("returns already-ready only after saved metadata, digest and source/config verification", async () => {
  const f = fixture();
  mocks.read.mockResolvedValue({ ready: true });
  expect(await repairChartCache({ client: f.client, uid: "owner", now })).toMatchObject({
    reused: true,
  });
  expect(mocks.sources).toHaveBeenCalledOnce();
  expect(mocks.parse).not.toHaveBeenCalled();
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(mocks.warm).not.toHaveBeenCalled();
});
