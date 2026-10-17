import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { operationalFixture } from "./operational-ma60-fixture";
import { UNDERLYING_INDEX_RELEASE } from "../src/lib/underlyingIndexSupplementRelease";
import { OPERATIONAL_INDEX_VERSION } from "../src/lib/operationalUnderlyingIndex";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { validateSourceText } from "../src/lib/sourceData";
import { stableCacheJson, deterministicAnalysis } from "../src/lib/screeningCacheContract";
import type { LoadedSourceInput } from "../scripts/source-registry-store";

const state = vi.hoisted(() => ({
  enabled: false,
  installed: false,
  artifact: null as string | null,
  corruption: false,
  client: null as unknown,
  inputs: [] as unknown[],
  objects: new Map<string, string>(),
  sources: [] as unknown[],
  dataset: null as unknown,
  webShadow: vi.fn(),
  cliShadow: vi.fn(),
  snapshot: vi.fn(),
  refresh: vi.fn(),
  localCompute: vi.fn(),
  localSnapshot: vi.fn(),
}));
vi.mock("../src/lib/operationalUnderlyingIndexRelease", () => ({
  get OPERATIONAL_INDEX_ENABLED() {
    return state.enabled;
  },
}));
vi.mock("../src/lib/underlyingIndexDiagnostics.server", async (original) => ({
  ...(await original<typeof import("../src/lib/underlyingIndexDiagnostics.server")>()),
  readArtifactText: async () => {
    if (state.corruption) throw new Error("원본·승인 해시 불일치");
    return state.artifact;
  },
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({
      handler: (fn: unknown, implementation?: unknown) => implementation ?? fn,
    }),
  }),
}));
vi.mock("@supabase/supabase-js", async (original) => ({
  ...(await original<typeof import("@supabase/supabase-js")>()),
  createClient: () => state.client,
}));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  trustedSupabaseClient: () => state.client,
  codeVersion: () => "synthetic",
  findReusableRun: async () => null,
  saveRunRecord: async () => undefined,
}));
vi.mock("../scripts/source-registry-store", async (original) => ({
  ...(await original<typeof import("../scripts/source-registry-store")>()),
  loadAnalysisSourceInputs: async () => structuredClone(state.inputs),
}));
vi.mock("../src/lib/octoberShadowPublication.server", () => ({
  recordWebOctoberShadow: state.webShadow,
}));
vi.mock("../src/lib/shadowReplay.server", () => ({ replayKrShadow: state.cliShadow }));
vi.mock("../src/lib/portfolioLedgers.server", () => ({
  refreshPortfolioAfterScreening: state.refresh,
}));
vi.mock("../src/lib/screeningSnapshot", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningSnapshot")>()),
  persistScreeningSnapshot: state.snapshot,
}));
vi.mock("../src/lib/screeningPublication.server", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningPublication.server")>()),
  completeScreeningPublication: async () => undefined,
}));
vi.mock("../src/lib/underlyingIndexDiagnostics.functions", async (original) => {
  const module = await original<typeof import("../src/lib/underlyingIndexDiagnostics.functions")>();
  return {
    ...module,
    operationalIndexContextServer: ({
      data,
    }: {
      data: { accessToken: string; asOfDate: string };
    }) => module.operationalIndexContextForSession(data),
  };
});
vi.mock("../src/lib/cloud", () => ({
  userId: async () => "00000000-0000-4000-8000-000000000001",
  ownerPath: async (p: string) => `00000000-0000-4000-8000-000000000001/${p}`,
  readObject: async (p: string) =>
    state.objects.has(p) ? JSON.parse(state.objects.get(p)!) : null,
  writeObject: async (p: string, v: unknown) => {
    state.objects.set(p, JSON.stringify(v));
  },
  readBinaryObject: async () => null,
  writeBinaryObject: vi.fn(),
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "synthetic-token-long-enough" } },
        error: null,
      }),
    },
  },
}));
vi.mock("../src/lib/sourceRegistry", () => ({
  listActiveScreeningSourceFingerprints: async () => state.sources,
}));
vi.mock("../src/lib/scoringConfigStore", () => ({
  getActiveScoringConfig: () => DEFAULT_SCORING_CONFIG,
}));
vi.mock("../src/lib/manualDataStore", () => ({
  ensureManualDataset: async () => ({ dataset: state.dataset }),
  getManualDataMeta: () => null,
}));
vi.mock("../src/lib/localAnalysis", () => ({ computeLocalAnalysis: state.localCompute }));
vi.mock("../src/lib/screeningHistory", () => ({
  buildSnapshot: state.localSnapshot,
  hydrateSnapshots: vi.fn(),
  saveSnapshot: state.localSnapshot,
}));
// Expensive chart preparation writes are isolated, but the actual restore RPC and provider run below.
vi.mock("../src/lib/instrumentChartStore.server", async (original) => ({
  ...(await original<typeof import("../src/lib/instrumentChartStore.server")>()),
  cachedChartContext: () => undefined,
  primeChartContext: vi.fn(),
  publishRecentPrices: async () => undefined,
  warmRecentCharts: async () => ({ buckets: 0 }),
  readChartBundle: async () => null,
  prepareChartBucket: async (_c: unknown, _u: unknown, _i: unknown, ctx: unknown) => ctx,
}));
import { runWebScreeningForUser } from "../src/lib/webScreening.functions";
import { runScreening } from "../scripts/run-screening";
import {
  loadOperationalIndex,
  compareOperationalIndex,
} from "../src/lib/operationalUnderlyingIndex.server";
import {
  readScreeningCache,
  readDashboardCache,
  currentInputFingerprint,
  buildAndPersistScreeningCaches,
} from "../src/lib/screeningCache";
import { getInstrumentChartForSession } from "../src/lib/instrumentCharts.functions";
import { savedOperationalIdentity } from "../src/lib/screeningInputIdentity";
import { inputFingerprint } from "../src/lib/screeningSources.server";
import { inputFingerprint as cliFingerprint } from "../scripts/web-screening-cache-store";
let client: SupabaseClient;
let dir: string;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
beforeEach(async () => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  dir = await mkdtemp(path.join(tmpdir(), "ma60-ingress-"));
  state.enabled = false;
  state.installed = false;
  state.artifact = null;
  state.corruption = false;
  state.objects.clear();
  state.webShadow.mockResolvedValue({ status: "UP_TO_DATE" });
  state.cliShadow.mockResolvedValue({ deferred: null });
  state.refresh.mockResolvedValue({
    status: "UPDATED",
    asOfDate: "2026-10-19",
    calculatedAt: "2026-10-19T12:00:00Z",
  });
  client = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "00000000-0000-4000-8000-000000000001" } },
        error: null,
      }),
    },
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        lt: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({
          data:
            table === "operational_index_installations" && state.installed
              ? {
                  artifact_sha256: UNDERLYING_INDEX_RELEASE.sha256,
                  original_sha256: UNDERLYING_INDEX_RELEASE.originalArtifactSha256,
                }
              : null,
          error: null,
        }),
        then: (resolve: (x: unknown) => unknown) => resolve({ data: state.sources, error: null }),
      };
      return query;
    },
    storage: {
      from: () => ({
        download: async (p: string) =>
          state.objects.has(p)
            ? { data: new Blob([state.objects.get(p)!]), error: null }
            : { data: null, error: { message: "Object not found" } },
        upload: async (p: string, body: string | Blob | AsyncIterable<Buffer>) => {
          let text = "";
          if (typeof body === "string") text = body;
          else if (body instanceof Blob) text = await body.text();
          else for await (const part of body) text += part.toString();
          state.objects.set(p, text);
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  state.client = client;
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});
async function setup(date: string, installed: boolean) {
  const f = operationalFixture();
  const csv =
    date === "2026-10-16"
      ? f.csv
          .split("\n")
          .filter((l) => !l.includes("2026-10-19"))
          .join("\n")
      : f.csv;
  const validation = await validateSourceText(csv, "synthetic.csv");
  const source = {
    id: "synthetic-source",
    original_filename: "synthetic.csv",
    storage_bucket: "cloudtrend-data",
    storage_path: "00000000-0000-4000-8000-000000000001/source.csv",
    file_hash: `sha256:${hash(csv)}`,
    data_hash: validation.dataHash,
    schema_hash: validation.schemaHash,
    min_date: validation.stats.minDate,
    max_date: date,
    activated_at: "2026-10-19T11:00:00Z",
    created_at: "2026-10-19T11:00:00Z",
  };
  state.sources = [source];
  state.objects.set(source.storage_path, csv);
  state.installed = installed;
  state.artifact = installed ? JSON.stringify(f.artifact) : null;
  state.inputs = [
    {
      id: source.id,
      text: validation.canonicalCsv,
      validation,
      fileName: "synthetic.csv",
      savedAt: source.created_at,
      bytes: csv.length,
      fileHash: source.file_hash,
      dataHash: validation.dataHash,
      schemaHash: validation.schemaHash,
      sourceRecord: source,
    },
  ];
  state.dataset = { ...f.ds, asOfDate: date };
}
const matrix = [false, true].flatMap((enabled) =>
  ["2026-10-16", "2026-10-19"].flatMap((date) =>
    [false, true].map((installed) => ({ enabled, date, installed })),
  ),
);
describe("actual synthetic ingress paths, no external writes", () => {
  it.each(matrix)(
    "web and Actions -> browser: $enabled $date $installed",
    async ({ enabled, date, installed }) => {
      state.enabled = enabled;
      await setup(date, installed);
      const result = await runWebScreeningForUser(
        client,
        "00000000-0000-4000-8000-000000000001",
        DEFAULT_SCORING_CONFIG,
      );
      const web = await readScreeningCache();
      expect(web).not.toBeNull();
      expect(await readDashboardCache()).toMatchObject({
        inputFingerprint: result.inputFingerprint,
        resultDigest: result.resultDigest,
      });
      const meta = savedOperationalIdentity(web!.payload.analysis);
      expect(Boolean(meta)).toBe(enabled && installed && date >= "2026-10-19");
      const original = state.webShadow.mock.calls[0]![0];
      expect(original.analysis.operationalIndex).toBeUndefined();
      const frozenDataset = stableCacheJson(original.dataset);
      const frozenEngine = stableCacheJson(deterministicAnalysis(original.analysis));
      await runScreening([
        "--supabase-user-id",
        "00000000-0000-4000-8000-000000000001",
        "--output",
        dir,
        "--upload",
      ]);
      const actions = await readScreeningCache();
      expect(actions).not.toBeNull();
      expect(actions!.resultDigest).toBe(web!.resultDigest);
      expect(actions!.inputFingerprint).toBe(web!.inputFingerprint);
      expect(deterministicAnalysis(actions!.payload.analysis)).toEqual(
        deterministicAnalysis(web!.payload.analysis),
      );
      expect(state.cliShadow.mock.calls[0]![0].dataset).toEqual(original.dataset);
      expect(stableCacheJson(original.dataset)).toBe(frozenDataset);
      expect(
        stableCacheJson(
          deterministicAnalysis(
            runFullMarketAnalysis(original.dataset, DEFAULT_SCORING_CONFIG).analysis,
          ),
        ),
      ).toBe(frozenEngine);
      expect(
        cliFingerprint(state.inputs as LoadedSourceInput[], DEFAULT_SCORING_CONFIG, meta),
      ).toBe(result.inputFingerprint);
      expect(await currentInputFingerprint(meta)).toBe(result.inputFingerprint);
    },
  );
  it("actual-data diagnostic also traverses canonical Actions ingress without writes", async () => {
    await setup("2026-10-16", true);
    const before = [...state.objects];
    const report = await compareOperationalIndex(
      client,
      "00000000-0000-4000-8000-000000000001",
      "2026-10-19T12:00:00Z",
      DEFAULT_SCORING_CONFIG,
    );
    expect(report.ingressComparison).toMatchObject({
      resultDigestMatched: true,
      inputFingerprintMatched: true,
      firstNewSessionVerified: false,
    });
    expect(report.writesPerformed).toBe(0);
    expect([...state.objects]).toEqual(before);
    expect(state.webShadow).not.toHaveBeenCalled();
    expect(state.cliShadow).not.toHaveBeenCalled();
  });
  it("local legacy calculation remains available to an uninstalled owner when ON", async () => {
    state.enabled = true;
    await setup("2026-10-19", false);
    state.localCompute.mockReturnValue({
      analysis: runFullMarketAnalysis(state.dataset as never).analysis,
      source: {},
    });
    await buildAndPersistScreeningCaches();
    expect(state.localCompute).toHaveBeenCalledOnce();
    expect(
      savedOperationalIdentity((await readScreeningCache())!.payload.analysis),
    ).toBeUndefined();
  });
  it("local installed owner is blocked before computing even without a previous cache", async () => {
    state.enabled = true;
    await setup("2026-10-19", true);
    await expect(buildAndPersistScreeningCaches()).rejects.toThrow("서버 스크리닝");
    expect(state.localCompute).not.toHaveBeenCalled();
  });
  it.each(["missing", "corrupt"])("installed %s blocks before any publication", async (kind) => {
    state.enabled = true;
    await setup("2026-10-19", true);
    if (kind === "missing") state.artifact = null;
    else state.corruption = true;
    const before = [...state.objects];
    await expect(
      runWebScreeningForUser(
        client,
        "00000000-0000-4000-8000-000000000001",
        DEFAULT_SCORING_CONFIG,
      ),
    ).rejects.toThrow();
    expect([...state.objects]).toEqual(before);
    expect(state.webShadow).not.toHaveBeenCalled();
    expect(state.snapshot).not.toHaveBeenCalled();
  });
  it("restores saved provider and fingerprint after rollback; local cannot overwrite", async () => {
    state.enabled = true;
    await setup("2026-10-19", true);
    const result = await runWebScreeningForUser(
      client,
      "00000000-0000-4000-8000-000000000001",
      DEFAULT_SCORING_CONFIG,
    );
    state.enabled = false;
    const saved = await readScreeningCache();
    expect(saved).not.toBeNull();
    const restored = (await getInstrumentChartForSession({
      ...result,
      accessToken: "synthetic-token-long-enough",
      config: DEFAULT_SCORING_CONFIG,
      symbol: "360750",
      range: "120",
      kind: "etf",
    })) as unknown as { operationalIndex: { version: string }; analysis: unknown };
    expect(restored.operationalIndex.version).toBe(OPERATIONAL_INDEX_VERSION);
    expect(restored.analysis).toEqual(saved!.payload.analysis);
    const before = [...state.objects];
    await expect(buildAndPersistScreeningCaches()).rejects.toThrow("서버 스크리닝");
    expect(state.localCompute).not.toHaveBeenCalled();
    expect(state.localSnapshot).not.toHaveBeenCalled();
    expect([...state.objects]).toEqual(before);
  });
  it("rejects unknown saved provider and original mismatch on restoration", async () => {
    state.enabled = true;
    await setup("2026-10-19", true);
    await runWebScreeningForUser(
      client,
      "00000000-0000-4000-8000-000000000001",
      DEFAULT_SCORING_CONFIG,
    );
    const saved = (await readScreeningCache())!;
    const metadata = savedOperationalIdentity(saved.payload.analysis)!;
    state.enabled = false;
    state.corruption = true;
    await expect(
      loadOperationalIndex(
        client,
        "00000000-0000-4000-8000-000000000001",
        state.dataset as never,
        "2026-10-19T12:00:00Z",
        false,
        metadata,
      ),
    ).rejects.toThrow("해시");
    expect(() =>
      savedOperationalIdentity({
        asOfDate: "2026-10-19",
        operationalIndex: { ...metadata, version: "future" },
      }),
    ).toThrow();
    expect(inputFingerprint(state.sources as never, DEFAULT_SCORING_CONFIG)).not.toBe(
      saved.inputFingerprint,
    );
  });
});
