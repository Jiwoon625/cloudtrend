import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CANONICAL_SOURCE_COLUMNS,
  sourceRowKey,
  toCanonicalCsv,
  visitDelimitedRows,
  type CanonicalSourceRow,
  type SourceValidationResult,
} from "../src/lib/sourceData";
import type { SourceRecord } from "./source-registry-store";

const FORMAT = "cloudtrend-source-validation-cache-v2-fresh-origin";
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Hash actual validator sources, transitive local mappings, dependency lock and runtime. */
export async function sourceValidatorVersion(root = process.cwd()): Promise<string> {
  const files = new Map<string, string>();
  async function visit(relative: string) {
    if (files.has(relative)) return;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep))
      throw new Error("Validator dependency escaped repository");
    const text = await readFile(absolute, "utf8");
    files.set(relative, hash(text));
    if (relative.endsWith(".json")) return;
    for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*([^\s])/g))
      if (match[1] !== '"' && match[1] !== "'")
        throw new Error("Computed validator dependency cannot be cached safely");
    const imports =
      /(?:\b(?:import|export)\s+(?:[^"'();]*?\s+from\s+)?["']([^"']+)["'])|(?:\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\))/g;
    for (const match of text.matchAll(imports)) {
      const specifier = match[1] ?? match[2]!;
      if (/^(?:#|~|\/)/.test(specifier))
        throw new Error("Unresolved validator alias cannot be cached safely");
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const base = specifier.startsWith("@/")
        ? path.posix.normalize(`src/${specifier.slice(2)}`)
        : path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      const candidates = /\.(ts|tsx|js|json)$/.test(base)
        ? [base]
        : [`${base}.ts`, `${base}.tsx`, `${base}.json`, `${base}/index.ts`];
      let resolved = false;
      for (const candidate of candidates) {
        try {
          await visit(candidate);
          resolved = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!resolved) throw new Error("Validator dependency could not be resolved");
    }
  }
  await visit("src/lib/sourceData.ts");
  files.set("package-lock.json", hash(await readFile(path.join(root, "package-lock.json"))));
  return hash(
    canonical({
      format: FORMAT,
      files: [...files].sort(([a], [b]) => a.localeCompare(b)),
      node: process.versions.node,
      locale: new Intl.Collator().resolvedOptions().locale,
    }),
  );
}

interface Revision {
  id: string;
  version: string;
}
function revisionAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== "object")
    return /access.?denied|permission|unauthorized|forbidden|row.level/i.test(String(error ?? ""));
  const details = error as Record<string, unknown>;
  const deniedStatus = [details["status"], details["statusCode"], details["httpStatusCode"]].some(
    (value) => [401, 403].includes(Number(value)),
  );
  const identifiers = [details["code"], details["error"], details["name"], details["message"]]
    .filter((value) => typeof value === "string")
    .join(" ");
  return (
    deniedStatus || /access.?denied|permission|unauthorized|forbidden|row.level/i.test(identifiers)
  );
}
interface Identity {
  owner: string;
  sourceId: string;
  bucket: string;
  objectPath: string;
  fileHash: string;
  logicalFileHash: string;
  dataHash: string;
  schemaHash: string;
  filename: string;
  contentType: string;
  canonicalFormat: string;
  validatorVersion: string;
  revision: Revision;
}
interface Envelope {
  format: typeof FORMAT;
  identity: Identity;
  result: Omit<SourceValidationResult, "rows">;
  resultHash: string;
}
export interface SourceValidationCacheMetrics {
  hits: number;
  fullValidations: number;
  unavailableRevisions: number;
  invalidEntries: number;
}

/**
 * A hit requires a fresh authenticated object generation, never size/mtime alone.
 * Supabase assigns a fresh UUID for each uploaded object generation. See
 * https://github.com/supabase/storage/blob/master/src/storage/uploader.ts#L99-L112
 * and https://supabase.com/docs/reference/javascript/file-buckets-info.
 */
export class SourceValidationCache {
  readonly metrics: SourceValidationCacheMetrics = {
    hits: 0,
    fullValidations: 0,
    unavailableRevisions: 0,
    invalidEntries: 0,
  };
  private readonly memory = new Map<string, Buffer>();
  private memoryBytes = 0;
  private readonly validator: Promise<string | null>;
  constructor(private readonly options: { directory?: string; root?: string } = {}) {
    // Cache setup failure must not make previously working validation unavailable.
    this.validator = sourceValidatorVersion(options.root).catch(() => null);
  }
  private async revision(client: SupabaseClient, record: SourceRecord): Promise<Revision | null> {
    const storage = client.storage.from(record.storage_bucket);
    if (typeof storage.info !== "function") return null;
    let response: Awaited<ReturnType<typeof storage.info>>;
    try {
      response = await storage.info(record.storage_path);
    } catch (error) {
      if (revisionAccessDenied(error))
        throw new Error(
          "Source object revision access denied; validation cache cannot bypass access checks",
        );
      return null;
    }
    const { data, error } = response;
    if (error) {
      if (revisionAccessDenied(error))
        throw new Error(
          "Source object revision access denied; validation cache cannot bypass access checks",
        );
      return null;
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!data || !uuid.test(data.id) || !uuid.test(data.version)) return null;
    if (data.name !== record.storage_path || data.bucketId !== record.storage_bucket) return null;
    return { id: data.id, version: data.version };
  }
  private identity(record: SourceRecord, revision: Revision, validatorVersion: string): Identity {
    const migration = record.validation_result?.["backtestCanonicalMigration"] as
      Record<string, unknown> | undefined;
    const logicalFileHash =
      typeof migration?.["logicalFileHash"] === "string"
        ? migration["logicalFileHash"]
        : record.file_hash;
    return {
      owner: record.user_id,
      sourceId: record.id,
      bucket: record.storage_bucket,
      objectPath: record.storage_path,
      fileHash: record.file_hash,
      logicalFileHash,
      dataHash: record.data_hash,
      schemaHash: record.schema_hash,
      filename: record.original_filename,
      contentType: record.content_type,
      canonicalFormat: record.canonical_format,
      validatorVersion,
      revision,
    };
  }
  private remember(key: string, bytes: Buffer) {
    if (bytes.byteLength > MAX_MEMORY_BYTES) return;
    const old = this.memory.get(key);
    if (old) {
      this.memoryBytes -= old.byteLength;
      this.memory.delete(key);
    }
    while (this.memoryBytes + bytes.byteLength > MAX_MEMORY_BYTES) {
      const first = this.memory.keys().next().value;
      if (!first) break;
      this.memoryBytes -= this.memory.get(first)!.byteLength;
      this.memory.delete(first);
    }
    this.memory.set(key, bytes);
    this.memoryBytes += bytes.byteLength;
  }
  private decode(bytes: Buffer, identity: Identity): SourceValidationResult | null {
    try {
      const envelope = JSON.parse(
        gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }).toString("utf8"),
      ) as Envelope;
      const result = envelope.result;
      if (
        envelope.format !== FORMAT ||
        canonical(envelope.identity) !== canonical(identity) ||
        hash(canonical(result)) !== envelope.resultHash ||
        result.valid !== true ||
        result.errors.length !== 0 ||
        result.fileHash !== identity.logicalFileHash ||
        result.dataHash !== identity.dataHash ||
        result.schemaHash !== identity.schemaHash
      )
        return null;
      if (hash(JSON.stringify([...new Set(result.columns)].sort())) !== identity.schemaHash)
        return null;
      const rows: CanonicalSourceRow[] = [],
        seen = new Set<string>();
      visitDelimitedRows(result.canonicalCsv, (values, index) => {
        if (index === 0) {
          if (values.join(",") !== CANONICAL_SOURCE_COLUMNS.join(","))
            throw new Error("Cached canonical header mismatch");
          return;
        }
        if (values.length !== CANONICAL_SOURCE_COLUMNS.length)
          throw new Error("Cached canonical row mismatch");
        const row = Object.fromEntries(
          CANONICAL_SOURCE_COLUMNS.map((name, i) => [name, values[i]!]),
        ) as CanonicalSourceRow;
        const key = sourceRowKey(row);
        if (seen.has(key)) throw new Error("Cached canonical duplicate");
        seen.add(key);
        rows.push(row);
      });
      if (rows.length !== result.stats.rowCount || toCanonicalCsv(rows) !== result.canonicalCsv)
        return null;
      // Independently bind all normalized values to the registry's original data hash.
      if (
        hash(
          toCanonicalCsv([...rows].sort((a, b) => sourceRowKey(a).localeCompare(sourceRowKey(b)))),
        ) !== identity.dataHash
      )
        return null;
      return { ...result, rows };
    } catch {
      return null;
    }
  }
  async load(
    client: SupabaseClient,
    record: SourceRecord,
    validate: () => Promise<SourceValidationResult>,
  ): Promise<SourceValidationResult> {
    // This rollout is scoped to screening. Backtest gzip/migration paths retain
    // their established verification and loading behavior.
    if (record.source_type !== "screening") {
      this.metrics.fullValidations++;
      return validate();
    }
    const validatorVersion = await this.validator;
    const before = validatorVersion ? await this.revision(client, record) : null;
    if (!before || !validatorVersion) {
      this.metrics.unavailableRevisions++;
      this.metrics.fullValidations++;
      return validate();
    }
    const identity = this.identity(record, before, validatorVersion);
    const key = hash(canonical(identity)).slice(7);
    let bytes = this.memory.get(key);
    if (!bytes && this.options.directory) {
      try {
        bytes = await readFile(path.join(this.options.directory, `${key}.json.gz`));
      } catch {
        /* optional private cache miss */
      }
    }
    if (bytes) {
      const hit = this.decode(bytes, identity);
      if (hit) {
        this.metrics.hits++;
        this.remember(key, bytes);
        return hit;
      }
      this.metrics.invalidEntries++;
    }
    this.metrics.fullValidations++;
    const result = await validate();
    if (
      !result.valid ||
      result.errors.length !== 0 ||
      result.fileHash !== identity.logicalFileHash ||
      result.dataHash !== identity.dataHash ||
      result.schemaHash !== identity.schemaHash
    )
      throw new Error("Validated source does not match its registered hash identity");
    const after = await this.revision(client, record);
    if (after && canonical(before) !== canonical(after))
      throw new Error("Source object version changed during validation");
    if (!after) return result;
    const { rows: _rows, ...serializable } = result;
    const envelope: Envelope = {
      format: FORMAT,
      identity,
      result: serializable,
      resultHash: hash(canonical(serializable)),
    };
    bytes = gzipSync(JSON.stringify(envelope), { level: 1 });
    this.remember(key, bytes);
    if (this.options.directory) {
      try {
        await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(this.options.directory, `${key}.${randomUUID()}.tmp`);
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, path.join(this.options.directory, `${key}.json.gz`));
      } catch {
        /* cache write failure never substitutes for source validation */
      }
    }
    return result;
  }
}

export function createSourceValidationCache() {
  const directory = process.env["SOURCE_VALIDATION_CACHE_DIR"];
  return new SourceValidationCache(directory ? { directory } : {});
}
