import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import {
  cacheKeyFor,
  materialize,
  type BacktestSourceCacheManifestFile,
} from "../scripts/backtest-source-cache";
import {
  loadResearchTexts,
  parseSharedMarketData,
  buildSharedSignalContext,
} from "../scripts/research-shared-input";

const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const temp = await mkdtemp(path.join(tmpdir(), "ct-cache-test-"));
let downloads = 0;
const raw = await readFile("tests/fixtures/source-valid.csv");
const compressed = gzipSync(raw);
const additionalRaw = Buffer.concat([raw, Buffer.from("\n")]);
const additionalCompressed = gzipSync(additionalRaw);
const server = createServer((req, res) => {
  downloads++;
  res.setHeader("Content-Type", "application/octet-stream");
  res.end(req.url?.includes("additional") ? additionalCompressed : compressed);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
process.env["SUPABASE_URL"] = `http://127.0.0.1:${address.port}`;
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-key";
const file: BacktestSourceCacheManifestFile = {
  id: "fixture",
  fileName: "fixture.csv",
  bytes: raw.byteLength,
  savedAt: "2026-09-18",
  fileHash: hash(raw),
  dataHash: hash(raw),
  schemaHash: hash(Buffer.from("schema")),
  storageBucket: "test",
  storagePath: "owner/input.csv.gz",
  storageBytes: compressed.byteLength,
  storageFileHash: hash(compressed),
  canonicalFormat: "csv.gz",
  cacheFile: `${hash(raw).slice(7)}.source`,
};
const manifestPath = path.join(temp, "manifest.json");
const options = { mode: "materialize" as const, userId: null, manifestPath, cacheDir: temp };
async function manifest(files: BacktestSourceCacheManifestFile[]) {
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceType: "backtest",
      cacheKey: cacheKeyFor(files),
      fileCount: files.length,
      totalBytes: files.reduce((n, f) => n + f.bytes, 0),
      files,
    }),
  );
}
try {
  await manifest([file]);
  assert.equal((await materialize(options)).downloadedFiles, 1);
  assert.equal(downloads, 1);
  delete process.env["SUPABASE_URL"];
  delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
  assert.equal(
    (await materialize(options)).downloadedFiles,
    0,
    "warm cache must work without Supabase credentials",
  );
  assert.equal(downloads, 1);
  assert.equal(
    cacheKeyFor([file]),
    cacheKeyFor([{ ...file, storagePath: "new/path", storageFileHash: hash(raw) }]),
    "physical conversion preserves cache",
  );
  assert.notEqual(
    cacheKeyFor([file]),
    cacheKeyFor([{ ...file, dataHash: hash(Buffer.from("changed")) }]),
    "changed data invalidates cache",
  );
  const additional = {
    ...file,
    id: "additional",
    storagePath: "owner/additional.csv.gz",
    bytes: additionalRaw.byteLength,
    fileHash: hash(additionalRaw),
    dataHash: hash(additionalRaw),
    storageBytes: additionalCompressed.byteLength,
    storageFileHash: hash(additionalCompressed),
    cacheFile: `${hash(additionalRaw).slice(7)}.source`,
  };
  process.env["SUPABASE_URL"] = `http://127.0.0.1:${address.port}`;
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-key";
  await manifest([file, additional]);
  const incremental = await materialize(options);
  assert.equal(incremental.cacheHits, 1);
  assert.equal(incremental.downloadedFiles, 1, "new file does not redownload existing source");
  assert.equal(downloads, 2);
  await manifest([file]);
  const source1 = await loadResearchTexts(manifestPath, temp);
  const source2 = await loadResearchTexts(manifestPath, temp);
  assert.equal(source1, source2);
  const parsed = parseSharedMarketData(source1.texts);
  assert.equal(parsed, parseSharedMarketData(source2.texts));
  assert.equal(
    buildSharedSignalContext(parsed.dataset, 613),
    buildSharedSignalContext(parsed.dataset, 613),
  );
  await writeFile(path.join(temp, file.cacheFile), "corrupt");
  process.env["SUPABASE_URL"] = `http://127.0.0.1:${address.port}`;
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-key";
  assert.equal((await materialize(options)).downloadedFiles, 1, "corrupt cache repaired");
  assert.deepEqual(await readFile(path.join(temp, file.cacheFile)), raw);
  await manifest([
    { ...file, storageFileHash: hash(Buffer.from("bad")), cacheFile: `${"a".repeat(64)}.source` },
  ]);
  await assert.rejects(materialize(options), /무결성/);
  console.log(
    "PASS: gzip integrity, zero-download warm cache, migration stability, invalidation, shared parsing/context, corruption repair",
  );
} finally {
  server.close();
  await rm(temp, { recursive: true, force: true });
}
