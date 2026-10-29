import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { requireCheck } from "../kr-vintage-preflight/transport";

/** Encoding only. The database digest binds this envelope; receiptHash binds the complete logical evidence. */
export const RECOVERY_EVIDENCE_FORMAT = "kr-recovery-evidence-gzip-v1";
export const PREPARATION_NAMESPACE = "kr-adjusted-recovery-preparation:";
/** Append-only attempts: a different reviewed candidate never replaces a prior receipt. */
export function preparationSourceId(planHash: string, receiptHash: string) {
  requireCheck(H.test(planHash) && H.test(receiptHash));
  return PREPARATION_NAMESPACE + planHash.slice(7) + ":" + receiptHash.slice(7);
}
export type EvidenceKind = "PREPARATION" | "FULL_PLAN";
const limits = { PREPARATION: 24 * 1024 * 1024, FULL_PLAN: 32 * 1024 * 1024 } as const;
const versions = {
  PREPARATION: "kr-adjusted-recovery-preparation-v1",
  FULL_PLAN: "kr-adjusted-recovery-full-plan-v1",
} as const;
const H = /^sha256:[a-f0-9]{64}$/;
const rawHash = (v: Uint8Array) => "sha256:" + createHash("sha256").update(v).digest("hex");
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export async function encodeRecoveryEvidence(payload: unknown, kind: EvidenceKind) {
  requireCheck(
    object(payload) &&
      payload.version === versions[kind] &&
      payload.operationalApproval === false &&
      !Object.hasOwn(payload, "storageFormat"),
  );
  const bytes = Buffer.from(canonicalSeriesJson(payload));
  requireCheck(bytes.length > 0 && bytes.length <= limits[kind]);
  const receiptHash = rawHash(bytes),
    compressed = gzipSync(bytes, { level: 9 });
  const envelope = {
    storageFormat: RECOVERY_EVIDENCE_FORMAT,
    evidenceKind: kind,
    logicalVersion: versions[kind],
    operationalApproval: false,
    receiptHash,
    uncompressedBytes: bytes.length,
    compressedBytes: compressed.length,
    compressedHash: rawHash(compressed),
    payload: compressed.toString("base64"),
  };
  requireCheck(Buffer.byteLength(canonicalSeriesJson(envelope)) <= limits[kind]);
  return {
    payload: envelope,
    storageHash: await hashSeriesValue(envelope),
    receiptHash,
    uncompressedBytes: bytes.length,
    storedBytes: Buffer.byteLength(canonicalSeriesJson(envelope)),
  };
}
/** Explicit legacy-raw compatibility; all new encoded rows verify two distinct digest domains. */
export async function decodeRecoveryEvidence(
  stored: unknown,
  storageHash: string,
  receiptHash: string,
  kind: EvidenceKind,
) {
  requireCheck(H.test(storageHash) && H.test(receiptHash) && object(stored));
  requireCheck(Buffer.byteLength(canonicalSeriesJson(stored)) <= limits[kind]);
  requireCheck((await hashSeriesValue(stored)) === storageHash);
  if (!Object.hasOwn(stored, "storageFormat")) {
    requireCheck(
      storageHash === receiptHash &&
        stored.version === versions[kind] &&
        stored.operationalApproval === false &&
        Buffer.byteLength(canonicalSeriesJson(stored)) <= limits[kind],
    );
    return stored;
  }
  const keys = [
    "storageFormat",
    "evidenceKind",
    "logicalVersion",
    "operationalApproval",
    "receiptHash",
    "uncompressedBytes",
    "compressedBytes",
    "compressedHash",
    "payload",
  ].sort();
  requireCheck(
    canonicalSeriesJson(Object.keys(stored).sort()) === canonicalSeriesJson(keys) &&
      stored.storageFormat === RECOVERY_EVIDENCE_FORMAT &&
      stored.evidenceKind === kind &&
      stored.logicalVersion === versions[kind] &&
      stored.operationalApproval === false &&
      stored.receiptHash === receiptHash,
  );
  requireCheck(
    Number.isSafeInteger(stored.uncompressedBytes) &&
      Number(stored.uncompressedBytes) > 0 &&
      Number(stored.uncompressedBytes) <= limits[kind] &&
      Number.isSafeInteger(stored.compressedBytes) &&
      Number(stored.compressedBytes) > 0 &&
      Number(stored.compressedBytes) <= limits[kind] &&
      typeof stored.compressedHash === "string" &&
      H.test(stored.compressedHash) &&
      typeof stored.payload === "string" &&
      stored.payload.length > 0 &&
      stored.payload.length <= limits[kind] &&
      stored.payload.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(stored.payload),
  );
  const compressed = Buffer.from(stored.payload, "base64");
  requireCheck(
    compressed.toString("base64") === stored.payload &&
      compressed.length === stored.compressedBytes &&
      rawHash(compressed) === stored.compressedHash,
  );
  const bytes = gunzipSync(compressed, { maxOutputLength: Number(stored.uncompressedBytes) });
  requireCheck(bytes.length === stored.uncompressedBytes && rawHash(bytes) === receiptHash);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    value: unknown = JSON.parse(text);
  requireCheck(
    object(value) &&
      value.version === versions[kind] &&
      value.operationalApproval === false &&
      !Object.hasOwn(value, "storageFormat") &&
      canonicalSeriesJson(value) === text &&
      (await hashSeriesValue(value)) === receiptHash,
  );
  return value;
}
