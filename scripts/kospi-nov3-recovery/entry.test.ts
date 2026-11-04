/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
const fake = vi.hoisted(() => ({
  baseline: {} as any,
  info: {} as any,
  inventory: [] as string[],
  archive: [] as any[],
}));
vi.mock("../kr-final-retrospective/transport", async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    snapshot: vi.fn(async () => structuredClone(fake.baseline)),
    legacyInventory: async () => structuredClone(fake.inventory),
    reader: () => ({
      info: async () => structuredClone(fake.info),
      rows: async (table: string) =>
        structuredClone(table === "analysis_source_files" ? fake.baseline.sources : fake.archive),
    }),
  };
});
import {
  boundedFetch,
  assertWorkflow,
  verifyWriterManifest,
  validateCapsule,
  validateJournalWrite,
  assertFresh,
  WORKFLOW,
} from "./entry";
const H = (v: any) => captureCanonicalProof(v).hash;
const owner = "00000000-0000-0000-0000-000000000001";
const root = owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1";
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW: WORKFLOW,
  RECOVERY_CONCURRENCY_GROUP: "kospi-prospective-shadow",
  GITHUB_SHA: "a".repeat(40),
  RECOVERY_MODE: "VALIDATE",
  EXPECTED_CAPSULE_HASH: H("capsule"),
  EXPECTED_APPROVAL_HASH: H("approval"),
};
function capsule() {
  const rows = [
    {
      user_id: owner,
      source_type: "screening",
      status: "active",
      storage_bucket: "cloudtrend-data",
      storage_path: owner + "/source/screening/source.csv",
      file_hash: H("raw bytes"),
    },
  ];
  const generation = {
    id: "object",
    version: "version",
    eTag: "etag",
    size: 10,
    updatedAt: "2026-11-04T02:15:00.000Z",
  };
  const c: any = {
    version: "kospi-nov3-recovery-capsule-v1",
    owner,
    sourceRows: rows,
    sourceObjectPins: [{ path: rows[0]!.storage_path, hash: rows[0]!.file_hash, generation }],
    input: {
      authority: {
        owner,
        predecessorDate: "2026-11-02",
        targetDates: ["2026-11-03"],
        sourceManifestHash: H(rows),
      },
      capturedObjects: [
        { path: root + "/latest.json", hash: H("latest"), payload: { synthetic: true } },
        { path: root + "/sessions/2026-11-02.json", hash: H("29"), payload: { synthetic: true } },
      ],
      generationPins: [
        { path: root + "/latest.json", generation },
        { path: root + "/sessions/2026-11-02.json", generation },
      ],
    },
    priorRecoveryRefs: {
      capsuleHash: "sha256:7b4f3d5a2984e4091b7d6a01211ade5d8877c3f1f737b3d1030848845f4ccfcc",
      planHash: "sha256:aafc077261a8679574f7abce520516dea36efe835da0d75a789dcb4adba05057",
      approvalHash: "sha256:c32a5bd7cfaca0e04612d2f7dc53736e7f676ee43c7b2d7373bfb0ef5e045f9a",
      completionHash: "sha256:b12096b28b1923b0159f9a6fe8c312ff3dbbc56b131ae484e9ca39052ee45f55",
    },
    result: {
      status: "PROVEN_NOV3_RETROSPECTIVE_CONTINUATION",
      snapshots: [{ date: "2026-11-03" }],
      projections: [{ head: "2026-11-03" }],
    },
  };
  c.input.authority.adjustedBasisHash = H("dataset");
  c.input.authority.adjustedCapturedAt = "2026-11-04T03:45:00Z";
  c.materialization = {
    version: "kospi-nov3-readonly-capture-v1",
    owner,
    historicalAvailabilityClaim: false,
    sourceRowsHash: H(c.sourceRows),
    sourceObjectPinsHash: H(c.sourceObjectPins),
    journalHash: H(c.input.capturedObjects),
    generationPinsHash: H(c.input.generationPins),
    datasetHash: c.input.authority.adjustedBasisHash,
    capturedAt: c.input.authority.adjustedCapturedAt,
    publication: { phase: "FINAL", asOfDate: "2026-11-03" },
  };
  c.input.authority.captureManifestHash = H(c.materialization);
  return c;
}
beforeEach(() => {
  const c = capsule();
  fake.baseline = {
    sources: c.sourceRows,
    models: [{ synthetic: 1 }],
    actual: { synthetic: 1 },
    registries: [{ synthetic: 1 }],
  };
  fake.inventory = c.input.capturedObjects.map((x: any) => x.path);
  fake.info = {
    id: "object",
    version: "version",
    eTag: "etag",
    size: 10,
    updated_at: "2026-11-04T02:15:00Z",
  };
  fake.archive = [{ source_id: "synthetic", source_revision: "1", payload: { synthetic: true } }];
});
it("admits only explicit manual main workflow with exact hash inputs", () => {
  expect(() => assertWorkflow(env)).not.toThrow();
});
it.each([
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_WORKFLOW",
  "RECOVERY_CONCURRENCY_GROUP",
  "GITHUB_SHA",
  "RECOVERY_MODE",
  "EXPECTED_CAPSULE_HASH",
  "EXPECTED_APPROVAL_HASH",
])("rejects changed %s", (key) => {
  expect(() => assertWorkflow({ ...env, [key]: "wrong" })).toThrow();
});
it("binds every writer source byte and manifest identity", () => {
  const bytes = Buffer.from("synthetic");
  const base = {
    version: "kospi-nov3-writer-v1",
    files: { "scripts/example.ts": "sha256:" + createHash("sha256").update(bytes).digest("hex") },
  };
  const m = { ...base, hash: H(base) };
  expect(verifyWriterManifest(m, () => bytes)).toBe(m.hash);
  expect(() => verifyWriterManifest(m, () => Buffer.from("modified"))).toThrow();
  expect(() => verifyWriterManifest({ ...m, hash: H("wrong") }, () => bytes)).toThrow();
});
it("capsule verifies ordered full rows, raw hashes and exact previous recovery refs", () => {
  expect(() => validateCapsule(capsule(), owner)).not.toThrow();
});
it.each([
  "owner",
  "order",
  "rawHash",
  "generation",
  "oldApproval",
  "targets",
  "embeddedPrior",
  "manifest",
  "manifestRehashed",
])("capsule rejects %s", (kind) => {
  const c: any = capsule();
  if (kind === "owner") c.owner = "other";
  if (kind === "order") c.sourceRows[0].status = "inactive";
  if (kind === "rawHash") c.sourceObjectPins[0].hash = H("wrong");
  if (kind === "generation") c.sourceObjectPins[0].generation.updatedAt = "yesterday";
  if (kind === "oldApproval") c.priorRecoveryRefs.approvalHash = H("other");
  if (kind === "targets") c.input.authority.targetDates = ["2026-11-02"];
  if (kind === "embeddedPrior") c.input.priorRecovery = {};
  if (kind === "manifest") c.materialization.datasetHash = H("changed");
  if (kind === "manifestRehashed") {
    c.materialization.generationPinsHash = H("changed");
    c.input.authority.captureManifestHash = H(c.materialization);
  }
  expect(() => validateCapsule(c, owner)).toThrow();
});
it("write allowlist permits only one matching snapshot and matching latest projections", () => {
  const c = capsule();
  expect(() =>
    validateJournalWrite(owner, root + "/sessions/2026-11-03.json", c.result.snapshots[0], true, c),
  ).not.toThrow();
  expect(() =>
    validateJournalWrite(owner, root + "/latest.json", c.result.projections[0], false, c),
  ).not.toThrow();
  expect(() =>
    validateJournalWrite(owner, root + "/sessions/2026-11-02.json", c.result.snapshots[0], true, c),
  ).toThrow();
  expect(() =>
    validateJournalWrite(owner, root + "/latest.json", { head: "2026-11-04" }, false, c),
  ).toThrow();
  expect(() =>
    validateJournalWrite(owner, owner + "/portfolio/latest.json", {}, false, c),
  ).toThrow();
});
it("fresh read-only boundary preserves all unrelated full database rows", async () => {
  await expect(
    assertFresh(
      { origin: "https://example.supabase.co", key: "synthetic", owner },
      capsule(),
      structuredClone(fake.baseline),
      structuredClone(fake.archive),
    ),
  ).resolves.toEqual(fake.baseline);
});
it.each(["actual", "source", "sourceGeneration", "journalOrphan", "journalMissing", "archive"])(
  "freshness rejects %s",
  async (kind) => {
    const baseline = structuredClone(fake.baseline),
      archive = structuredClone(fake.archive);
    if (kind === "actual") fake.baseline.actual.synthetic = 2;
    if (kind === "source") fake.baseline.sources[0].status = "inactive";
    if (kind === "sourceGeneration") fake.info.version = "changed";
    if (kind === "journalOrphan") fake.inventory.push(root + "/sessions/2026-11-04.json");
    if (kind === "journalMissing") fake.inventory.pop();
    if (kind === "archive") fake.archive[0].payload.synthetic = false;
    await expect(
      assertFresh(
        { origin: "https://example.supabase.co", key: "synthetic", owner },
        capsule(),
        baseline,
        archive,
      ),
    ).rejects.toThrow();
  },
);
it("built ESM transport and pure entry start without dynamic require errors or secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nov3-startup-"));
  try {
    const build = spawnSync(process.execPath, ["scripts/build-kospi-nov3-recovery.mjs"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir },
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    const transport = spawnSync(
      process.execPath,
      [path.join(dir, "kospi-nov3-code/transport.mjs"), "materialize"],
      { env: { PATH: process.env.PATH, RUNNER_TEMP: dir }, encoding: "utf8" },
    );
    expect(transport.status).toBe(1);
    expect(transport.stderr).toContain('"phase":"ADMISSION"');
    expect(transport.stderr).not.toContain("Dynamic require");
    const pure = spawnSync(process.execPath, [path.join(dir, "kospi-nov3-code/pure.mjs"), dir], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(pure.status).toBe(1);
    expect(pure.stderr.trim()).toBe("KOSPI_NOV3_PURE_REJECTED");
    expect(build.stdout).not.toContain("SUPABASE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

it("aggregate transport limits count actual streamed bytes and bound requests", async () => {
  const base = vi.fn(async () => new Response("12345"));
  const fetcher = boundedFetch(base as typeof fetch, 8, 3);
  expect(await (await fetcher("https://example.supabase.co")).text()).toBe("12345");
  await expect((await fetcher("https://example.supabase.co")).text()).rejects.toThrow();
  await expect(fetcher("https://example.supabase.co")).rejects.toThrow();
  expect(base).toHaveBeenCalledTimes(2);
  const once = boundedFetch(base as typeof fetch, 100, 1);
  await (await once("https://example.supabase.co")).text();
  await expect(once("https://example.supabase.co")).rejects.toThrow();
});

it("between-write freshness avoids full model transfer but still checks sources and pins", async () => {
  const transport = await import("../kr-final-retrospective/transport");
  vi.mocked(transport.snapshot).mockClear();
  const c = capsule(),
    baseline = structuredClone(fake.baseline),
    archives = structuredClone(fake.archive);
  await assertFresh(
    { origin: "https://example.supabase.co", key: "synthetic", owner },
    c,
    baseline,
    archives,
    false,
  );
  expect(transport.snapshot).not.toHaveBeenCalled();
  fake.baseline.sources[0].status = "inactive";
  await expect(
    assertFresh(
      { origin: "https://example.supabase.co", key: "synthetic", owner },
      c,
      baseline,
      archives,
      false,
    ),
  ).rejects.toThrow();
});

it("low budget stops a mutation before POST and preserves uncertain-readback capacity", async () => {
  const base = vi.fn(async () => new Response("ok"));
  const bytesLow = boundedFetch(base as typeof fetch, 4 * 1024 * 1024, 10);
  await expect(
    bytesLow("https://example.supabase.co/storage/v1/object/cloudtrend-data/item", {
      method: "POST",
      body: "{}",
    }),
  ).rejects.toThrow();
  expect(base).not.toHaveBeenCalled();
  const requestsLow = boundedFetch(base as typeof fetch, 16 * 1024 * 1024, 2);
  await expect(
    requestsLow("https://example.supabase.co/rest/v1/ledger_provenance_archive", {
      method: "POST",
      body: "{}",
    }),
  ).rejects.toThrow();
  expect(base).not.toHaveBeenCalled();
  const enough = boundedFetch(base as typeof fetch, 16 * 1024 * 1024, 3);
  expect(
    await (
      await enough("https://example.supabase.co/storage/v1/object/cloudtrend-data/item", {
        method: "POST",
        body: "{}",
      })
    ).text(),
  ).toBe("ok");
  expect(
    await (
      await enough(
        "https://example.supabase.co/storage/v1/object/authenticated/cloudtrend-data/item",
      )
    ).text(),
  ).toBe("ok");
});

it.each([true, false])(
  "freshness accepts only source timestamp serialization equivalence (full=%s)",
  async (full) => {
    const c = capsule();
    Object.assign(c.sourceRows[0], { created_at: "2026-11-04 01:05:34.360251+00" });
    Object.assign(fake.baseline.sources[0], { created_at: "2026-11-04T01:05:34.360251+00:00" });
    const baseline = structuredClone(fake.baseline);
    await expect(
      assertFresh(
        { origin: "https://example.supabase.co", key: "synthetic", owner },
        c,
        baseline,
        structuredClone(fake.archive),
        full,
      ),
    ).resolves.toBeDefined();
    Object.assign(fake.baseline.sources[0], { created_at: "2026-11-04T01:05:34.360252+00:00" });
    await expect(
      assertFresh(
        { origin: "https://example.supabase.co", key: "synthetic", owner },
        c,
        baseline,
        structuredClone(fake.archive),
        full,
      ),
    ).rejects.toThrow();
  },
);

// Storage reports missing objects with HTTP400 and an internal404 envelope.
import { shadowStore, shadowReadDiagnostic } from "./entry";
const missing = { statusCode: "404", error: "not_found", message: "Object not found" };
function transportStore(response: Response | Error) {
  const fetcher = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    store: shadowStore(
      { origin: "https://example.supabase.co", key: "synthetic", owner, fetcher },
      capsule(),
      false,
    ),
    fetcher,
  };
}
it.each([400, 404])(
  "actual transport recognizes only proven missing envelope with HTTP%s",
  async (status) => {
    const { store, fetcher } = transportStore(new Response(JSON.stringify(missing), { status }));
    await expect(store.read(root + "/sessions/2026-11-03.json")).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "GET" }),
    );
  },
);
it("actual transport parses existing object without changing its payload", async () => {
  const { store } = transportStore(new Response(JSON.stringify({ intact: true })));
  await expect(store.read(root + "/latest.json")).resolves.toEqual({ intact: true });
});
it.each([
  [401, missing],
  [403, missing],
  [500, missing],
  [400, { ...missing, statusCode: "403" }],
  [400, { ...missing, error: "AccessDenied" }],
  [404, { ...missing, message: "Permission denied" }],
  [400, { message: "Object not found" }],
  [404, {}],
  [400, { ...missing, code: "NoSuchBucket" }],
])("actual transport rejects non-missing error status%s payload%s", async (status, payload) => {
  const { store } = transportStore(
    new Response(JSON.stringify(payload), { status: status as number }),
  );
  await expect(store.read(root + "/sessions/2026-11-03.json")).rejects.toThrow(
    status === 400 || status === 404
      ? "SHADOW_READ_MISSING_ENVELOPE_UNRECOGNIZED"
      : "SHADOW_READ_HTTP_REJECTED",
  );
});
it("actual transport rejects invalid or oversized error bodies, even misleading Content-Length", async () => {
  for (const [body, code] of [
    ["<html>Not Found</html>", "SHADOW_READ_ERROR_ENVELOPE_INVALID"],
    [JSON.stringify({ ...missing, padding: "x".repeat(4096) }), "SHADOW_READ_ERROR_BODY_TOO_LARGE"],
  ]) {
    const { store } = transportStore(
      new Response(body, { status: 404, headers: { "Content-Length": "1" } }),
    );
    await expect(store.read(root + "/sessions/2026-11-03.json")).rejects.toThrow(code);
  }
});
it("actual transport does not swallow network failures or emit their sensitive text", async () => {
  const { store } = transportStore(new Error("secret/path/owner"));
  try {
    await store.read(root + "/latest.json");
    throw Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(shadowReadDiagnostic(error)).toBe("SHADOW_READ_REQUEST_FAILED");
  }
  expect(shadowReadDiagnostic(new Error("secret/path/owner"))).toBe("UNCLASSIFIED");
});
it("actual transport keeps VALIDATE writes forbidden after a missing read", async () => {
  const { store, fetcher } = transportStore(new Response(JSON.stringify(missing), { status: 400 }));
  await expect(store.read(root + "/sessions/2026-11-03.json")).resolves.toBeNull();
  await expect(
    store.putImmutable(root + "/sessions/2026-11-03.json", capsule().result.snapshots[0]),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("recognizes optional NoSuchKey code only with complete legacy missing envelope", async () => {
  const { store } = transportStore(
    new Response(JSON.stringify({ ...missing, code: "NoSuchKey" }), { status: 400 }),
  );
  await expect(store.read(root + "/sessions/2026-11-03.json")).resolves.toBeNull();
});
