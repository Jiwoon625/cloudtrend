import { usBrowserViews, type UsProspectiveSummary } from "./usBrowserViews";
import type { UsProspectiveCache, UsProspectiveCacheRow } from "./usProspectiveCloud";

export interface UsSameSessionRevisionPointer {
  version: "us-same-session-pointer-v1";
  userId: string;
  date: string;
  originalDataHash: string;
  revisionDataHash: string;
  collectedAt: string;
  bundlePath: string;
  bundleHash: string;
}

export interface UsSameSessionRevisionBundle {
  version: "us-same-session-bundle-v1";
  userId: string;
  date: string;
  originalDataHash: string;
  revisionDataHash: string;
  collectedAt: string;
  view: UsProspectiveCache;
  screening: UsProspectiveCache;
  summary: UsProspectiveSummary;
}

export interface UsSameSessionReferenceMetadata {
  version: "us-same-session-reference-v1";
  referenceOnly: true;
  date: string;
  originalDataHash: string;
  revisionDataHash: string;
  collectedAt: string;
  bundlePath: string;
  bundleHash: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));

/** Compare JSON values without depending on object key insertion order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameJson(value, right[index]))
    );
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]),
    )
  );
}

const nullableNumberKeys = [
  "open",
  "close",
  "ret120",
  "ret252",
  "ret120Rank",
  "ret252Rank",
  "coreRank",
  "betaRank",
  "tkRank",
  "relvolRank",
  "liquidityRank",
  "amihudRank",
  "adv20Usd",
  "marketCap",
] as const;
const booleanKeys = [
  "onset80",
  "a0Entry",
  "a0Exit",
  "a0BetaExit",
  "a2Entry",
  "a2Exit",
  "b3Entry",
  "b3Exit",
  "b3BetaExit",
] as const;
function validRow(value: unknown, date: string): value is UsProspectiveCacheRow {
  if (!record(value)) return false;
  return (
    value["date"] === date &&
    typeof value["symbol"] === "string" &&
    value["symbol"].length > 0 &&
    typeof value["name"] === "string" &&
    ["market", "sector", "status"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    nullableNumberKeys.every(
      (key) =>
        value[key] === null || (typeof value[key] === "number" && Number.isFinite(value[key])),
    ) &&
    booleanKeys.every((key) => typeof value[key] === "boolean") &&
    typeof value["betaWeakStreak"] === "number" &&
    Number.isInteger(value["betaWeakStreak"]) &&
    value["betaWeakStreak"] >= 0 &&
    typeof value["primarySignal"] === "string" &&
    ["ENTRY", "EXIT", "WATCH", "NONE"].includes(value["primarySignal"]) &&
    (value["previousCoreRank"] === undefined ||
      value["previousCoreRank"] === null ||
      (typeof value["previousCoreRank"] === "number" &&
        Number.isFinite(value["previousCoreRank"]))) &&
    (value["previousCoreDate"] === undefined ||
      value["previousCoreDate"] === null ||
      (typeof value["previousCoreDate"] === "string" && DATE.test(value["previousCoreDate"]))) &&
    (value["eligibleBase"] === undefined || typeof value["eligibleBase"] === "boolean")
  );
}

function validCache(
  value: unknown,
  pointer: UsSameSessionRevisionPointer,
  ruleVersion: string,
): value is UsProspectiveCache {
  if (!record(value) || !record(value["source"]) || !record(value["analysis"])) return false;
  const source = value["source"];
  const analysis = value["analysis"];
  return (
    timestamp(value["generatedAt"]) &&
    value["dataHash"] === pointer.revisionDataHash &&
    source["collectedAt"] === pointer.collectedAt &&
    typeof source["provider"] === "string" &&
    typeof source["schemaVersion"] === "string" &&
    record(source["metadata"]) &&
    analysis["date"] === pointer.date &&
    analysis["ruleVersion"] === ruleVersion &&
    record(analysis["summary"]) &&
    Object.values(analysis["summary"]).every(
      (value) => value === null || (typeof value === "number" && Number.isFinite(value)),
    ) &&
    Array.isArray(analysis["rows"]) &&
    analysis["rows"].every((row) => validRow(row, pointer.date)) &&
    new Set(analysis["rows"].map((row) => row.symbol)).size === analysis["rows"].length
  );
}

/** Metadata is attached only after verifying the owner-bound immutable bundle. */
export function getUsSameSessionReference(
  cache: UsProspectiveCache | null | undefined,
): UsSameSessionReferenceMetadata | null {
  const value = cache?.source?.metadata?.["sameSessionRevision"];
  if (
    !cache ||
    !record(value) ||
    value["version"] !== "us-same-session-reference-v1" ||
    value["referenceOnly"] !== true ||
    value["date"] !== cache.analysis.date ||
    value["revisionDataHash"] !== cache.dataHash ||
    value["collectedAt"] !== cache.source.collectedAt ||
    !hash(value["originalDataHash"]) ||
    !hash(value["revisionDataHash"]) ||
    !hash(value["bundleHash"]) ||
    !timestamp(value["collectedAt"]) ||
    typeof value["bundlePath"] !== "string"
  )
    return null;
  return value as unknown as UsSameSessionReferenceMetadata;
}

/** Read-only selection: an absent/older pointer cannot supersede canonical operating data. */
export async function resolveUsSameSessionReference(
  canonical: UsProspectiveCache,
  userId: string,
  candidate: unknown,
  readBundle: (path: string) => Promise<Uint8Array | null>,
): Promise<UsProspectiveCache> {
  if (candidate === null) return canonical;
  if (
    !record(candidate) ||
    candidate["version"] !== "us-same-session-pointer-v1" ||
    candidate["userId"] !== userId ||
    typeof candidate["date"] !== "string" ||
    !DATE.test(candidate["date"]) ||
    !hash(candidate["originalDataHash"]) ||
    !hash(candidate["revisionDataHash"]) ||
    !hash(candidate["bundleHash"]) ||
    !timestamp(candidate["collectedAt"])
  )
    throw new Error("Invalid US same-session reference pointer");
  const pointer = candidate as unknown as UsSameSessionRevisionPointer;
  const expectedPath = `${userId}/results/us-screening-revisions/${pointer.date}/${pointer.revisionDataHash.slice(7)}/bundle.json`;
  // Never pass a path from unverified metadata to Storage, including an owner sibling path.
  if (
    pointer.bundlePath !== expectedPath ||
    !userId ||
    userId.includes("/") ||
    userId.includes("\\")
  )
    throw new Error("US same-session reference owner path mismatch");
  if (pointer.date < canonical.analysis.date) return canonical;
  if (
    pointer.date !== canonical.analysis.date ||
    pointer.originalDataHash !== canonical.dataHash ||
    pointer.revisionDataHash === pointer.originalDataHash ||
    !timestamp(canonical.source.collectedAt) ||
    Date.parse(pointer.collectedAt) <= Date.parse(canonical.source.collectedAt)
  )
    throw new Error("US same-session reference does not match the canonical session");

  const bytes = await readBundle(expectedPath);
  if (!bytes) throw new Error("US same-session reference bundle is unavailable");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  const bundleHash = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (bundleHash !== pointer.bundleHash)
    throw new Error("US same-session reference bundle hash mismatch");
  const bundle: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !record(bundle) ||
    bundle["version"] !== "us-same-session-bundle-v1" ||
    !["userId", "date", "originalDataHash", "revisionDataHash", "collectedAt"].every(
      (key) => bundle[key] === candidate[key],
    ) ||
    !validCache(bundle["view"], pointer, canonical.analysis.ruleVersion)
  )
    throw new Error("Invalid US same-session reference bundle");
  const view = bundle["view"];
  const projected = usBrowserViews(view);
  if (
    !sameJson(view, projected.screening) ||
    !sameJson(bundle["screening"], projected.screening) ||
    !sameJson(bundle["summary"], projected.summary)
  )
    throw new Error("US same-session reference views are inconsistent");
  const metadata: UsSameSessionReferenceMetadata = {
    version: "us-same-session-reference-v1",
    referenceOnly: true,
    date: pointer.date,
    originalDataHash: pointer.originalDataHash,
    revisionDataHash: pointer.revisionDataHash,
    collectedAt: pointer.collectedAt,
    bundlePath: pointer.bundlePath,
    bundleHash: pointer.bundleHash,
  };
  return {
    ...view,
    source: {
      ...view.source,
      metadata: { ...view.source.metadata, sameSessionRevision: metadata },
    },
  };
}
