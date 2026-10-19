import { beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  resolveUsSameSessionReference,
  getUsSameSessionReference,
} from "../src/lib/usSameSessionRevision";
import { loadUsLatestReferenceCache, loadUsProspectiveCache } from "../src/lib/usProspectiveCloud";
import {
  bundleWire,
  canonicalCache,
  revisionBundle,
  originalHash,
  revisionHash,
  userId,
} from "./fixtures/us-same-session-reference";
const cloud = vi.hoisted(() => ({ binary: vi.fn(), read: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/cloud", () => ({
  ownerPath: async (path: string) => `${userId}/${path}`,
  readObject: cloud.read,
  readBinaryObject: cloud.binary,
  userId: cloud.user,
  supabase: {},
}));
vi.mock("@/lib/usOrderPreview.functions", () => ({ usOrderPreviewsServer: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  cloud.user.mockResolvedValue(userId);
});

describe("same-session browser revision selection", () => {
  it("selects an integrity-checked same-session revision without mutating original or bundle", async () => {
    const original = canonicalCache();
    const bundle = revisionBundle();
    const before = JSON.stringify({ original, bundle });
    const { bytes, pointer } = bundleWire(bundle);
    const read = vi.fn().mockResolvedValue(bytes);
    const selected = await resolveUsSameSessionReference(original, userId, pointer, read);
    expect(selected.dataHash).toBe(revisionHash);
    expect(selected.analysis.rows[0]?.close).toBe(103);
    expect(selected.analysis.ruleVersion).toBe(original.analysis.ruleVersion);
    expect(getUsSameSessionReference(selected)).toMatchObject({
      referenceOnly: true,
      originalDataHash: originalHash,
      bundleHash: pointer.bundleHash,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(pointer.bundlePath);
    expect(JSON.stringify({ original, bundle })).toBe(before);
    expect(getUsSameSessionReference(original)).toBeNull();
  });
  it("verifies raw bytes, including whitespace, instead of reserializing parsed JSON", async () => {
    const bundle = revisionBundle();
    const wire = bundleWire(bundle, JSON.stringify(bundle, null, 2) + "\n");
    await expect(
      resolveUsSameSessionReference(canonicalCache(), userId, wire.pointer, async () => wire.bytes),
    ).resolves.toHaveProperty("dataHash", revisionHash);
    await expect(
      resolveUsSameSessionReference(
        canonicalCache(),
        userId,
        bundleWire(bundle).pointer,
        async () => wire.bytes,
      ),
    ).rejects.toThrow("hash mismatch");
  });
  it("ignores a previous-session pointer when the canonical session advances", async () => {
    const original = canonicalCache();
    original.analysis.date = "2026-10-19";
    original.dataHash = `sha256:${"c".repeat(64)}`;
    const { pointer } = bundleWire();
    const read = vi.fn();
    expect(await resolveUsSameSessionReference(original, userId, pointer, read)).toBe(original);
    expect(read).not.toHaveBeenCalled();
  });
  it("returns the original for an absent pointer", async () => {
    const original = canonicalCache();
    const read = vi.fn();
    expect(await resolveUsSameSessionReference(original, userId, null, read)).toBe(original);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    { userId: "another-owner" },
    { version: "future" },
    { bundlePath: "https://example.com/bundle.json" },
    { bundlePath: `${userId}/results/us-screening-revisions/2026-10-16/../../bundle.json` },
    { bundlePath: `${userId}/cache/us-screening/latest.json` },
    { originalDataHash: revisionHash },
    { revisionDataHash: "bad" },
    { bundleHash: "bad" },
    { collectedAt: "invalid" },
    { collectedAt: "2026-10-16T19:00:00Z" },
    { collectedAt: "2026-10-16T20:01:00Z" },
  ])("rejects invalid pointer before fetching: %j", async (override) => {
    const { pointer } = bundleWire();
    const read = vi.fn();
    await expect(
      resolveUsSameSessionReference(canonicalCache(), userId, { ...pointer, ...override }, read),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects a future date even with its correctly derived path", async () => {
    const bundle = revisionBundle();
    bundle.date = "2026-10-19";
    const { pointer } = bundleWire(bundle);
    const read = vi.fn();
    await expect(
      resolveUsSameSessionReference(canonicalCache(), userId, pointer, read),
    ).rejects.toThrow("canonical session");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "malformed", "wrong-hash"])("rejects a %s bundle", async (failure) => {
    const { bytes, pointer } = bundleWire();
    const read = async () =>
      failure === "missing"
        ? null
        : failure === "malformed"
          ? bundleWire(revisionBundle(), "{").bytes
          : new Uint8Array([...bytes, 32]);
    if (failure === "malformed")
      pointer.bundleHash = bundleWire(revisionBundle(), "{").pointer.bundleHash;
    await expect(
      resolveUsSameSessionReference(canonicalCache(), userId, pointer, read),
    ).rejects.toThrow();
  });
  it.each([
    "owner",
    "date",
    "hash",
    "collection",
    "rule",
    "row-date",
    "duplicate",
    "row-type",
    "signal-type",
    "screening",
    "summary",
    "quality",
    "state",
  ])("rejects an integrity-valid but inconsistent %s bundle", async (failure) => {
    const bundle = revisionBundle();
    const expected = bundleWire(bundle).pointer;
    if (failure === "owner") bundle.userId = "another-owner";
    if (failure === "date") bundle.date = "2026-10-15";
    if (failure === "hash") bundle.view.dataHash = originalHash;
    if (failure === "collection") bundle.view.source.collectedAt = "2026-10-16T22:00:00Z";
    if (failure === "rule") bundle.view.analysis.ruleVersion = "different-rule";
    if (failure === "row-date") bundle.view.analysis.rows[0]!.date = "2026-10-15";
    if (failure === "duplicate") bundle.view.analysis.rows.push(bundle.view.analysis.rows[0]!);
    if (failure === "row-type") Object.assign(bundle.view.analysis.rows[0]!, { a0Entry: "true" });
    if (failure === "signal-type")
      Object.assign(bundle.view.analysis.rows[0]!, { primarySignal: ["ENTRY"] });
    if (failure === "screening") bundle.screening.analysis.rows[0]!.close = 999;
    if (failure === "summary") bundle.summary.analysis.rowCount = 999;
    if (failure === "quality") bundle.summary.quality!.duplicateSymbols = 99;
    if (failure === "state") Object.assign(bundle.view.analysis, { state: { positions: [] } });
    const { bytes, pointer } = bundleWire(bundle);
    await expect(
      resolveUsSameSessionReference(
        canonicalCache(),
        userId,
        { ...expected, bundleHash: pointer.bundleHash },
        async () => bytes,
      ),
    ).rejects.toThrow();
  });
});

describe("reference loader isolation and fail-safe fallback", () => {
  function setup() {
    const original = canonicalCache();
    const { bytes, pointer } = bundleWire();
    cloud.binary.mockImplementation(async (path: string) =>
      path.endsWith("view-v1.json.gz") ? gzipSync(JSON.stringify(original)) : bytes,
    );
    cloud.read.mockResolvedValue(pointer);
    return { original, pointer };
  }
  it("keeps canonical loader independent from optional revision reads", async () => {
    const { original } = setup();
    expect(await loadUsProspectiveCache()).toEqual(original);
    expect(cloud.read).not.toHaveBeenCalled();
    expect(cloud.binary).toHaveBeenCalledExactlyOnceWith(
      `${userId}/cache/us-screening/view-v1.json.gz`,
    );
  });
  it("uses the authenticated owner pointer and returns verified revision metadata", async () => {
    const { pointer } = setup();
    const result = await loadUsLatestReferenceCache();
    expect(result?.dataHash).toBe(revisionHash);
    expect(cloud.read).toHaveBeenCalledExactlyOnceWith(
      `${userId}/cache/us-screening-revisions/latest.json`,
    );
    expect(cloud.binary).toHaveBeenLastCalledWith(pointer.bundlePath);
  });
  it.each(["pointer-failure", "bundle-failure", "hash-mismatch", "owner-path"])(
    "preserves canonical rows and reports no latest claim on %s",
    async (failure) => {
      const { original, pointer } = setup();
      if (failure === "pointer-failure") cloud.read.mockRejectedValue(new Error("offline"));
      if (failure === "bundle-failure")
        cloud.binary.mockImplementation(async (path: string) => {
          if (path.endsWith("view-v1.json.gz")) return gzipSync(JSON.stringify(original));
          throw new Error("offline");
        });
      if (failure === "hash-mismatch")
        cloud.read.mockResolvedValue({ ...pointer, bundleHash: originalHash });
      if (failure === "owner-path")
        cloud.read.mockResolvedValue({ ...pointer, bundlePath: "another-owner/private.json" });
      const result = await loadUsLatestReferenceCache();
      expect(result?.analysis).toEqual(original.analysis);
      expect(result?.dataHash).toBe(original.dataHash);
      expect(result?.source.metadata["sameSessionRevisionStatus"]).toBe("unavailable");
      expect(getUsSameSessionReference(result)).toBeNull();
    },
  );
  it("does not read revisions if no original result exists", async () => {
    cloud.binary.mockResolvedValue(null);
    cloud.read.mockResolvedValue(null);
    expect(await loadUsLatestReferenceCache()).toBeNull();
    expect(cloud.read).toHaveBeenCalledExactlyOnceWith(`${userId}/cache/us-screening/latest.json`);
  });
  it("confines the reference query to the two read-only screens", () => {
    for (const file of [
      "src/components/UsScreenerPage.tsx",
      "src/routes/us.instrument.$symbol.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('queryKey: ["us-latest-reference-cache"]');
      expect(source).not.toContain('queryKey: ["us-prospective-cache"]');
      expect(source).not.toContain("queryFn: loadUsProspectiveCache");
    }
  });
});

describe("published bundle browser compatibility", () => {
  it("consumes exact compact stable-JSON bytes published by the revision workflow", async () => {
    const {
      publishSameSessionRevision,
      revisionHash: digest,
      revisionPaths,
    } = await import("../scripts/us-same-session-revision");
    const { US_PROSPECTIVE_RULE_VERSION } = await import("../src/lib/engine/usProspective");
    const header =
      "date,symbol,open,high,low,close,volume,dollar_volume,ret120,ret252,beta60_spy,ichimoku_tk_gap,relvol1_20,adv20_usd,amihud20,active20,toss_tradable,is_common_share";
    const csv = (close: number) =>
      `${header}\n2026-10-16,SPY,100,${close},99,${close},10000,1000000,0.1,0.2,1,1,1,100000000,0.001,true,true,true\n`;
    const originalCsv = csv(100);
    const revisedCsv = csv(101);
    const canonical = canonicalCache();
    canonical.dataHash = digest(originalCsv);
    canonical.analysis.ruleVersion = US_PROSPECTIVE_RULE_VERSION;
    const source = {
      version: "us-same-session-source-v1" as const,
      userId,
      date: canonical.analysis.date,
      originalDataHash: canonical.dataHash,
      revisionDataHash: digest(revisedCsv),
      collectedAt: "2026-10-16T23:00:00Z",
      rowCount: 1,
      symbolCount: 1,
      metadata: {
        confirmedRegularClose: true,
        failedSymbols: 0,
        sourceCoverageComplete: true,
        previousSessionDate: "2026-10-15",
      },
    };
    const paths = revisionPaths(source);
    const objects = new Map([
      [paths.source, JSON.stringify(source)],
      [paths.csv, revisedCsv],
    ]);
    const published = await publishSameSessionRevision(
      {
        read: async (path) => objects.get(path) ?? null,
        immutable: async (path, bytes) => {
          objects.set(path, bytes);
        },
        pointer: async (path, bytes) => {
          objects.set(path, bytes);
        },
        original: async () => ({
          date: source.date,
          dataHash: canonical.dataHash,
          ruleVersion: US_PROSPECTIVE_RULE_VERSION,
          csv: originalCsv,
          result: canonical,
          previousState: { lastDate: "2026-10-15", coreRanks: {} },
        }),
      },
      userId,
      paths.source,
      digest(objects.get(paths.source)!),
    );
    expect(published.status).toBe("published");
    const result = await resolveUsSameSessionReference(
      canonical,
      userId,
      JSON.parse(objects.get(paths.pointer)!),
      async (path) => new TextEncoder().encode(objects.get(path)!),
    );
    expect(result.dataHash).toBe(source.revisionDataHash);
    expect(result.analysis.rows[0]?.close).toBe(101);
    expect(getUsSameSessionReference(result)?.referenceOnly).toBe(true);
    expect(result.analysis).not.toHaveProperty("state");
    expect(canonical.dataHash).toBe(source.originalDataHash);
  });
});
