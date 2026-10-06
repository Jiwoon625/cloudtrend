import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CANONICAL_SOURCE_COLUMNS,
  validateSourceBytes,
  type SourceValidationResult,
} from "../src/lib/sourceData";
import { listSourceRecords, type SourceRecord } from "./source-registry-store";
import { trustedSupabaseClient, codeVersion } from "./analysis-run-store";
import { sourceValidatorVersion } from "./source-validation-cache";
import {
  COMPACTION_ALGORITHM,
  COMPACTION_TARGET_BYTES,
  ScreeningCompactor,
  bytesHash,
  stableValueHash,
  canonicalRowsHash,
  canonicalSourceDataHash,
  sourceDescriptor,
  assertSourceOrderUnambiguous,
  registrySourceSetHash,
  originalTimingEvidence,
  logicalTimingHash,
} from "./screening-compaction-core";

type Generation = { storage_object_id: string; storage_object_version: string };
type BoundSource = SourceRecord & Generation;
type Verification = {
  datasetDigest: string;
  sectorDatasetDigest: string;
  analysisDigest: string;
  configHash: string;
  asOfDate: string;
  stats: unknown;
};
type CachedSource = {
  proofVersion: number;
  descriptor: Record<string, unknown>;
  validatorFingerprint: string;
  canonicalHash: string;
  validation: Omit<SourceValidationResult, "rows" | "canonicalCsv">;
};

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function json(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function saveJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
function compactValidation(validation: SourceValidationResult) {
  const { rows: _rows, canonicalCsv: _csv, ...rest } = validation;
  return rest;
}

function evidencePath(owner: string, scope: string, file: string) {
  requireThat(/^sha256:[0-9a-f]{64}$/.test(scope), "Expected source-set hash is invalid");
  return `${owner}/results/compaction/${scope.slice(7)}/${file}`;
}

async function persistEvidence(
  client: SupabaseClient,
  owner: string,
  scope: string,
  file: string,
  value: unknown,
) {
  const { error } = await client.storage
    .from("cloudtrend-data")
    .upload(evidencePath(owner, scope, file), JSON.stringify(value), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "0",
    });
  if (error)
    throw new Error(
      "Private compaction evidence could not be preserved; inspect the active set before retrying",
    );
}

export async function assertCompactionRpcAvailable(client: SupabaseClient) {
  // The reviewed RPC rejects null identities before locks or writes. This
  // preflight distinguishes a missing/stale migration before large source reads.
  const { error } = await client.rpc("compact_screening_source_set", {
    p_user_id: null,
    p_operation_id: null,
    p_expected_sources: [],
    p_candidates: [],
    p_verification: {},
  });
  requireThat(
    error?.code === "P0001" &&
      error.message === "screening compaction requires owner and operation ids",
    "Reviewed compaction RPC is unavailable; apply/verify its migration before source processing",
  );
}

export async function restorePrivateCompactionEvidence(
  options: { userId: string; output: string; expectedSourceHash: string },
  client = trustedSupabaseClient(),
) {
  await mkdir(options.output, { recursive: true });
  const restored = new Map<string, Record<string, unknown>>();
  for (const file of ["compaction-manifest.json", "cutover-arguments.json"]) {
    const { data, error } = await client.storage
      .from("cloudtrend-data")
      .download(
        evidencePath(options.userId, options.expectedSourceHash, file),
        { cacheNonce: randomUUID() },
        { cache: "no-store" },
      );
    if (error) {
      const failure = error as unknown as Record<string, unknown>;
      if (Number(failure["statusCode"] ?? failure["status"]) === 404) continue;
      throw new Error("Private compaction evidence lookup failed; access errors are not bypassed");
    }
    requireThat(
      data && data.size < 2 * 1024 * 1024,
      "Private compaction evidence is unexpectedly large",
    );
    const value = JSON.parse(await data.text());
    requireThat(
      (file === "cutover-arguments.json" ? value.p_user_id : value.owner) === options.userId,
      "Private compaction evidence owner mismatch",
    );
    restored.set(file, value);
  }
  const manifest = restored.get("compaction-manifest.json");
  const args = restored.get("cutover-arguments.json");
  if (manifest) {
    requireThat(
      Array.isArray(manifest["parents"]) &&
        registrySourceSetHash(manifest["parents"] as Array<{ id: string; file_hash: string }>) ===
          options.expectedSourceHash,
      "Private compaction manifest differs from the approved source snapshot",
    );
  }
  if (args) {
    requireThat(
      manifest &&
        Array.isArray(args["p_expected_sources"]) &&
        Array.isArray(args["p_candidates"]) &&
        registrySourceSetHash(
          args["p_expected_sources"] as Array<{ id: string; file_hash: string }>,
        ) === options.expectedSourceHash &&
        stableValueHash(args["p_expected_sources"]) === stableValueHash(manifest["parents"]) &&
        args["p_operation_id"] === manifest["operationId"] &&
        stableValueHash(
          (args["p_candidates"] as Array<{ id: string }>).map((candidate) => candidate.id),
        ) === stableValueHash(manifest["plannedCandidateIds"]),
      "Private compaction manifest and retry arguments do not describe one approved operation",
    );
  }
  // Old local arguments never count as a fresh remote restore result.
  for (const [file, value] of restored) await saveJson(path.join(options.output, file), value);
  return Boolean(args);
}

/** Hash validator source and all local import dependencies, not an operator-maintained version string. */
export async function compactionValidatorFingerprint(root: string) {
  return sourceValidatorVersion(root);
}

async function generation(
  client: SupabaseClient,
  source: Pick<SourceRecord, "storage_bucket" | "storage_path">,
): Promise<Generation> {
  const { data, error } = await client.storage
    .from(source.storage_bucket)
    .info(source.storage_path);
  if (error) throw new Error("Storage generation lookup failed; active sources are unchanged");
  const info = data as unknown as Record<string, unknown>;
  requireThat(
    typeof info["id"] === "string" &&
      typeof info["version"] === "string" &&
      info["id"] &&
      info["version"],
    "Storage object generation is unavailable; compaction stopped",
  );
  return { storage_object_id: info["id"], storage_object_version: info["version"] };
}

async function download(
  client: SupabaseClient,
  source: Pick<SourceRecord, "storage_bucket" | "storage_path">,
) {
  const { data, error } = await client.storage
    .from(source.storage_bucket)
    .download(source.storage_path, { cacheNonce: randomUUID() }, { cache: "no-store" });
  if (error) throw new Error("Source object download failed; active sources are unchanged");
  return new Uint8Array(await data.arrayBuffer());
}

async function verifiedCanonical(
  client: SupabaseClient,
  source: SourceRecord,
  directory: string,
  validatorFingerprint: string,
) {
  requireThat(
    source.canonical_format === "csv" && /\.csv$/i.test(source.original_filename),
    "This compaction implementation accepts registered CSV sources only",
  );
  const observed = await generation(client, source);
  const bound: BoundSource = { ...source, ...observed };
  const descriptor = sourceDescriptor(bound as unknown as Record<string, unknown>);
  const rawPath = path.join(directory, `${source.id}.raw`);
  const canonicalPath = path.join(directory, `${source.id}.canonical.csv`);
  const receiptPath = path.join(directory, `${source.id}.validation.json`);
  if (existsSync(receiptPath) && existsSync(rawPath) && existsSync(canonicalPath)) {
    const receipt = (await json(receiptPath)) as CachedSource;
    if (
      receipt.proofVersion === 2 &&
      receipt.validatorFingerprint === validatorFingerprint &&
      stableValueHash(receipt.descriptor) === stableValueHash(descriptor)
    ) {
      const raw = await readFile(rawPath),
        canonical = await readFile(canonicalPath, "utf8");
      if (
        bytesHash(raw) === source.file_hash &&
        raw.length === source.file_size_bytes &&
        bytesHash(canonical) === receipt.canonicalHash &&
        canonicalSourceDataHash(canonical) === source.data_hash
      ) {
        console.log("Validated immutable source cache reused");
        return { bound, canonicalPath };
      }
    }
  }
  const raw = await download(client, source);
  requireThat(
    raw.byteLength === source.file_size_bytes && bytesHash(raw) === source.file_hash,
    "Original source size/hash differs from its registry",
  );
  const validation = await validateSourceBytes({
    bytes: raw,
    filename: source.original_filename,
    streamingCsv: true,
  });
  requireThat(validation.valid, "Original source validation failed");
  requireThat(
    validation.fileHash === source.file_hash &&
      validation.dataHash === source.data_hash &&
      validation.schemaHash === source.schema_hash,
    "Original source validation hashes differ from its registry",
  );
  requireThat(
    stableValueHash(observed) === stableValueHash(await generation(client, source)),
    "Source changed while it was validated",
  );
  await writeFile(rawPath, raw);
  await writeFile(canonicalPath, validation.canonicalCsv);
  await saveJson(receiptPath, {
    proofVersion: 2,
    descriptor,
    validatorFingerprint,
    canonicalHash: bytesHash(validation.canonicalCsv),
    validation: compactValidation(validation),
  });
  return { bound, canonicalPath };
}

export async function verifyInIsolatedProcess(root: string, manifest: string, output: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv.filter((arg) => /^--max-old-space-size=\d+$/.test(arg)),
        path.join(root, "node_modules/vite-node/vite-node.mjs"),
        "--config",
        path.join(root, "vitest.compaction.config.ts"),
        path.join(root, "scripts/verify-screening-compaction.ts"),
        "--",
        manifest,
        output,
      ],
      {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
        // Do not inherit credentials or test-worker IPC/runtime variables.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"].includes(
              key,
            ),
          ),
        ),
      },
    );
    child.on("error", () => reject(new Error("Compaction verification process could not start")));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Compaction verification failed with exit ${code}`)),
    );
  });
  return (await json(output)) as Verification;
}

function candidateRecord(
  sourceId: string,
  userId: string,
  operationId: string,
  part: number,
  validation: SourceValidationResult,
  parentFingerprint: string,
  validatorFingerprint: string,
) {
  return {
    id: sourceId,
    user_id: userId,
    source_type: "screening",
    original_filename: validation.originalFilename,
    storage_bucket: "cloudtrend-data",
    storage_path: `${userId}/source/screening/${sourceId}/${validation.originalFilename}`,
    content_type: "text/csv",
    canonical_format: "csv",
    file_size_bytes: validation.originalSizeBytes,
    normalized_size_bytes: validation.normalizedSizeBytes,
    file_hash: validation.fileHash,
    data_hash: validation.dataHash,
    schema_hash: validation.schemaHash,
    row_count: validation.stats.rowCount,
    symbol_count: validation.stats.symbolCount,
    min_date: validation.stats.minDate,
    max_date: validation.stats.maxDate,
    market_count: validation.stats.marketCount,
    kospi_count: validation.stats.kospiCount,
    kosdaq_count: validation.stats.kosdaqCount,
    stock_count: validation.stats.stockCount,
    etf_count: validation.stats.etfCount,
    sector_mapped_count: validation.stats.sectorMappedCount,
    sector_unmapped_count: validation.stats.sectorUnmappedCount,
    upload_source: "migration",
    status: "valid",
    activated_at: null,
    validation_result: {
      valid: true,
      format: "csv",
      columns: validation.columns,
      stats: validation.stats,
      errors: [],
      warnings: validation.warnings.slice(0, 100),
      hashes: {
        file: validation.fileHash,
        data: validation.dataHash,
        schema: validation.schemaHash,
      },
      compactionCandidate: {
        operationId,
        part,
        parentFingerprint,
        validatorFingerprint,
        algorithm: COMPACTION_ALGORITHM,
      },
    },
    overlap_result: null,
  };
}

export async function runCompaction(
  options: {
    userId: string;
    output: string;
    apply: boolean;
    targetBytes?: number;
    expectedSourceHash?: string;
    persistPrivateEvidence?: boolean;
  },
  dependencies?: {
    client: SupabaseClient;
    listSources: typeof listSourceRecords;
    verify: typeof verifyInIsolatedProcess;
  },
) {
  const root = process.cwd(),
    directory = path.resolve(options.output);
  requireThat(/^[0-9a-f-]{36}$/i.test(options.userId), "A valid owner UUID is required");
  await mkdir(path.join(directory, "sources"), { recursive: true });
  await mkdir(path.join(directory, "candidates"), { recursive: true });
  const client = dependencies?.client ?? trustedSupabaseClient();
  if (options.apply) await assertCompactionRpcAvailable(client);
  const listSources = dependencies?.listSources ?? listSourceRecords;
  const verify = dependencies?.verify ?? verifyInIsolatedProcess;
  const sources = await listSources(client, options.userId, "screening");
  const approvedSourceHash = registrySourceSetHash(sources);
  if (options.apply || options.expectedSourceHash)
    requireThat(
      options.expectedSourceHash === approvedSourceHash,
      "Active source set differs from the explicitly approved compaction snapshot",
    );
  requireThat(
    sources.length > 1 && sources.length < 1000,
    "Source list is empty, already compact, or may be truncated",
  );
  assertSourceOrderUnambiguous(sources);
  const validatorFingerprint = await compactionValidatorFingerprint(root);
  const parents: BoundSource[] = [],
    canonicalFiles: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    console.log(`Verify original ${i + 1}/${sources.length}`);
    const input = await verifiedCanonical(
      client,
      sources[i]!,
      path.join(directory, "sources"),
      validatorFingerprint,
    );
    parents.push(input.bound);
    canonicalFiles.push(input.canonicalPath);
  }
  const descriptors = parents.map((source) =>
    sourceDescriptor(source as unknown as Record<string, unknown>),
  );
  const parentFingerprint = stableValueHash(descriptors);
  const manifestPath = path.join(directory, "compaction-manifest.json");
  const previous = existsSync(manifestPath) ? await json(manifestPath) : null;
  const reusablePlan =
    previous?.validatorFingerprint === validatorFingerprint &&
    stableValueHash(previous?.parents) === parentFingerprint &&
    Array.isArray(previous?.plannedCandidateIds);
  const operationId = reusablePlan ? String(previous.operationId) : randomUUID();
  await saveJson(path.join(directory, "original-inputs.json"), { canonicalFiles });
  console.log("Verify baseline dataset and analysis in an isolated process");
  const before = await verify(
    root,
    path.join(directory, "original-inputs.json"),
    path.join(directory, "before.json"),
  );
  const compactor = new ScreeningCompactor();
  for (const file of canonicalFiles) compactor.addCanonicalCsv(await readFile(file, "utf8"));
  const effectiveRowsHash = compactor.effectiveRowsHash();
  const candidates: Array<{ file: string; record: ReturnType<typeof candidateRecord> }> = [];
  let part = 0;
  for (const chunk of compactor.chunks(options.targetBytes ?? COMPACTION_TARGET_BYTES)) {
    const filename = `screening_compacted_${before.asOfDate}_${String(part).padStart(3, "0")}.csv`;
    const file = path.join(directory, "candidates", filename);
    const validation = await validateSourceBytes({
      bytes: Buffer.from(chunk.text),
      filename,
      streamingCsv: true,
    });
    requireThat(
      validation.valid && validation.stats.rowCount === chunk.rowCount,
      "A candidate failed source validation",
    );
    requireThat(
      validation.canonicalCsv === chunk.text,
      "Candidate normalization changed its values or column contract",
    );
    await writeFile(file, chunk.text);
    candidates.push({
      file,
      record: candidateRecord(
        reusablePlan && previous.plannedCandidateIds[part]
          ? String(previous.plannedCandidateIds[part])
          : randomUUID(),
        options.userId,
        operationId,
        part++,
        validation,
        parentFingerprint,
        validatorFingerprint,
      ),
    });
  }
  requireThat(
    candidates.length > 0 && candidates.length < sources.length,
    "Compaction did not reduce the active file count",
  );
  requireThat(
    canonicalRowsHash(await Promise.all(candidates.map((c) => readFile(c.file, "utf8")))) ===
      effectiveRowsHash,
    "Canonical field preservation failed",
  );
  await saveJson(path.join(directory, "candidate-inputs.json"), {
    canonicalFiles: candidates.map((c) => c.file),
  });
  console.log("Verify candidate dataset and analysis in an isolated process");
  const after = await verify(
    root,
    path.join(directory, "candidate-inputs.json"),
    path.join(directory, "after.json"),
  );
  requireThat(
    stableValueHash(before) === stableValueHash(after),
    "Dataset/analysis/config/statistics parity failed; no active source was changed",
  );
  const sourceEvidence = originalTimingEvidence(parents);
  const timingBefore = logicalTimingHash(parents);
  const timingAfter = logicalTimingHash(
    candidates.map(({ record }) => ({
      ...record,
      created_at: new Date().toISOString(),
      activated_at: new Date().toISOString(),
      validation_result: {
        ...record.validation_result,
        screeningCompaction: { original_source_evidence: sourceEvidence },
      },
    })),
  );
  requireThat(timingBefore === timingAfter, "Original source timing provenance changed");
  const verification = {
    algorithm: COMPACTION_ALGORITHM,
    schema_version: CANONICAL_SOURCE_COLUMNS.length,
    source_fingerprint: parentFingerprint,
    candidate_fingerprint: "",
    dataset_before: before.datasetDigest,
    dataset_after: after.datasetDigest,
    analysis_before: before.analysisDigest,
    analysis_after: after.analysisDigest,
    effective_rows_before: compactor.rowCount,
    effective_rows_after: compactor.rowCount,
    timing_before: timingBefore,
    timing_after: timingAfter,
    config_hash: before.configHash,
    code_version: codeVersion(),
  };
  const manifest = {
    operationId,
    owner: options.userId,
    approvedSourceHash,
    validatorFingerprint,
    parents: descriptors,
    candidates,
    plannedCandidateIds: candidates.map((candidate) => candidate.record.id),
    verification,
    inputRows: compactor.inputRows,
    effectiveRows: compactor.rowCount,
    effectiveRowsHash,
    originalSourceEvidence: sourceEvidence,
    symbols: compactor.symbolCount,
    duplicateRows: compactor.duplicateRows,
    preservedEnrichmentCells: compactor.preservedEnrichmentCells,
    originalBytes: sources.reduce((sum, s) => sum + s.file_size_bytes, 0),
    candidateBytes: candidates.reduce((sum, c) => sum + c.record.file_size_bytes, 0),
    before,
    after,
    state: "verified_local_only",
  };
  await saveJson(path.join(directory, "compaction-manifest.json"), manifest);
  console.log(
    JSON.stringify({
      state: manifest.state,
      fromFiles: sources.length,
      toFiles: candidates.length,
      originalBytes: manifest.originalBytes,
      candidateBytes: manifest.candidateBytes,
      datasetParity: true,
      analysisParity: true,
    }),
  );
  if (!options.apply) return manifest;
  const persist = async (name: string, value: unknown) => {
    if (options.persistPrivateEvidence)
      await persistEvidence(client, options.userId, approvedSourceHash, name, value);
  };
  await persist("compaction-manifest.json", manifest);
  const staged: BoundSource[] = [];
  await saveJson(path.join(directory, "compaction-manifest.json"), {
    ...manifest,
    state: "staging_inactive",
  });
  // Candidates are inactive until the single transaction below commits. Never delete originals.
  for (const candidate of candidates) {
    const bytes = await readFile(candidate.file);
    const { data: existing, error: lookupError } = await client
      .from("analysis_source_files")
      .select("*")
      .eq("id", candidate.record.id)
      .eq("user_id", options.userId)
      .maybeSingle();
    if (lookupError)
      throw new Error("Candidate staging lookup failed; original active set is unchanged");
    if (existing)
      requireThat(
        existing.status === "valid" &&
          existing.activated_at === null &&
          existing.validation_result?.compactionCandidate?.operationId === operationId,
        "Candidate id is already used by another state or operation",
      );
    const { data: stored, error: infoError } = await client.storage
      .from(candidate.record.storage_bucket)
      .info(candidate.record.storage_path);
    if (infoError) {
      const failure = infoError as unknown as Record<string, unknown>;
      requireThat(
        Number(failure["statusCode"] ?? failure["status"]) === 404,
        "Candidate object lookup failed; access errors are not bypassed",
      );
      const { error: uploadError } = await client.storage
        .from(candidate.record.storage_bucket)
        .upload(candidate.record.storage_path, bytes, { contentType: "text/csv", upsert: false });
      if (uploadError)
        throw new Error("Candidate staging upload failed; original active set is unchanged");
    } else requireThat(stored, "Candidate object lookup returned no result");
    const uploadedGeneration = await generation(client, candidate.record);
    requireThat(
      bytesHash(await download(client, candidate.record)) === candidate.record.file_hash,
      "Candidate upload round-trip hash failed",
    );
    requireThat(
      stableValueHash(uploadedGeneration) ===
        stableValueHash(await generation(client, candidate.record)),
      "Candidate object changed during round-trip verification",
    );
    let data = existing;
    if (data) {
      const actual = sourceDescriptor({ ...data, ...uploadedGeneration });
      const expected = sourceDescriptor({
        ...candidate.record,
        created_at: data.created_at,
        ...uploadedGeneration,
      });
      requireThat(
        stableValueHash(actual) === stableValueHash(expected),
        "Previously staged candidate descriptor changed",
      );
    } else {
      const inserted = await client
        .from("analysis_source_files")
        .insert(candidate.record)
        .select("*")
        .single();
      if (inserted.error || !inserted.data)
        throw new Error("Candidate registry staging failed; original active set is unchanged");
      data = inserted.data;
    }
    staged.push({ ...data, ...uploadedGeneration } as BoundSource);
    await saveJson(path.join(directory, "compaction-manifest.json"), {
      ...manifest,
      state: "staging_inactive",
      stagedCandidateIds: staged.map((source) => source.id),
    });
    await persist("compaction-manifest.json", {
      ...manifest,
      state: "staging_inactive",
      stagedCandidateIds: staged.map((source) => source.id),
    });
  }
  const stagedDescriptors = staged.map((source) =>
    sourceDescriptor(source as unknown as Record<string, unknown>),
  );
  verification.candidate_fingerprint = stableValueHash(stagedDescriptors);
  await saveJson(path.join(directory, "compaction-manifest.json"), {
    ...manifest,
    candidates: stagedDescriptors,
    verification,
    state: "staged_inactive",
  });
  for (const original of parents)
    requireThat(
      stableValueHash(await generation(client, original)) ===
        stableValueHash({
          storage_object_id: original.storage_object_id,
          storage_object_version: original.storage_object_version,
        }),
      "Original changed before cutover; active set is unchanged",
    );
  const args = {
    p_user_id: options.userId,
    p_operation_id: operationId,
    p_expected_sources: descriptors,
    p_candidates: stagedDescriptors,
    p_verification: verification,
  };
  await saveJson(path.join(directory, "cutover-arguments.json"), args);
  await persist("cutover-arguments.json", args);
  const { data: receipt, error } = await client.rpc("compact_screening_source_set", args);
  if (error)
    throw new Error(
      "Atomic cutover was not confirmed. Originals and candidates are preserved; inspect the operation receipt before retrying",
    );
  await saveJson(path.join(directory, "cutover-receipt.json"), receipt);
  await persist("cutover-receipt.json", receipt);
  requireThat(
    logicalTimingHash([{ validation_result: { screeningCompaction: receipt } }]) === timingBefore,
    "Cutover receipt timing evidence differs; inspect the committed operation",
  );
  const active = await listSources(client, options.userId, "screening");
  requireThat(
    stableValueHash(active.map((s) => s.id).sort()) ===
      stableValueHash(staged.map((s) => s.id).sort()),
    "Cutover committed but active set readback changed; inspect receipt",
  );
  console.log(
    JSON.stringify({
      state: "cutover_verified",
      operationId,
      activeFiles: active.length,
      originalsRetained: true,
      datasetParity: true,
      analysisParity: true,
    }),
  );
  return { ...manifest, state: "cutover_verified", receipt };
}

export async function retryCompactionCutover(
  options: {
    userId: string;
    output: string;
    expectedSourceHash?: string;
    persistPrivateEvidence?: boolean;
  },
  client = trustedSupabaseClient(),
) {
  const args = await json(path.join(options.output, "cutover-arguments.json"));
  requireThat(
    args.p_user_id === options.userId &&
      Array.isArray(args.p_candidates) &&
      Array.isArray(args.p_expected_sources) &&
      options.expectedSourceHash &&
      registrySourceSetHash(args.p_expected_sources) === options.expectedSourceHash,
    "Saved cutover owner/arguments are invalid",
  );
  // The SQL function independently compares exact rows, object generations and
  // the original operation receipt. Never regenerate IDs after an uncertain commit.
  const { data, error } = await client.rpc("compact_screening_source_set", args);
  if (error)
    throw new Error(
      "Exact cutover retry was not confirmed; preserve evidence and inspect the saved operation",
    );
  await saveJson(path.join(options.output, "cutover-receipt.json"), data);
  if (options.persistPrivateEvidence && options.expectedSourceHash)
    await persistEvidence(
      client,
      options.userId,
      options.expectedSourceHash,
      "cutover-receipt.json",
      data,
    );
  console.log(
    JSON.stringify({
      state: "cutover_receipt_verified",
      activeFiles: Array.isArray(data?.candidate_ids) ? data.candidate_ids.length : null,
      originalsRetained: true,
    }),
  );
  return data;
}
