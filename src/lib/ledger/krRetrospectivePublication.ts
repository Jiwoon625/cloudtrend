/** Exact private authority for late adjusted-source MODEL reconstruction, never actual trading. */
import { canonicalSeriesJson, hashSeriesValue, type SeriesHash } from "./modelSeries";
import { nextKrRegularSession } from "./krShadowDecision";
import { validDate } from "./date";
export const KR_RETROSPECTIVE_POLICY =
  "REVIEWED_LATE_SOURCE_PRESERVE_IMMUTABLE_ECONOMIC_PREFIX_V1" as const;
export interface KrRetrospectiveDateProof {
  date: string;
  sourceHash: SeriesHash;
  datasetHash: SeriesHash;
  configHash: SeriesHash;
  evidenceStoredAt: string;
  modelAvailableAt: string;
  modelDecisionAt: string;
}
export interface KrRetrospectiveReceipt {
  version: "kr-reviewed-retrospective-source-v1" | "kr-reviewed-retrospective-source-v2";
  owner: string;
  preparationHash: SeriesHash;
  capsuleHash: SeriesHash;
  captureManifestHash: SeriesHash;
  sourceManifestHash: SeriesHash;
  captureFinishedAt: string;
  originFinalPublicationHash: SeriesHash;
  originFinalActivatedAt: string;
  derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION";
  preparationRuntimeCodeHash: SeriesHash;
  runtimeCodeHash: SeriesHash;
  predecessorDate: string;
  predecessorHeads: Array<{ bookId: string; stateHash: SeriesHash }>;
  dates: KrRetrospectiveDateProof[];
  historicalAvailabilityClaim: false;
}
export interface KrRetrospectiveAuthority {
  registry: {
    version: "kr-reviewed-retrospective-registry-v1" | "kr-reviewed-retrospective-registry-v2";
    status: "APPROVED";
    policy: typeof KR_RETROSPECTIVE_POLICY;
    receiptHash: SeriesHash;
  };
  receipt: KrRetrospectiveReceipt;
  /** Must be resolved from separately reviewed owner-private authority by the operational caller. */
  authoritativeRegistryHash: SeriesHash;
}
export interface KrRetrospectiveProvenance {
  version: "kr-reviewed-retrospective-publication-v1";
  historicalAvailabilityClaim: false;
  registryHash: SeriesHash;
  receiptHash: SeriesHash;
  preparationHash: SeriesHash;
  capsuleHash: SeriesHash;
  captureFinishedAt: string;
  originFinalPublicationHash: SeriesHash;
  originFinalActivatedAt: string;
  derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION";
  evidenceStoredAt: string;
  modelAvailableAt: string;
  modelDecisionAt: string;
  preparationRuntimeCodeHash: SeriesHash;
  runtimeCodeHash: SeriesHash;
}
const H = /^sha256:[a-f0-9]{64}$/;
const isHash = (value: unknown): value is SeriesHash => typeof value === "string" && H.test(value);
const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const requireValue = (v: unknown): void => {
  if (!v) throw new Error("Invalid reviewed retrospective source authority");
};
const exact = (v: unknown, keys: string[]) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  equal(Object.keys(v).sort(), keys.sort());
export async function verifyKrRetrospectiveAuthority(a: KrRetrospectiveAuthority) {
  requireValue(
    exact(a, ["registry", "receipt", "authoritativeRegistryHash"]) &&
      exact(a.registry, ["version", "status", "policy", "receiptHash"]),
  );
  requireValue(
    (a.registry.version === "kr-reviewed-retrospective-registry-v1" ||
      a.registry.version === "kr-reviewed-retrospective-registry-v2") &&
      a.registry.status === "APPROVED" &&
      a.registry.policy === KR_RETROSPECTIVE_POLICY,
  );
  requireValue(
    isHash(a.authoritativeRegistryHash) &&
      isHash(a.registry.receiptHash) &&
      (await hashSeriesValue(a.registry)) === a.authoritativeRegistryHash &&
      (await hashSeriesValue(a.receipt)) === a.registry.receiptHash,
  );
  const r = a.receipt;
  requireValue(
    exact(r, [
      "version",
      "owner",
      "preparationHash",
      "capsuleHash",
      "captureManifestHash",
      "sourceManifestHash",
      "captureFinishedAt",
      "originFinalPublicationHash",
      "originFinalActivatedAt",
      "derivedBasisSourceStatus",
      "preparationRuntimeCodeHash",
      "runtimeCodeHash",
      "predecessorDate",
      "predecessorHeads",
      "dates",
      "historicalAvailabilityClaim",
    ]),
  );
  requireValue(
    ((a.registry.version === "kr-reviewed-retrospective-registry-v1" &&
      r.version === "kr-reviewed-retrospective-source-v1") ||
      (a.registry.version === "kr-reviewed-retrospective-registry-v2" &&
        r.version === "kr-reviewed-retrospective-source-v2")) &&
      r.historicalAvailabilityClaim === false &&
      typeof r.owner === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.owner),
  );
  requireValue(
    [
      r.preparationHash,
      r.capsuleHash,
      r.captureManifestHash,
      r.originFinalPublicationHash,
      r.sourceManifestHash,
      r.preparationRuntimeCodeHash,
      r.runtimeCodeHash,
    ].every(isHash) &&
      isTimestamp(r.captureFinishedAt) &&
      isTimestamp(r.originFinalActivatedAt) &&
      Date.parse(r.originFinalActivatedAt) <= Date.parse(r.captureFinishedAt) &&
      r.derivedBasisSourceStatus === "NOT_REGISTERED_AT_PREPARATION" &&
      typeof r.predecessorDate === "string" &&
      validDate(r.predecessorDate),
  );
  requireValue(
    Array.isArray(r.predecessorHeads) &&
      r.predecessorHeads.length === 5 &&
      new Set(r.predecessorHeads.map((x) => x?.bookId)).size === 5 &&
      r.predecessorHeads.every(
        (x) =>
          exact(x, ["bookId", "stateHash"]) &&
          isHash(x.stateHash) &&
          typeof x.bookId === "string" &&
          /^adopted-shadow-2026-10-12-v1:(KR_MIXED|KR_KOSPI|KR_KOSDAQ|ETF_V02|KR_KOSPI_CONFIRM1_BEAR)$/.test(
            x.bookId,
          ),
      ),
  );
  requireValue(
    Array.isArray(r.dates) &&
      // V1 retains its original two-session contract. V2 is a separate, exact Nov 3 repair.
      ((r.version === "kr-reviewed-retrospective-source-v1" && r.dates.length === 2) ||
        (r.version === "kr-reviewed-retrospective-source-v2" &&
          r.predecessorDate === "2026-11-02" &&
          r.dates.length === 1 &&
          r.dates[0]?.date === "2026-11-03")) &&
      r.dates.every(
        (d, i) =>
          exact(d, [
            "date",
            "sourceHash",
            "datasetHash",
            "configHash",
            "evidenceStoredAt",
            "modelAvailableAt",
            "modelDecisionAt",
          ]) &&
          typeof d.date === "string" &&
          validDate(d.date) &&
          d.date === nextKrRegularSession(i ? r.dates[i - 1]!.date : r.predecessorDate) &&
          [d.sourceHash, d.datasetHash, d.configHash].every(isHash) &&
          [d.evidenceStoredAt, d.modelAvailableAt, d.modelDecisionAt].every(isTimestamp) &&
          Date.parse(d.evidenceStoredAt) >= Date.parse(r.captureFinishedAt) &&
          Date.parse(d.evidenceStoredAt) > Date.parse(d.modelDecisionAt) &&
          Date.parse(d.modelAvailableAt) <= Date.parse(d.modelDecisionAt),
      ),
  );
  return {
    registryHash: a.authoritativeRegistryHash,
    receiptHash: a.registry.receiptHash,
    receipt: r,
  };
}
export async function reviewedRetrospectiveProvenance(
  a: KrRetrospectiveAuthority,
  input: {
    date: string;
    sourceHash: SeriesHash;
    dataset: unknown;
    config: unknown;
    runtimeCodeHash: SeriesHash;
    availableAt: string;
    decisionAt: string;
    sourceEvidence: Array<{ sourceHash: SeriesHash; asOfDate: string; registeredAt: string }>;
  },
) {
  const verified = await verifyKrRetrospectiveAuthority(a),
    r = verified.receipt,
    d = r.dates.find((x) => x.date === input.date);
  requireValue(
    d &&
      r.runtimeCodeHash === input.runtimeCodeHash &&
      d.sourceHash === input.sourceHash &&
      d.datasetHash === (await hashSeriesValue(input.dataset)) &&
      d.configHash === (await hashSeriesValue(input.config)) &&
      d.modelAvailableAt === input.availableAt &&
      d.modelDecisionAt === input.decisionAt &&
      equal(input.sourceEvidence, []),
  );
  return {
    version: "kr-reviewed-retrospective-publication-v1",
    historicalAvailabilityClaim: false,
    registryHash: verified.registryHash,
    receiptHash: verified.receiptHash,
    preparationHash: r.preparationHash,
    capsuleHash: r.capsuleHash,
    captureFinishedAt: r.captureFinishedAt,
    originFinalPublicationHash: r.originFinalPublicationHash,
    originFinalActivatedAt: r.originFinalActivatedAt,
    derivedBasisSourceStatus: r.derivedBasisSourceStatus,
    evidenceStoredAt: d!.evidenceStoredAt,
    modelAvailableAt: d!.modelAvailableAt,
    modelDecisionAt: d!.modelDecisionAt,
    preparationRuntimeCodeHash: r.preparationRuntimeCodeHash,
    runtimeCodeHash: r.runtimeCodeHash,
  } satisfies KrRetrospectiveProvenance;
}
