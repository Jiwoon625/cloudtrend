import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  toCanonicalCsv,
  validateSourceBytes,
  CANONICAL_SOURCE_COLUMNS,
  type CanonicalSourceRow,
} from "../src/lib/sourceData";
import {
  runCompaction,
  verifyInIsolatedProcess,
  restorePrivateCompactionEvidence,
  retryCompactionCutover,
} from "../scripts/compact-screening-sources";
import {
  bytesHash,
  registrySourceSetHash,
  compactionExecutionMode,
} from "../scripts/screening-compaction-core";
import type { SourceRecord } from "../scripts/source-registry-store";

const owner = "00000000-0000-4000-8000-000000000001";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function sourceRows() {
  return Array.from({ length: 125 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10);
    return ["KOSPI", "005930"].map(
      (symbol) =>
        ({
          ...Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((c) => [c, ""])),
          symbol,
          name: symbol,
          date,
          market: symbol === "KOSPI" ? "INDEX" : "KOSPI",
          type: symbol === "KOSPI" ? "INDEX" : "STOCK",
          open: "100",
          high: "100",
          low: "100",
          close: "100",
          volume: "10",
          tradingValue: "1000",
          sector: symbol === "KOSPI" ? "MARKET_IDX" : "SEMICON",
          shortSellingVolumeRate: "0",
          lendingBalanceQuantity: "1",
        }) as unknown as CanonicalSourceRow,
    );
  }).flat();
}
async function harness() {
  const output = await mkdtemp(path.join(os.tmpdir(), "compaction-test-"));
  temporary.push(output);
  const bytes = Buffer.from(toCanonicalCsv(sourceRows()));
  const v = await validateSourceBytes({ bytes, filename: "original.csv", streamingCsv: true });
  expect(v.valid).toBe(true);
  const objects = new Map<string, { raw: Uint8Array; id: string; version: string }>();
  const sources = Array.from({ length: 2 }, (_, index) => {
    const id = randomUUID(),
      storagePath = `${owner}/source/screening/${id}/original.csv`;
    objects.set(storagePath, { raw: bytes, id: randomUUID(), version: randomUUID() });
    return {
      id,
      user_id: owner,
      source_type: "screening",
      storage_bucket: "cloudtrend-data",
      storage_path: storagePath,
      canonical_format: "csv",
      content_type: "text/csv",
      original_filename: "original.csv",
      file_size_bytes: bytes.length,
      normalized_size_bytes: v.normalizedSizeBytes,
      file_hash: v.fileHash,
      data_hash: v.dataHash,
      schema_hash: v.schemaHash,
      row_count: v.stats.rowCount,
      symbol_count: v.stats.symbolCount,
      min_date: v.stats.minDate,
      max_date: v.stats.maxDate,
      created_at: `2026-01-0${index + 1}T00:00:00Z`,
      activated_at: `2026-01-0${index + 1}T00:00:00Z`,
      status: "active",
      upload_source: "web",
    } as SourceRecord;
  });
  const staged: SourceRecord[] = [];
  let active = sources;
  const download = vi.fn(async (key: string) => ({
    data: new Blob([Uint8Array.from(objects.get(key)!.raw)]),
    error: null,
  }));
  const info = vi.fn(async (key: string) =>
    objects.has(key)
      ? {
          data: { id: objects.get(key)!.id, version: objects.get(key)!.version },
          error: null,
        }
      : { data: null, error: { statusCode: 404 } },
  );
  const upload = vi.fn(async (key: string, raw: Uint8Array) => {
    objects.set(key, { raw, id: randomUUID(), version: randomUUID() });
    return { error: null };
  });
  const insert = vi.fn((record: SourceRecord) => ({
    select: () => ({
      single: async () => {
        const value = { ...record, created_at: new Date().toISOString() };
        staged.push(value);
        return { data: value, error: null };
      },
    }),
  }));
  const rpc = vi.fn(async (_name?: string, _args?: Record<string, unknown>) => {
    active = staged.map((record) => ({ ...record, status: "active" }));
    return {
      data: {
        committed: true,
        candidate_ids: staged.map((s) => s.id),
        original_source_evidence: sources.map((s) => ({
          id: s.id,
          min_date: s.min_date,
          max_date: s.max_date,
          activated_at: s.activated_at,
          created_at: s.created_at,
        })),
      },
      error: null,
    };
  });
  const client = {
    storage: { from: () => ({ download, info, upload }) },
    from: () => ({
      insert,
      select: () => {
        let id = "";
        const query = {
          eq: (key: string, value: string) => {
            if (key === "id") id = value;
            return query;
          },
          maybeSingle: async () => ({
            data: staged.find((record) => record.id === id) ?? null,
            error: null,
          }),
        };
        return query;
      },
    }),
    rpc: async (name: string, args: Record<string, unknown>) =>
      args["p_user_id"] === null
        ? {
            data: null,
            error: {
              code: "P0001",
              message: "screening compaction requires owner and operation ids",
            },
          }
        : rpc(name, args),
  } as unknown as SupabaseClient;
  const listSources = vi.fn(async () => active);
  const digest = bytesHash("fixture");
  const verify = vi.fn(async () => ({
    datasetDigest: digest,
    sectorDatasetDigest: digest,
    analysisDigest: digest,
    configHash: digest,
    asOfDate: "2025-05-05",
    stats: { stocks: 1 },
  }));
  return {
    output,
    sources,
    objects,
    staged,
    client,
    download,
    info,
    upload,
    insert,
    rpc,
    listSources,
    verify,
  };
}
describe("compaction orchestration safety", () => {
  it("requires exact approved snapshot before apply or retry", async () => {
    const h = await harness();
    await expect(
      runCompaction(
        {
          userId: owner,
          output: h.output,
          apply: true,
          expectedSourceHash: bytesHash("another set"),
        },
        h,
      ),
    ).rejects.toThrow("approved compaction snapshot");
    await writeFile(
      path.join(h.output, "cutover-arguments.json"),
      JSON.stringify({ p_user_id: owner, p_expected_sources: h.sources, p_candidates: [] }),
    );
    await expect(
      retryCompactionCutover(
        { userId: owner, output: h.output, expectedSourceHash: bytesHash("another set") },
        h.client,
      ),
    ).rejects.toThrow("Saved cutover");
    expect(h.download).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("restore alone is read-only even when it finds saved cutover arguments", () => {
    expect(compactionExecutionMode(["--restore-private-evidence"], true)).toBe("prepare");
    expect(compactionExecutionMode(["--apply", "--restore-private-evidence"], true)).toBe("retry");
    expect(compactionExecutionMode(["--apply"], false)).toBe("apply");
  });
  it("remote 404 does not activate leftover local retry arguments", async () => {
    const h = await harness();
    await writeFile(path.join(h.output, "cutover-arguments.json"), "{}");
    h.download.mockResolvedValue({ data: null, error: { statusCode: 404 } } as never);
    expect(
      await restorePrivateCompactionEvidence(
        { userId: owner, output: h.output, expectedSourceHash: registrySourceSetHash(h.sources) },
        h.client,
      ),
    ).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("restored metadata must match one scope and operation before local writeback", async () => {
    const h = await harness(),
      scope = registrySourceSetHash(h.sources);
    const manifest = {
      owner,
      operationId: "first",
      parents: h.sources,
      plannedCandidateIds: ["candidate"],
    };
    const args = {
      p_user_id: owner,
      p_operation_id: "another",
      p_expected_sources: h.sources,
      p_candidates: [{ id: "candidate" }],
    };
    h.download.mockImplementation(async (key: string) => ({
      data: new Blob([JSON.stringify(key.endsWith("compaction-manifest.json") ? manifest : args)]),
      error: null,
    }));
    await expect(
      restorePrivateCompactionEvidence(
        { userId: owner, output: h.output, expectedSourceHash: scope },
        h.client,
      ),
    ).rejects.toThrow("one approved operation");
    args.p_operation_id = "first";
    expect(
      await restorePrivateCompactionEvidence(
        { userId: owner, output: h.output, expectedSourceHash: scope },
        h.client,
      ),
    ).toBe(true);
    await expect(
      restorePrivateCompactionEvidence(
        { userId: owner, output: h.output, expectedSourceHash: bytesHash("different") },
        h.client,
      ),
    ).rejects.toThrow("approved source snapshot");
  });
  it("prepare does not upload, change the registry, or call cutover", async () => {
    const h = await harness();
    const result = await runCompaction({ userId: owner, output: h.output, apply: false }, h);
    expect(result.state).toBe("verified_local_only");
    expect(result.candidates).toHaveLength(1);
    expect(h.download).toHaveBeenCalledTimes(2);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    await runCompaction({ userId: owner, output: h.output, apply: false }, h);
    expect(h.download).toHaveBeenCalledTimes(2); // same raw generation and validator: reuse local proof
  });
  it("changed immutable object generation forces fresh validation and rejects changed bytes", async () => {
    const h = await harness();
    await runCompaction({ userId: owner, output: h.output, apply: false }, h);
    const object = h.objects.get(h.sources[0]!.storage_path)!;
    object.version = randomUUID();
    object.raw = Buffer.from("changed");
    await expect(
      runCompaction(
        {
          userId: owner,
          output: h.output,
          apply: true,
          expectedSourceHash: registrySourceSetHash(h.sources),
        },
        h,
      ),
    ).rejects.toThrow("size/hash");
    expect(h.download).toHaveBeenCalledTimes(3);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("analysis mismatch stops before any candidate write", async () => {
    const h = await harness();
    h.verify.mockImplementationOnce(async () => ({
      datasetDigest: "different",
      sectorDatasetDigest: "different",
      analysisDigest: "different",
      configHash: "different",
      asOfDate: "2025-05-05",
      stats: { stocks: 1 },
    }));
    await expect(
      runCompaction(
        {
          userId: owner,
          output: h.output,
          apply: true,
          expectedSourceHash: registrySourceSetHash(h.sources),
        },
        h,
      ),
    ).rejects.toThrow("parity failed");
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("stages inactive records, verifies uploaded bytes, and cuts over only once", async () => {
    const h = await harness();
    const result = await runCompaction(
      {
        userId: owner,
        output: h.output,
        apply: true,
        expectedSourceHash: registrySourceSetHash(h.sources),
      },
      h,
    );
    expect(result.state).toBe("cutover_verified");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.insert.mock.calls[0]![0].status).toBe("valid");
    const args = JSON.parse(await readFile(path.join(h.output, "cutover-arguments.json"), "utf8"));
    expect(args.p_verification.schema_version).toBe(103);
    expect(args.p_verification.effective_rows_before).toBe(250);
    expect(args.p_expected_sources).toHaveLength(2);
    expect(args.p_candidates).toHaveLength(1);
    expect(args.p_candidates[0].storage_object_version).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.sources.every((s) => h.objects.has(s.storage_path))).toBe(true);
  });
  it("cutover error preserves all staged objects and a retryable exact request", async () => {
    const h = await harness();
    h.rpc.mockImplementation(async () => ({ data: null, error: { message: "stale" } }) as never);
    await expect(
      runCompaction(
        {
          userId: owner,
          output: h.output,
          apply: true,
          expectedSourceHash: registrySourceSetHash(h.sources),
        },
        h,
      ),
    ).rejects.toThrow("not confirmed");
    expect(h.objects.size).toBe(3);
    expect(
      JSON.parse(await readFile(path.join(h.output, "cutover-arguments.json"), "utf8")),
    ).toHaveProperty("p_operation_id");
  });
  it("reuses the same operation and staged candidate after a recoverable cutover failure", async () => {
    const h = await harness();
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "busy" } } as never);
    await expect(
      runCompaction(
        {
          userId: owner,
          output: h.output,
          apply: true,
          expectedSourceHash: registrySourceSetHash(h.sources),
        },
        h,
      ),
    ).rejects.toThrow("not confirmed");
    const first = JSON.parse(await readFile(path.join(h.output, "cutover-arguments.json"), "utf8"));
    const result = await runCompaction(
      {
        userId: owner,
        output: h.output,
        apply: true,
        expectedSourceHash: registrySourceSetHash(h.sources),
      },
      h,
    );
    const next = JSON.parse(await readFile(path.join(h.output, "cutover-arguments.json"), "utf8"));
    expect(result.state).toBe("cutover_verified");
    expect(next.p_operation_id).toBe(first.p_operation_id);
    expect(next.p_candidates).toEqual(first.p_candidates);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.insert).toHaveBeenCalledTimes(1);
  });
  it("bypasses stale CDN bytes when a registered object generation was overwritten", async () => {
    const h = await harness();
    const key = h.sources[0]!.storage_path,
      object = h.objects.get(key)!;
    const stale = object.raw;
    object.raw = Buffer.from("changed at origin");
    object.version = randomUUID();
    h.download.mockImplementation(
      async (
        requested: string,
        options?: Record<string, unknown>,
        fetchOptions?: Record<string, unknown>,
      ) => ({
        data: new Blob([
          Uint8Array.from(
            requested === key &&
              !(options?.["cacheNonce"] && fetchOptions?.["cache"] === "no-store")
              ? stale
              : h.objects.get(requested)!.raw,
          ),
        ]),
        error: null,
      }),
    );
    await expect(
      runCompaction(
        {
          userId: owner,
          output: h.output,
          apply: true,
          expectedSourceHash: registrySourceSetHash(h.sources),
        },
        h,
      ),
    ).rejects.toThrow("size/hash");
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("executes the real isolated analyzer on a local fixture without credentials", async () => {
    const h = await harness();
    const file = path.join(h.output, "fixture.csv"),
      manifest = path.join(h.output, "input.json"),
      result = path.join(h.output, "result.json");
    await writeFile(file, toCanonicalCsv(sourceRows()));
    await writeFile(manifest, JSON.stringify({ canonicalFiles: [file] }));
    const verification = await verifyInIsolatedProcess(process.cwd(), manifest, result);
    expect(verification.datasetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verification.analysisDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 30_000);
});
