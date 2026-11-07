import {
  krSourcePublication,
  validateKrPublicationManifest,
  type KrSourcePublication,
} from "./krScreeningPublication";
import type { FingerprintSource } from "./screeningInputIdentity";
import { stableCacheJson } from "./screeningCacheContract";
import type { AnalysisResult } from "./engine/pipeline";

/** FINAL is implicit in the frozen engine; only PRELIMINARY attaches metadata. */
export function krResultPhase(value: { krPublication?: AnalysisResult["krPublication"] }) {
  return value.krPublication?.phase ?? "FINAL";
}
export function currentDriveGeneration(
  head: unknown,
  cache: {
    publicationId?: string | undefined;
    inputFingerprint: string;
    resultDigest: string;
    drivePublication?: DriveResultPublication | undefined;
  },
) {
  if (!head || typeof head !== "object") return false;
  const h = head as {
    version?: string;
    publicationId?: string | undefined;
    inputFingerprint?: string;
    resultDigest?: string;
    drivePublication?: DriveResultPublication | undefined;
  };
  return (
    h.version === "drive-input-head-v1" &&
    typeof h.publicationId === "string" &&
    h.publicationId === cache.publicationId &&
    h.inputFingerprint === cache.inputFingerprint &&
    h.resultDigest === cache.resultDigest &&
    !!cache.drivePublication &&
    stableCacheJson(h.drivePublication) === stableCacheJson(cache.drivePublication)
  );
}

export interface DriveResultSource {
  archiveFileId: string;
  archiveSha256: string;
  csvFile: string;
  record: FingerprintSource & {
    file_hash: string;
    max_date: string;
    file_size_bytes: number;
    created_at: string;
    activated_at: string;
    validation_result: { krPublication: KrSourcePublication };
    storage_bucket: "google-drive";
    storage_path: string;
  };
}
export interface DriveResultPublication {
  version: "drive-result-publication-v1";
  baseFingerprint: string;
  asOfDate: string;
  phase: "PRELIMINARY" | "FINAL";
  sources: DriveResultSource[];
}
const hex = /^[a-f0-9]{64}$/;
export async function drivePublicationSources(
  value: DriveResultPublication | undefined,
  registered: readonly FingerprintSource[],
  baseFingerprint: string,
  asOfDate: string,
  phase?: string,
): Promise<readonly FingerprintSource[]> {
  if (value === undefined) return registered;
  if (
    !value ||
    value.version !== "drive-result-publication-v1" ||
    !hex.test(value.baseFingerprint) ||
    value.baseFingerprint !== baseFingerprint ||
    value.asOfDate !== asOfDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ||
    value.phase !== phase ||
    !["PRELIMINARY", "FINAL"].includes(value.phase) ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > 64
  )
    throw new Error(
      "Drive 게시 기준 원천·설정 또는 공표 단계가 변경됐습니다. 실행기에서 다시 확인해 주세요.",
    );
  const seen = new Set(registered.map((s) => s.id));
  for (const entry of value.sources) {
    const r = entry?.record,
      p = r ? krSourcePublication(r) : undefined;
    if (
      !p ||
      !/^[A-Za-z0-9_-]{10,200}$/.test(entry.archiveFileId) ||
      !hex.test(entry.archiveSha256) ||
      !/^[^/\\]+\.csv$/.test(entry.csvFile) ||
      r.storage_bucket !== "google-drive" ||
      r.storage_path !== `drive://${entry.archiveFileId}/kr-outputs/${entry.csvFile}` ||
      r.id !== `drive-${p.requestId}-${r.file_hash.slice(7, 23)}` ||
      seen.has(r.id) ||
      !Number.isSafeInteger(r.file_size_bytes) ||
      r.file_size_bytes <= 0 ||
      r.file_size_bytes > 45 * 1024 * 1024 ||
      typeof r.created_at !== "string" ||
      r.created_at !== r.activated_at ||
      !Number.isFinite(Date.parse(r.created_at)) ||
      r.max_date > asOfDate
    )
      throw new Error("Invalid Drive result source binding");
    seen.add(r.id);
    validateKrPublicationManifest(p, r.max_date);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p.manifestText));
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (`sha256:${hash}` !== p.manifestSha256)
      throw new Error("Drive publication manifest hash mismatch");
    const manifest = JSON.parse(p.manifestText);
    const file = manifest.csv?.find((f: { file: string }) => f.file === entry.csvFile);
    if (
      !file ||
      file.bytes !== r.file_size_bytes ||
      `sha256:${file.sha256.replace(/^sha256:/, "")}` !== r.file_hash ||
      new Date(manifest.createdAt).toISOString() !== r.created_at
    )
      throw new Error("Drive publication CSV/manifest binding mismatch");
  }
  if (!value.sources.some((s) => s.record.max_date === asOfDate))
    throw new Error("Drive publication latest session is missing");
  return [...registered, ...value.sources.map((s) => s.record)];
}
