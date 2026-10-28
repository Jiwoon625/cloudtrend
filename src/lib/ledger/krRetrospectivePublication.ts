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
  version: "kr-reviewed-retrospective-source-v1";
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
    version: "kr-reviewed-retrospective-registry-v1";
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
    a.registry.version === "kr-reviewed-retrospective-registry-v1" &&
      a.registry.status === "APPROVED" &&
      a.registry.policy === KR_RETROSPECTIVE_POLICY,
  );
  requireValue(
    H.test(a.authoritativeRegistryHash) &&
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
    r.version === "kr-reviewed-retrospective-source-v1" &&
      r.historicalAvailabilityClaim === false &&
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
    ].every((h) => H.test(h)) &&
      Number.isFinite(Date.parse(r.captureFinishedAt)) &&
      Number.isFinite(Date.parse(r.originFinalActivatedAt)) &&
      Date.parse(r.originFinalActivatedAt) <= Date.parse(r.captureFinishedAt) &&
      r.derivedBasisSourceStatus === "NOT_REGISTERED_AT_PREPARATION" &&
      validDate(r.predecessorDate),
  );
  requireValue(
    r.predecessorHeads.length === 5 &&
      new Set(r.predecessorHeads.map((x) => x.bookId)).size === 5 &&
      r.predecessorHeads.every(
        (x) =>
          exact(x, ["bookId", "stateHash"]) &&
          H.test(x.stateHash) &&
          /^adopted-shadow-2026-10-12-v1:(KR_MIXED|KR_KOSPI|KR_KOSDAQ|ETF_V02|KR_KOSPI_CONFIRM1_BEAR)$/.test(
            x.bookId,
          ),
      ),
  );
  requireValue(
    r.dates.length === 2 &&
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
          validDate(d.date) &&
          d.date === nextKrRegularSession(i ? r.dates[i - 1]!.date : r.predecessorDate) &&
          [d.sourceHash, d.datasetHash, d.configHash].every((h) => H.test(h)) &&
          [d.evidenceStoredAt, d.modelAvailableAt, d.modelDecisionAt].every((t) =>
            Number.isFinite(Date.parse(t)),
          ) &&
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
