/* eslint-disable @typescript-eslint/no-explicit-any -- Tests deliberately mutate malformed external JSON fixtures. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SCREENING_CACHE_VERSION,
  DASHBOARD_CACHE_VERSION,
  stableCacheJson,
} from "../src/lib/screeningCacheContract";
// Only the fixed historical digest is substituted. Every tested digest input must
// equal the exact synthetic analysis, so mutations still fail validation.
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  sha256: (value: string) =>
    value === stableCacheJson({ asOfDate: "2026-11-09", calculatedAt: "", rows: [] })
      ? "4b6e1bd68a308b63efacacebdfb963ace16650c6797bcbe1cac08b6dc6d0f12a"
      : "invalid-digest",
}));
import {
  recoverDriveInputHead,
  HEAD_RECOVERY_EVIDENCE as e,
} from "../scripts/recover-drive-input-head";
let directory: string;
let store: Map<string, any>;
let writes: string[];
let reads: Map<string, number>;
let mutateRead: (p: string, count: number) => void;
let uploadError: boolean;
let corruptUpload: boolean;
const owner = "synthetic-owner";
const headPath = `${owner}/results/drive-screening/input-head/latest.json`;
const screeningPath = `${owner}/cache/screening/latest.json`;
const dashboardPath = `${owner}/cache/dashboard/latest.json`;
const latestPath = `${owner}/results/screening/latest.json`;
const bundlePath = `${owner}/results/screening/old-run.json`;
const receiptPath = `${owner}/results/drive-screening/receipts/old-run.json`;
const identity = {
  publicationId: e.publicationId,
  inputFingerprint: e.inputFingerprint,
  resultDigest: e.resultDigest,
};
const analysis = { asOfDate: e.asOfDate, calculatedAt: "original", rows: [] };
const proof = {
  version: "drive-result-publication-v1",
  asOfDate: e.asOfDate,
  phase: "FINAL",
  sources: [{ record: "unchanged" }],
  baseFingerprint: "unchanged",
};
const restored = { version: "drive-input-head-v1", drivePublication: proof, ...identity };
const client = {
  storage: {
    from: (bucket: string) => {
      expect(bucket).toBe("cloudtrend-data");
      return {
        download: async (p: string, query: any, options: any) => {
          expect(query.cacheNonce).toBeTruthy();
          expect(options.cache).toBe("no-store");
          const count = (reads.get(p) ?? 0) + 1;
          reads.set(p, count);
          mutateRead(p, count);
          return store.has(p)
            ? { data: new Blob([JSON.stringify(store.get(p))]), error: null }
            : { data: null, error: { message: "not found" } };
        },
        upload: async (p: string, body: string) => {
          expect(p).toBe(headPath);
          writes.push(p);
          if (uploadError) return { error: { message: "uncertain network outcome" } };
          store.set(p, corruptUpload ? { broken: true } : JSON.parse(body));
          return { error: null };
        },
      };
    },
  },
};
const run = (apply = true, expectedOwner = owner) =>
  recoverDriveInputHead({
    client: client as never,
    owner,
    expectedOwner,
    apply,
    reportPath: path.join(directory, "report.json"),
  });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "head-recovery-"));
  writes = [];
  reads = new Map();
  mutateRead = () => {};
  uploadError = false;
  corruptUpload = false;
  store = new Map(
    Object.entries({
      [headPath]: {
        ...restored,
        publicationId: "11111111-2222-4333-8444-555555555555",
        resultDigest: e.failedDigest,
      },
      [screeningPath]: {
        version: SCREENING_CACHE_VERSION,
        ...identity,
        payload: { analysis, source: { drivePublication: proof } },
      },
      [dashboardPath]: {
        version: DASHBOARD_CACHE_VERSION,
        ...identity,
        asOfDate: e.asOfDate,
        drivePublication: proof,
      },
      [latestPath]: { run: { id: "old-run" }, resultPath: bundlePath, publication: identity },
      [bundlePath]: { run: { id: "old-run" }, result: analysis },
      [receiptPath]: {
        version: "drive-result-receipt-v1",
        ...identity,
        date: e.asOfDate,
        phase: "FINAL",
        resultPath: bundlePath,
      },
    }).map(([key, value]) => [key, structuredClone(value)]),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
test("diagnosis performs no writes and records eligibility", async () => {
  expect(await run(false)).toMatchObject({ status: "eligible-no-write", writesAttempted: 0 });
  expect(writes).toEqual([]);
});
test("one head-only write restores exact old metadata and verifies both caches", async () => {
  expect(await run()).toMatchObject({ status: "restored", verified: true, writesAttempted: 1 });
  expect(writes).toEqual([headPath]);
  expect(store.get(headPath)).toEqual(restored);
});
test("already-restored generation is idempotent", async () => {
  store.set(headPath, structuredClone(restored));
  expect(await run()).toMatchObject({ status: "already-restored" });
  expect(writes).toEqual([]);
});
test.each([
  "headDigest",
  "headFingerprint",
  "headExtra",
  "cacheProof",
  "cacheDigest",
  "cacheId",
  "actualDigest",
  "archiveDigest",
  "receipt",
  "missing",
  "owner",
])("%s mismatch blocks before all writes", async (kind) => {
  if (kind === "headDigest") store.get(headPath).resultDigest = "newer";
  if (kind === "headFingerprint") store.get(headPath).inputFingerprint = "newer";
  if (kind === "headExtra") store.get(headPath).unknown = true;
  if (kind === "cacheProof") store.get(dashboardPath).drivePublication.sources = [];
  if (kind === "cacheDigest") store.get(dashboardPath).resultDigest = "altered";
  if (kind === "cacheId") store.get(screeningPath).publicationId = "altered";
  if (kind === "actualDigest") store.get(screeningPath).payload.analysis.rows = ["altered"];
  if (kind === "archiveDigest") store.get(bundlePath).result.rows = ["altered"];
  if (kind === "receipt") store.get(receiptPath).publicationId = "altered";
  if (kind === "missing") store.delete(bundlePath);
  await expect(run(true, kind === "owner" ? "other-owner" : owner)).rejects.toThrow();
  expect(writes).toEqual([]);
  expect(JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"))).toMatchObject({
    verified: false,
    writesAttempted: 0,
  });
});
test.each([headPath, screeningPath, dashboardPath, latestPath])(
  "concurrent change to %s blocks before upload",
  async (target) => {
    mutateRead = (p, count) => {
      if (p === target && count === 2) store.get(p).concurrent = true;
    };
    await expect(run()).rejects.toThrow("concurrent");
    expect(writes).toEqual([]);
  },
);
test("upload failure is not retried and reports uncertain outcome", async () => {
  uploadError = true;
  await expect(run()).rejects.toThrow("outcome must be inspected");
  expect(writes).toEqual([headPath]);
});
test("readback mismatch stops without rollback or retry", async () => {
  corruptUpload = true;
  await expect(run()).rejects.toThrow("readback mismatch");
  expect(writes).toEqual([headPath]);
});

test("CLI accepts only optional apply and rejects unknown flags", async () => {
  const { recoveryCliApply } = await import("../scripts/recover-drive-input-head");
  expect(recoveryCliApply([])).toBe(false);
  expect(recoveryCliApply(["--apply"])).toBe(true);
  for (const args of [
    ["--force"],
    ["--config", "scripts/drive-screening.config.ts"],
    ["--config"],
    ["--apply", "--apply"],
    ["--skip-guards"],
  ])
    expect(() => recoveryCliApply(args)).toThrow("usage");
});
