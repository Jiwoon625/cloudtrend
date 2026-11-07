import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LoadedSourceInput, SourceRecord } from "./source-registry-store";
import { validateSourceBytes } from "../src/lib/sourceData";
export const KR_BASELINE_SHA = "d0cb8477ca6f94a5ebbcbd8e79928635222e46f20e116fafb902c7763e0bfe92";
export const KR_OWNER = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
export const hashBytes = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
export interface BaselineSource {
  ordinal: number;
  member: string;
  bytes: number;
  sha256: string;
  sourceRecord: SourceRecord;
}
export interface BaselineManifest {
  schemaVersion: string;
  market: string;
  immutable: boolean;
  sources: BaselineSource[];
}
/** Only this verified loader can mint evidence. No arbitrary providedInputs authorization. */
const evidence = new WeakSet<object>();
export interface DriveHistoryEvidence {
  baselineSha256: string;
  orderedSources: Array<{ id: string; fileHash: string; dataHash: string; schemaHash: string }>;
}
export function isVerifiedDriveHistory(value: DriveHistoryEvidence) {
  return evidence.has(value);
}
export async function loadDriveHistory(
  directory: string,
  onSource?: (r: Record<string, unknown>) => Promise<void>,
) {
  const raw = await readFile(path.join(directory, "baseline-manifest.json"));
  if (hashBytes(raw) !== KR_BASELINE_SHA) throw new Error("Pinned baseline manifest hash mismatch");
  const manifest = JSON.parse(raw.toString("utf8")) as BaselineManifest;
  if (
    manifest.schemaVersion !== "cloudtrend-drive-history-baseline-v1" ||
    manifest.market !== "KR_ETF" ||
    !manifest.immutable ||
    manifest.sources.length !== 52
  )
    throw new Error("Unsupported baseline contract");
  const inputs: LoadedSourceInput[] = [];
  for (const [ordinal, s] of manifest.sources.entries()) {
    if (
      s.ordinal !== ordinal ||
      !s.member.startsWith("objects/") ||
      s.member.split("/").some((p) => !p || p === ".." || p === ".") ||
      s.member.includes("\\")
    )
      throw new Error("Invalid baseline precedence/path");
    const r = s.sourceRecord;
    if (
      r.user_id !== KR_OWNER ||
      r.status !== "active" ||
      r.source_type !== "screening" ||
      r.file_hash !== `sha256:${s.sha256}`
    )
      throw new Error("Invalid source evidence");
    const bytes = new Uint8Array(await readFile(path.join(directory, s.member)));
    if (bytes.byteLength !== s.bytes || hashBytes(bytes) !== s.sha256)
      throw new Error("Baseline source byte mismatch");
    const validation = await validateSourceBytes({
      bytes,
      filename: r.original_filename,
      contentType: r.content_type,
      streamingCsv: true,
    });
    const comparison = {
      ordinal,
      id: r.id,
      valid: validation.valid,
      registered: { fileHash: r.file_hash, dataHash: r.data_hash, schemaHash: r.schema_hash },
      revalidated: {
        fileHash: validation.fileHash,
        dataHash: validation.dataHash,
        schemaHash: validation.schemaHash,
      },
      stats: validation.stats,
    };
    await onSource?.(comparison);
    if (
      !validation.valid ||
      validation.fileHash !== r.file_hash ||
      validation.dataHash !== r.data_hash ||
      validation.schemaHash !== r.schema_hash
    )
      throw new Error(
        `Current validator differs from registered evidence at ordinal ${ordinal}; see validation receipt; registry remains unchanged`,
      );
    inputs.push({
      id: r.id,
      fileName: r.original_filename,
      bytes: bytes.byteLength,
      savedAt: r.activated_at ?? r.created_at,
      text: validation.canonicalCsv,
      fileHash: validation.fileHash,
      dataHash: validation.dataHash,
      schemaHash: validation.schemaHash,
      sourceRecord: r,
      validation: { ...validation, rows: [] },
    });
    process.stderr.write(`Drive source ${ordinal + 1}/52 validated\n`);
  }
  const proof: DriveHistoryEvidence = {
    baselineSha256: KR_BASELINE_SHA,
    orderedSources: inputs.map((i) => ({
      id: i.id,
      fileHash: i.fileHash,
      dataHash: i.dataHash,
      schemaHash: i.schemaHash,
    })),
  };
  evidence.add(proof);
  return { inputs, manifest, evidence: proof };
}
