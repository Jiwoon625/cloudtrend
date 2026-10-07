import {
  screeningPublicationPath,
  screeningPublicationReceipt,
} from "../src/lib/screeningPublication.server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import {
  SCREENING_CACHE_VERSION,
  stableCacheJson,
  deterministicAnalysis,
} from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  analyze: vi.fn(),
  shadow: vi.fn(),
  persist: vi.fn(),
  portfolio: vi.fn(),
  parse: vi.fn(),
  prices: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ inputValidator: () => ({ handler: (fn: unknown) => fn }) }),
}));
vi.mock("../src/lib/screeningSources.server", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningSources.server")>()),
  listActiveSources: mocks.list,
  loadActiveSources: mocks.load,
}));
vi.mock("../src/lib/engine/manualDataset", () => ({ parseManualMarketData: mocks.parse }));
vi.mock("../src/lib/engine/fullMarketAnalysis", () => ({ runFullMarketAnalysis: mocks.analyze }));
vi.mock("../src/lib/onsetProfile", () => ({ withOnsetProfiles: (analysis: unknown) => analysis }));
vi.mock("../src/lib/octoberShadowPublication.server", () => ({
  recordWebOctoberShadow: mocks.shadow,
}));
vi.mock("../src/lib/screeningSnapshot", () => ({
  buildSnapshot: (analysis: AnalysisResult, sourceRegisteredAt: string) => ({
    date: analysis.asOfDate,
    asOfDate: analysis.asOfDate,
    savedAt: analysis.calculatedAt,
    sourceRegisteredAt,
    entries: [],
  }),
  latestSourceRegistration: () => "2026-10-06T23:52:20Z",
  persistScreeningSnapshot: mocks.persist,
}));
vi.mock("../src/lib/portfolioLedgers.server", () => ({
  refreshPortfolioAfterScreening: mocks.portfolio,
}));
vi.mock("../src/lib/instrumentChartStore.server", () => ({
  primeChartContext: vi.fn(),
  publishRecentPrices: mocks.prices,
}));
vi.mock("../src/lib/screeningCacheContract", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningCacheContract")>()),
  buildDashboardSummary: (
    analysis: AnalysisResult,
    inputFingerprint: string,
    resultDigest: string,
  ) => ({ asOfDate: analysis.asOfDate, inputFingerprint, resultDigest }),
}));
import { inputFingerprint } from "../src/lib/screeningSources.server";
import { runWebScreeningForUser } from "../src/lib/webScreening.functions";
const analysis = {
  asOfDate: "2026-10-06",
  calculatedAt: "2026-10-06T23:57:22Z",
  rows: [],
} as unknown as AnalysisResult;
const sources = [
  {
    id: "source",
    data_hash: "data",
    schema_hash: "schema",
    file_hash: "file",
    activated_at: "2026-10-06T23:52:20Z",
  },
] as never;
let objects: Map<string, unknown>;
let client: SupabaseClient;
let beforeDownload: ((path: string) => void) | null = null;
beforeEach(() => {
  vi.resetAllMocks();
  objects = new Map();
  beforeDownload = null;
  client = {
    storage: {
      from: () => ({
        download: async (path: string) => {
          beforeDownload?.(path);
          return objects.has(path)
            ? { data: new Blob([JSON.stringify(objects.get(path))]), error: null }
            : { data: null, error: { message: "Object not found" } };
        },
        upload: async (path: string, body: Blob) => {
          objects.set(path, JSON.parse(await body.text()));
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  mocks.list.mockResolvedValue(sources);
  mocks.load.mockResolvedValue({ sources, texts: ["verified source"] });
  mocks.parse.mockReturnValue({ dataset: {} });
  mocks.analyze.mockReturnValue({ analysis, dataset: {} });
  mocks.shadow.mockResolvedValue({ status: "UP_TO_DATE" });
  mocks.portfolio.mockResolvedValue({
    status: "UPDATED",
    asOfDate: "2026-10-06",
    calculatedAt: "2026-10-07T00:00:00Z",
  });
});
function cache(complete = true) {
  const fingerprint = inputFingerprint(sources, DEFAULT_SCORING_CONFIG);
  const digest = createHash("sha256")
    .update(stableCacheJson(deterministicAnalysis(analysis)))
    .digest("hex");
  const publicationId = "synthetic-publication";
  objects.set("owner/cache/screening/latest.json", {
    publicationId,
    version: SCREENING_CACHE_VERSION,
    inputFingerprint: fingerprint,
    resultDigest: digest,
    payload: { analysis },
  });
  objects.set("owner/cache/dashboard/latest.json", {
    inputFingerprint: fingerprint,
    resultDigest: digest,
  });
  if (complete)
    objects.set(
      screeningPublicationPath("owner", {
        inputFingerprint: fingerprint,
        resultDigest: digest,
        publicationId,
      }),
      screeningPublicationReceipt({
        inputFingerprint: fingerprint,
        resultDigest: digest,
        publicationId,
      }),
    );
}
describe("screening publication and portfolio refresh", () => {
  it("unchanged verified screening reuses results without source download, engine calculation, or shadow replay", async () => {
    cache();
    const result = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
    expect(result.reused).toBe(true);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.shadow).not.toHaveBeenCalled();
    expect(mocks.portfolio).toHaveBeenCalledExactlyOnceWith(client, "owner");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("publishes changed input history before refreshing portfolio with verified sources", async () => {
    const result = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
    expect(result.reused).toBe(false);
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.portfolio.mock.invocationCallOrder[0]!,
    );
    expect(mocks.portfolio).toHaveBeenCalledWith(client, "owner", {
      sources,
      texts: ["verified source"],
    });
    expect(mocks.persist.mock.calls[0]![2].sourceRegisteredAt).toBe("2026-10-06T23:52:20Z");
    expect(result.portfolioRefresh).toEqual({
      status: "UPDATED",
      asOfDate: "2026-10-06",
      calculatedAt: "2026-10-07T00:00:00Z",
    });
    expect(objects.get(screeningPublicationPath("owner", result))).toMatchObject(
      screeningPublicationReceipt(result),
    );
    await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
  });
  it("does not reuse a partial publication after a prior shadow or portfolio failure", async () => {
    cache(false);
    mocks.persist.mockRejectedValueOnce(new Error("history failed"));
    await expect(runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG)).rejects.toThrow(
      "history failed",
    );
    expect(mocks.portfolio).not.toHaveBeenCalled();
    expect(objects.get("owner/cache/screening/latest.json")).not.toHaveProperty(
      "publicationVersion",
    );
    await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  it("coalesces duplicate screening requests", async () => {
    await Promise.all([
      runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG),
      runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG),
    ]);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
    expect(mocks.portfolio).toHaveBeenCalledTimes(1);
  });
  it("changing strategy config invalidates cached screening", async () => {
    cache();
    await runWebScreeningForUser(client, "owner", {
      ...DEFAULT_SCORING_CONFIG,
      technicalWeight: 0.5,
    } as typeof DEFAULT_SCORING_CONFIG);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
  });
});

it("changed calculation runtime invalidates an otherwise identical screening receipt", async () => {
  cache();
  const receiptPath = [...objects.keys()].find((path) => path.includes("/publications/"))!;
  objects.set(receiptPath, {
    ...(objects.get(receiptPath) as object),
    calculationVersion: "sha256:old-runtime",
  });
  const result = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
  expect(result.reused).toBe(false);
  expect(mocks.load).toHaveBeenCalledTimes(1);
});
it("isolates simultaneous owners with identical source fingerprints", async () => {
  await Promise.all([
    runWebScreeningForUser(client, "owner-a", DEFAULT_SCORING_CONFIG),
    runWebScreeningForUser(client, "owner-b", DEFAULT_SCORING_CONFIG),
  ]);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(mocks.analyze).toHaveBeenCalledTimes(2);
  expect(mocks.portfolio.mock.calls.map((call) => call[1]).sort()).toEqual(["owner-a", "owner-b"]);
  expect(objects.has("owner-a/cache/screening/latest.json")).toBe(true);
  expect(objects.has("owner-b/cache/screening/latest.json")).toBe(true);
});
it("a late older completion never overwrites a newer screening generation", async () => {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.prices
    .mockImplementationOnce(() => {
      started();
      return held;
    })
    .mockResolvedValue(undefined);
  const old = runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG).catch(
    (error: Error) => error,
  );
  await ready;
  const next = await runWebScreeningForUser(client, "owner", {
    ...DEFAULT_SCORING_CONFIG,
    technicalWeight: 0.5,
  } as typeof DEFAULT_SCORING_CONFIG);
  release();
  expect(await old).toBeInstanceOf(Error);
  expect(objects.get("owner/cache/screening/latest.json")).toMatchObject({
    inputFingerprint: next.inputFingerprint,
  });
  expect(objects.get("owner/cache/dashboard/latest.json")).toMatchObject({
    inputFingerprint: next.inputFingerprint,
  });
  expect([...objects.keys()].filter((path) => path.includes("/publications/"))).toHaveLength(1);
});
it("a private portfolio failure leaves independent Shadow published and reports only sanitized partial status", async () => {
  mocks.portfolio.mockRejectedValue(new Error("private journal account data"));
  const result = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
  expect(mocks.shadow).toHaveBeenCalledTimes(1);
  expect(result.portfolioRefresh).toEqual({ status: "FAILED", asOfDate: null, calculatedAt: null });
  expect(JSON.stringify(result)).not.toContain("private journal");
  expect([...objects.keys()].filter((path) => path.includes("/publications/"))).toHaveLength(0);
});

it("receipt identity ignores extra cache payload, timestamps and CLI upload metadata", () => {
  const identity = {
    inputFingerprint: "input",
    resultDigest: "result",
    publicationId: "generation",
  };
  const full = {
    ...identity,
    createdAt: "volatile",
    payload: { analysis },
    paths: { private: "path" },
  };
  expect(screeningPublicationPath("owner", full)).toBe(screeningPublicationPath("owner", identity));
  expect(screeningPublicationReceipt(full)).toEqual(screeningPublicationReceipt(identity));
  expect(screeningPublicationReceipt(full)).not.toHaveProperty("payload");
});

it("cached screening survives a sanitized portfolio failure without replaying the screen", async () => {
  cache();
  mocks.portfolio.mockRejectedValue(new Error("private journal detail"));
  const result = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
  expect(result.reused).toBe(true);
  expect(result.portfolioRefresh.status).toBe("FAILED");
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.analyze).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private journal");
});
it("an old A receipt cannot bless a failed new A publication after B", async () => {
  const firstA = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
  await runWebScreeningForUser(client, "owner", {
    ...DEFAULT_SCORING_CONFIG,
    technicalWeight: 0.5,
  } as typeof DEFAULT_SCORING_CONFIG);
  mocks.persist.mockRejectedValueOnce(new Error("history failed"));
  await expect(runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG)).rejects.toThrow(
    "history failed",
  );
  const failed = objects.get("owner/cache/screening/latest.json") as typeof firstA;
  expect(failed.publicationId).not.toBe(firstA.publicationId);
  expect(objects.has(screeningPublicationPath("owner", failed))).toBe(false);
  const retried = await runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG);
  expect(retried.reused).toBe(false);
  expect(mocks.persist).toHaveBeenCalledTimes(4);
});
it("completion receipts stay in the existing authenticated owner results JSON scope", () => {
  const path = screeningPublicationPath("owner", {
    inputFingerprint: "input",
    resultDigest: "result",
    publicationId: "generation",
  });
  expect(path).toMatch(/^owner\/results\/screening\/publications\/[a-f0-9]{64}\.json$/);
  expect(path.split("/").slice(0, 3)).toEqual(["owner", "results", "screening"]);
});

it("a newer generation during receipt lookup fails visibly without overwriting history", async () => {
  cache();
  beforeDownload = (path) => {
    if (!path.includes("/publications/")) return;
    beforeDownload = null;
    objects.set("owner/cache/screening/latest.json", {
      ...(objects.get("owner/cache/screening/latest.json") as object),
      publicationId: "newer-generation",
    });
  };
  await expect(runWebScreeningForUser(client, "owner", DEFAULT_SCORING_CONFIG)).rejects.toThrow(
    "재사용 확인 중",
  );
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.portfolio).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.analyze).not.toHaveBeenCalled();
  expect(objects.get("owner/cache/screening/latest.json")).toMatchObject({
    publicationId: "newer-generation",
  });
});
