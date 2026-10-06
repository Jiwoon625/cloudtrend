import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { validateSourceBytes } from "../src/lib/sourceData";
import { SourceValidationCache, sourceValidatorVersion } from "../scripts/source-validation-cache";
import { loadAnalysisSourceInputs, type SourceRecord } from "../scripts/source-registry-store";
import { profileSourceValidationCache } from "../scripts/profile-source-validation-cache";

const directories: string[] = [];
async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), "source-cache-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const csv =
  'symbol,name,market,type,date,close,volume,sector\n005930,"삼성,전자",KOSPI,STOCK,2026-10-06,100,1000,SEMI\n';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture() {
  const validation = await validateSourceBytes({
    bytes: new TextEncoder().encode(csv),
    filename: "source.csv",
  });
  expect(validation.valid).toBe(true);
  const record = {
    id: uuid(1),
    user_id: "user",
    source_type: "screening",
    original_filename: "source.csv",
    storage_bucket: "bucket",
    storage_path: "user/source.csv",
    canonical_format: "csv",
    content_type: "text/csv",
    file_hash: validation.fileHash,
    data_hash: validation.dataHash,
    schema_hash: validation.schemaHash,
    validation_result: {},
    activated_at: "2026-10-06T10:00:00Z",
  } as SourceRecord;
  const revision = {
    id: uuid(2),
    version: uuid(3),
    name: record.storage_path,
    bucketId: record.storage_bucket,
    lastModified: "2026-10-06T00:00:00Z",
    size: csv.length,
  };
  const info = vi.fn<
    () => Promise<{
      data: typeof revision | null;
      error: { statusCode: number; message: string } | null;
    }>
  >(async () => ({ data: { ...revision }, error: null }));
  const client = { storage: { from: () => ({ info }) } } as unknown as SupabaseClient;
  const validate = vi.fn(async () => structuredClone(validation));
  return { validation, record, revision, info, client, validate };
}
test("same verified generation reuses validation with exact row/order/statistics parity", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  expect(await cache.load(f.client, f.record, f.validate)).toEqual(f.validation);
  const result = await cache.load(f.client, f.record, f.validate);
  expect(result).toEqual(f.validation);
  expect(f.validate).toHaveBeenCalledTimes(1);
  expect(cache.metrics.hits).toBe(1);
  expect(f.info).toHaveBeenCalledTimes(3);
  result.rows.length = 0;
  expect(await cache.load(f.client, f.record, f.validate)).toEqual(f.validation);
});
test("a private disk cache is reusable across cache instances only with fresh revision proof", async () => {
  const f = await fixture(),
    directory = await temporary();
  await new SourceValidationCache({ directory }).load(f.client, f.record, f.validate);
  const second = new SourceValidationCache({ directory });
  expect(await second.load(f.client, f.record, f.validate)).toEqual(f.validation);
  expect(f.validate).toHaveBeenCalledTimes(1);
  expect(second.metrics.hits).toBe(1);
});

test("separate Node processes reuse verified disk proofs without normalizing again", async () => {
  const f = await fixture(),
    directory = await temporary();
  await new SourceValidationCache({ directory }).load(f.client, f.record, f.validate);
  const fixturePath = path.join(directory, "fixture.json"),
    output = path.join(directory, "result.json"),
    script = path.join(directory, "child.ts");
  await writeFile(
    fixturePath,
    JSON.stringify({ record: f.record, revision: f.revision, validation: f.validation }),
  );
  await writeFile(
    script,
    `import { readFile, writeFile } from 'node:fs/promises';
import { SourceValidationCache } from ${JSON.stringify(path.join(process.cwd(), "scripts/source-validation-cache.ts"))};
const fixture = JSON.parse(await readFile(${JSON.stringify(fixturePath)}, 'utf8'));
const client = { storage: { from: () => ({ info: async () => ({data:fixture.revision,error:null}) }) } };
let calls=0; const cache = new SourceValidationCache({directory:${JSON.stringify(directory)}});
const result=await cache.load(client as any,fixture.record,async()=>{calls++;return fixture.validation;});
await writeFile(${JSON.stringify(output)},JSON.stringify({calls,hits:cache.metrics.hits,result}));`,
  );
  await promisify(execFile)(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs"),
      "--script",
      "--config",
      "vitest.source-pipeline.config.ts",
      script,
    ],
    { cwd: process.cwd(), env: { PATH: process.env["PATH"] ?? "", LANG: "C.UTF-8" } },
  );
  const result = JSON.parse(await readFile(output, "utf8"));
  expect(result.calls).toBe(0);
  expect(result.hits).toBe(1);
  expect(result.result).toEqual(f.validation);
}, 30000);

test("a changed object id invalidates a cache even when generation text is unchanged", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  await cache.load(f.client, f.record, f.validate);
  f.revision.id = uuid(9);
  await cache.load(f.client, f.record, f.validate);
  expect(f.validate).toHaveBeenCalledTimes(2);
});

test("timestamp-only metadata changes do not force revalidation of the same generation", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  await cache.load(f.client, f.record, f.validate);
  f.revision.lastModified = "2026-10-07T00:00:00Z";
  await cache.load(f.client, f.record, f.validate);
  expect(f.validate).toHaveBeenCalledTimes(1);
});

test.each(["name", "bucketId", "version"] as const)(
  "wrong %s proof falls back to original full validation",
  async (field) => {
    const f = await fixture(),
      cache = new SourceValidationCache();
    f.revision[field] = "wrong";
    await cache.load(f.client, f.record, f.validate);
    await cache.load(f.client, f.record, f.validate);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(cache.metrics.hits).toBe(0);
  },
);

test("warm-cache denial and post-validation denial never bypass metadata access", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  await cache.load(f.client, f.record, f.validate);
  f.info.mockResolvedValue({ data: null, error: { statusCode: 403, message: "denied" } });
  await expect(cache.load(f.client, f.record, f.validate)).rejects.toThrow("access denied");
  expect(f.validate).toHaveBeenCalledTimes(1);
  const g = await fixture();
  g.info
    .mockResolvedValueOnce({ data: g.revision, error: null })
    .mockResolvedValue({ data: null, error: { statusCode: 403, message: "denied" } });
  await expect(new SourceValidationCache().load(g.client, g.record, g.validate)).rejects.toThrow(
    "access denied",
  );
});

test("thrown metadata transport failure falls back, thrown denial does not", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  f.info.mockRejectedValue(new Error("fetch failed"));
  await cache.load(f.client, f.record, f.validate);
  expect(f.validate).toHaveBeenCalledTimes(1);
  f.info.mockRejectedValue(Object.assign(new Error(""), { statusCode: 403 }));
  await expect(cache.load(f.client, f.record, f.validate)).rejects.toThrow("access denied");
  expect(f.validate).toHaveBeenCalledTimes(1);
});

test("registry data hash rejects changed cached values even after the envelope checksum is recomputed", async () => {
  const f = await fixture(),
    directory = await temporary();
  await new SourceValidationCache({ directory }).load(f.client, f.record, f.validate);
  const file = path.join(directory, (await readdir(directory))[0]!);
  const envelope = JSON.parse(gunzipSync(await readFile(file)).toString());
  envelope.result.canonicalCsv = envelope.result.canonicalCsv.replace(/,100,/g, ",999,");
  const stable = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + stable((v as Record<string, unknown>)[k]))
            .join(",")}}`
        : JSON.stringify(v);
  envelope.resultHash =
    "sha256:" + createHash("sha256").update(stable(envelope.result)).digest("hex");
  await writeFile(file, gzipSync(JSON.stringify(envelope)));
  const cache = new SourceValidationCache({ directory });
  expect(await cache.load(f.client, f.record, f.validate)).toEqual(f.validation);
  expect(cache.metrics.invalidEntries).toBe(1);
  expect(f.validate).toHaveBeenCalledTimes(2);
});

test("compressed backtests retain full original validation and never use screening cache", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  f.record.source_type = "backtest";
  f.record.canonical_format = "csv.gz";
  await cache.load(f.client, f.record, f.validate);
  await cache.load(f.client, f.record, f.validate);
  expect(f.validate).toHaveBeenCalledTimes(2);
  expect(f.info).not.toHaveBeenCalled();
});
test("same size/mtime with a changed generation forces full validation", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  await cache.load(f.client, f.record, f.validate);
  f.revision.version = uuid(4);
  await cache.load(f.client, f.record, f.validate);
  expect(f.validate).toHaveBeenCalledTimes(2);
  expect(cache.metrics.hits).toBe(0);
});
test("revision change during first validation fails closed", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  f.validate.mockImplementation(async () => {
    f.revision.version = uuid(4);
    return f.validation;
  });
  await expect(cache.load(f.client, f.record, f.validate)).rejects.toThrow("version changed");
});
test("missing generation proof uses full validation every time", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  f.info.mockResolvedValue({ data: { ...f.revision, version: "" }, error: null });
  await cache.load(f.client, f.record, f.validate);
  await cache.load(f.client, f.record, f.validate);
  expect(f.validate).toHaveBeenCalledTimes(2);
  expect(cache.metrics.unavailableRevisions).toBe(2);
});
test.each([401, 403])(
  "revision authorization error %i cannot bypass to another source path",
  async (status) => {
    const f = await fixture(),
      cache = new SourceValidationCache();
    f.info.mockResolvedValue({
      data: null,
      error: { statusCode: status, message: "denied" },
    });
    await expect(cache.load(f.client, f.record, f.validate)).rejects.toThrow("access denied");
    expect(f.validate).not.toHaveBeenCalled();
  },
);
test("corrupted local cached values never substitute for fresh validation", async () => {
  const f = await fixture(),
    directory = await temporary();
  await new SourceValidationCache({ directory }).load(f.client, f.record, f.validate);
  const filename = path.join(directory, (await readdir(directory))[0]!);
  const envelope = JSON.parse(gunzipSync(await readFile(filename)).toString());
  envelope.result.canonicalCsv = envelope.result.canonicalCsv.replace(",100,", ",999,");
  await writeFile(filename, gzipSync(JSON.stringify(envelope)));
  const second = new SourceValidationCache({ directory });
  expect(await second.load(f.client, f.record, f.validate)).toEqual(f.validation);
  expect(f.validate).toHaveBeenCalledTimes(2);
  expect(second.metrics.invalidEntries).toBe(1);
});
test("changed registered hash does not reuse an older cache", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  await cache.load(f.client, f.record, f.validate);
  f.record.data_hash = `sha256:${"0".repeat(64)}`;
  await expect(cache.load(f.client, f.record, f.validate)).rejects.toThrow(
    "registered hash identity",
  );
  expect(f.validate).toHaveBeenCalledTimes(2);
});
test("validator fingerprint tracks transitive mapping content and dependency lock", async () => {
  const root = await temporary();
  await mkdir(path.join(root, "src/lib/maps"), { recursive: true });
  await writeFile(
    path.join(root, "src/lib/sourceData.ts"),
    'import { x } from "./maps/a"; export const y=x;',
  );
  await writeFile(
    path.join(root, "src/lib/maps/a.ts"),
    'import data from "./b.json"; export const x=data;',
  );
  await writeFile(path.join(root, "src/lib/maps/b.json"), '{"x":1}');
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const first = await sourceValidatorVersion(root);
  await writeFile(path.join(root, "src/lib/maps/b.json"), '{"x":2}');
  const second = await sourceValidatorVersion(root);
  expect(second).not.toBe(first);
  await writeFile(path.join(root, "package-lock.json"), '{"new":true}');
  expect(await sourceValidatorVersion(root)).not.toBe(second);
});

test.each(["import mapping from", "const mapping = require("])(
  "validator fingerprint follows @ aliases through %s and rejects computed dependencies",
  async (prefix) => {
    const root = await temporary();
    await mkdir(path.join(root, "src/lib"), { recursive: true });
    await writeFile(
      path.join(root, "src/lib/sourceData.ts"),
      `${prefix} "@/lib/map.json"${prefix.includes("require") ? ")" : ""}; export const v=mapping;`,
    );
    await writeFile(path.join(root, "src/lib/map.json"), '{"x":1}');
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const first = await sourceValidatorVersion(root);
    await writeFile(path.join(root, "src/lib/map.json"), '{"x":2}');
    expect(await sourceValidatorVersion(root)).not.toBe(first);
    await writeFile(
      path.join(root, "src/lib/sourceData.ts"),
      'const name="./mapping"; import(name);',
    );
    await expect(sourceValidatorVersion(root)).rejects.toThrow("cannot be cached");
  },
);
test("warm registry loader performs no raw download but retains full result parity", async () => {
  const f = await fixture(),
    cache = new SourceValidationCache();
  let records = [f.record];
  const download = vi.fn(async () => ({ data: new Blob([csv]), error: null }));
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) chain[method] = () => chain;
  chain["then"] = (resolve: (value: { data: SourceRecord[]; error: null }) => unknown) =>
    Promise.resolve({ data: records, error: null }).then(resolve);
  const client = {
    from: () => chain,
    storage: { from: () => ({ info: f.info, download }) },
  } as unknown as SupabaseClient;
  const first = await loadAnalysisSourceInputs(client, "user", "screening", {
    validationCache: cache,
  });
  const second = await loadAnalysisSourceInputs(client, "user", "screening", {
    validationCache: cache,
  });
  expect(second).toEqual(first);
  expect(download).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenLastCalledWith(
    "user/source.csv",
    { cacheNonce: expect.any(String) },
    { cache: "no-store" },
  );
  records = [{ ...f.record, data_hash: `sha256:${"f".repeat(64)}` }];
  await expect(
    loadAnalysisSourceInputs(client, "user", "screening", { validationCache: cache }),
  ).rejects.toThrow("해시 불일치");
});

test("production profiler reports read-only aggregate counters with equal cold/warm input", async () => {
  const f = await fixture(),
    download = vi.fn(async () => ({ data: new Blob([csv]), error: null }));
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) chain[method] = () => chain;
  chain["then"] = (resolve: (value: { data: SourceRecord[]; error: null }) => unknown) =>
    Promise.resolve({ data: [f.record], error: null }).then(resolve);
  const client = {
    from: () => chain,
    storage: { from: () => ({ info: f.info, download }) },
  } as unknown as SupabaseClient;
  const result = await profileSourceValidationCache(client, "user");
  expect(result.readOnly).toBe(true);
  expect(result.identityMatched).toBe(true);
  expect(result.warmReusedAll).toBe(true);
  expect(result.cold.metrics.fullValidations).toBe(1);
  expect(result.warm.metrics.hits).toBe(1);
  expect(download).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(f.record.storage_path);
  expect(JSON.stringify(result)).not.toContain(f.record.file_hash);
});

test("production profile CLI runs with explicit Vite configuration and no service access when unconfigured", async () => {
  const outcome = await promisify(execFile)(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs"),
      "--config",
      "vitest.source-pipeline.config.ts",
      "scripts/run-source-validation-profile.ts",
    ],
    { cwd: process.cwd(), env: { PATH: process.env["PATH"] ?? "" } },
  ).then(
    () => null,
    (error) => error,
  );
  expect(outcome).not.toBeNull();
  expect(outcome.code).toBe(1);
  expect(JSON.parse(outcome.stderr.trim())).toEqual({
    ok: false,
    stage: "configuration",
    reason: "missing_user",
  });
}, 30000);
