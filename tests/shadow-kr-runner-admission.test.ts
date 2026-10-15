import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKospiShadow } from "../scripts/run-kospi-shadow";
import type { ShadowObjectStore } from "../src/lib/kospiShadowStore";

vi.mock("../scripts/verify-kospi-shadow-runtime", () => ({
  verifyKospiShadowRuntimeManifest: vi.fn(async () => ({})),
}));

vi.mock("../scripts/verify-shadow-runtime-manifests", () => ({
  verifyShadowRuntimeManifests: vi.fn(async () => ({})),
}));

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  client: vi.fn(),
  build: vi.fn(),
  persist: vi.fn(),
  openRevision: vi.fn(),
  initializeRevision: vi.fn(),
}));
vi.mock("../scripts/analysis-run-store", () => ({
  ANALYSIS_BUCKET: "cloudtrend-data",
  codeVersion: () => "test-code",
  sha256: () => "test-hash",
  stableJson: JSON.stringify,
  trustedSupabaseClient: mocks.client,
}));
vi.mock("../scripts/source-registry-store", () => ({ loadAnalysisSourceInputs: mocks.load }));
vi.mock("../src/lib/engine/manualDataset", () => ({
  parseManualMarketData: () => ({ dataset: { asOfDate: "2026-10-14" } }),
}));
vi.mock("../src/lib/engine/kospiShadowDataset", () => ({ buildKospiShadowSession: mocks.build }));
vi.mock("../src/lib/kospiShadowStore", () => ({
  persistKospiShadow: mocks.persist,
  shadowObjectPath: (uid: string, suffix: string) => `${uid}/shadow/fixture/${suffix}`,
}));
vi.mock("../src/lib/kospiShadowSeries", () => ({
  KOSPI_SHADOW_CORRECTION_REVISION_ID: "october14-retrospective-v1",
  openKospiShadowRevisionStore: mocks.openRevision,
  initializeKospiShadowRevision: mocks.initializeRevision,
  kospiShadowRevisionPath: (uid: string, suffix: string) =>
    `${uid}/shadow/fixture/revisions/october14-retrospective-v1/${suffix}`,
  validateKospiShadowRevision: (value: unknown) => value,
}));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.openRevision.mockResolvedValue({});
  mocks.client.mockReturnValue({});
  vi.useFakeTimers();
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_WORKFLOW", "KOSPI prospective Shadow");
  vi.stubEnv("GITHUB_REF", "refs/heads/main");
  vi.stubEnv("SUPABASE_USER_ID", "11111111-1111-4111-8111-111111111111");
  process.argv = ["node", "run-kospi-shadow.ts"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function source(activatedAt: string) {
  mocks.load.mockResolvedValue([
    {
      text: "synthetic",
      dataHash: "source-hash",
      sourceRecord: { max_date: "2026-10-14", activated_at: activatedAt },
    },
  ]);
}

function originalSource(id: string, maxDate: string, activatedAt: string) {
  return {
    id,
    min_date: maxDate,
    max_date: maxDate,
    activated_at: activatedAt,
    created_at: activatedAt,
  };
}

function compactedSource(originals: unknown[]) {
  mocks.load.mockResolvedValue([
    {
      text: "synthetic",
      dataHash: "source-hash",
      savedAt: "2026-10-14T23:49:00Z",
      sourceRecord: {
        id: "physical-compaction",
        max_date: "2026-10-14",
        activated_at: "2026-10-14T23:49:00Z",
        created_at: "2026-10-14T23:49:00Z",
        validation_result: { screeningCompaction: { original_source_evidence: originals } },
      },
    },
  ]);
  vi.setSystemTime("2026-10-14T23:50:00Z");
}

describe("prospective KOSPI runner live-source admission", () => {
  it("keeps a midnight evening source preview-only without calculating or writing a session", async () => {
    source("2026-10-14T15:03:09.077298Z");
    vi.setSystemTime("2026-10-14T15:12:47.652Z");
    await runKospiShadow();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status":"PREVIEW_ONLY"'));
  });

  it("requires refreshed source evidence even when a retry runs in the morning", async () => {
    source("2026-10-14T15:03:09.077298Z");
    vi.setSystemTime("2026-10-14T23:50:00Z");
    await runKospiShadow();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("does not promote an evening source when its physical compaction is activated in the morning", async () => {
    compactedSource([
      originalSource("evening-source", "2026-10-14", "2026-10-14T15:03:09.077298Z"),
    ]);
    await runKospiShadow();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status":"PREVIEW_ONLY"'));
  });

  it("does not use a morning origin for another close date to promote the current evening source", async () => {
    compactedSource([
      originalSource("current-evening", "2026-10-14", "2026-10-14T15:03:09.077298Z"),
      originalSource("older-close-reupload", "2026-10-13", "2026-10-14T23:48:00Z"),
    ]);
    await runKospiShadow();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("requires original lineage for the dataset close, not just the physical compacted max_date", async () => {
    compactedSource([originalSource("older-close-reupload", "2026-10-13", "2026-10-14T23:48:00Z")]);
    await expect(runKospiShadow()).rejects.toThrow(
      "No registered source declares the requested close date",
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("rejects missing compaction lineage rather than falling back to physical activation", async () => {
    compactedSource([]);
    await expect(runKospiShadow()).rejects.toThrow(
      "original_source_evidence must be a nonempty array",
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("uses the original morning timestamp, not the later compaction activation", async () => {
    const collectedAt = "2026-10-14T23:30:00Z";
    compactedSource([originalSource("morning-source", "2026-10-14", collectedAt)]);
    mocks.build.mockReturnValue({ date: "2026-10-14" });
    mocks.persist.mockRejectedValueOnce(new Error("immutable-store-sentinel"));
    await expect(runKospiShadow()).rejects.toThrow("immutable-store-sentinel");
    expect(mocks.build).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ sourceCollectedAt: collectedAt }),
      "2026-10-14",
    );
  });

  it("cannot apply a newer exact-date dataset to an older as-of assertion", async () => {
    source("2026-10-14T23:48:03.687779Z");
    process.argv.push("--as-of", "2026-10-13");
    await expect(runKospiShadow()).rejects.toThrow(
      "Publishing requires an exact-date source snapshot",
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("allows actual morning evidence into the unchanged immutable store", async () => {
    source("2026-10-14T23:48:03.687779Z");
    vi.setSystemTime("2026-10-14T23:57:37.501Z");
    const session = { date: "2026-10-14" };
    mocks.build.mockReturnValue(session);
    mocks.persist.mockRejectedValueOnce(
      new Error("Completed Shadow date is immutable (input/config mismatch)"),
    );
    await expect(runKospiShadow()).rejects.toThrow("Completed Shadow date is immutable");
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      "11111111-1111-4111-8111-111111111111",
      session,
      expect.any(Object),
    );
  });
});

describe("KOSPI correction namespace routing", () => {
  const uid = "11111111-1111-4111-8111-111111111111";
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const approval = {
    revisionId: "october14-retrospective-v1",
    predecessorDate: "2026-10-13",
    correctionDate: "2026-10-14",
    expectedPredecessorHash: digest("1"),
    expectedOriginalTargetHash: digest("2"),
    expectedCorrectedSourceHash: digest("3"),
  };
  const session = {
    date: "2026-10-14",
  } as import("../src/lib/engine/kospiShadow").KospiShadowSession;
  const store = (approved: unknown = approval, existing: unknown = null): ShadowObjectStore => ({
    read: vi.fn(async (path: string) =>
      path.includes("correction-approvals") ? approved : existing,
    ) as ShadowObjectStore["read"],
    putImmutable: vi.fn(async () => {}),
    putLatest: vi.fn(async () => {}),
    latestSessionDate: vi.fn(async () => null),
  });
  it("holds future publication when the revision is absent instead of using the original namespace", async () => {
    const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
    mocks.openRevision.mockRejectedValueOnce(new Error("Revision incomplete"));
    await expect(
      publishKospiShadowTarget(store(), uid, session, {}, "2026-10-15T01:00:00Z", false),
    ).rejects.toThrow("Revision incomplete");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.initializeRevision).not.toHaveBeenCalled();
  });
  it("uses only the mapped revision store for ordinary future persistence", async () => {
    const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
    const mapped = { marker: "revision" };
    mocks.openRevision.mockResolvedValueOnce(mapped);
    await publishKospiShadowTarget(store(), uid, session, {}, "2026-10-15T01:00:00Z", false);
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(mapped, uid, session, {});
    expect(mocks.initializeRevision).not.toHaveBeenCalled();
  });
  it.each(["schedule", "workflow_run", "push"])(
    "rejects automatic bootstrap event %s",
    async (event) => {
      const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
      vi.stubEnv("GITHUB_EVENT_NAME", event);
      const s = store();
      await expect(
        publishKospiShadowTarget(s, uid, session, {}, "2026-10-15T01:00:00Z", true),
      ).rejects.toThrow("explicit manual");
      expect(s.read).not.toHaveBeenCalled();
      expect(mocks.initializeRevision).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { ...approval, arbitraryPath: "elsewhere" },
    { ...approval, revisionId: "unreviewed" },
  ])("rejects missing or broadened private approval", async (approved) => {
    const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    await expect(
      publishKospiShadowTarget(store(approved), uid, session, {}, "2026-10-15T01:00:00Z", true),
    ).rejects.toThrow("private KOSPI correction approval");
    expect(mocks.initializeRevision).not.toHaveBeenCalled();
  });
  it("passes exact private identities and actual calculation time to explicit bootstrap", async () => {
    const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    vi.setSystemTime("2026-10-15T02:00:00Z");
    const s = store();
    await publishKospiShadowTarget(s, uid, session, {}, "2026-10-15T01:00:00Z", true);
    expect(mocks.initializeRevision).toHaveBeenCalledExactlyOnceWith(
      s,
      uid,
      session,
      {},
      { ...approval, computedAt: "2026-10-15T01:00:00Z" },
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("reuses immutable calculation time on partial bootstrap retry", async () => {
    const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    vi.setSystemTime("2026-10-15T02:00:00Z");
    const s = store(approval, {
      ...approval,
      correctedSourceHash: approval.expectedCorrectedSourceHash,
      computedAt: "2026-10-15T00:50:00Z",
    });
    await publishKospiShadowTarget(s, uid, session, {}, "2026-10-15T01:00:00Z", true);
    expect(mocks.initializeRevision).toHaveBeenCalledWith(
      s,
      uid,
      session,
      {},
      { ...approval, computedAt: "2026-10-15T00:50:00Z" },
    );
  });
  it("rejects changed approval on bootstrap retry", async () => {
    const { publishKospiShadowTarget } = await import("../scripts/run-kospi-shadow");
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    const s = store(approval, {
      ...approval,
      correctedSourceHash: digest("4"),
      computedAt: "2026-10-15T00:50:00Z",
    });
    await expect(
      publishKospiShadowTarget(s, uid, session, {}, "2026-10-15T01:00:00Z", true),
    ).rejects.toThrow("approval changed");
    expect(mocks.initializeRevision).not.toHaveBeenCalled();
  });
  it("rejects preview bootstrap before source or storage access", async () => {
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    process.argv.push("--dry-run", "--initialize-correction", "--as-of", "2026-10-14");
    await expect(runKospiShadow()).rejects.toThrow("not a preview");
    expect(mocks.load).not.toHaveBeenCalled();
  });
});

describe("explicit retrospective correction CLI date", () => {
  it.each([
    [],
    ["--as-of"],
    ["--as-of", ""],
    ["--as-of", " "],
    ["--as-of", "2026-10-13"],
    ["--as-of", "2026-10-15"],
    ["--as-of", "--user"],
    ["--as-of=2026-10-14"],
    ["--as-of", "2026-10-14", "--as-of", "2026-10-14"],
  ])("rejects missing or ambiguous exact date %j before private access", async (...args) => {
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    process.argv.push("--initialize-correction", ...args);
    await expect(runKospiShadow()).rejects.toThrow("explicitly supplied --as-of 2026-10-14");
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.initializeRevision).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("allows the explicitly supplied exact date to reach the separately guarded private loader", async () => {
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    process.argv.push("--initialize-correction", "--as-of", "2026-10-14");
    mocks.load.mockRejectedValueOnce(new Error("private-loader-sentinel"));
    await expect(runKospiShadow()).rejects.toThrow("private-loader-sentinel");
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.initializeRevision).not.toHaveBeenCalled();
  });
});
