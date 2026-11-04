/** Pure bounded planning. No client, filesystem, credentials or live mutation. */
import type { ModelJournalRun } from "../../src/lib/ledger/modelJournal";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  KR_RETROSPECTIVE_POLICY,
  verifyKrRetrospectiveAuthority,
  type KrRetrospectiveAuthority,
} from "../../src/lib/ledger/krRetrospectivePublication";
import {
  verifyKrSourceVintagePrivateApproval,
  KR_SOURCE_VINTAGE_THIRD_REVIEW_ID,
  KR_SOURCE_VINTAGE_POLICY,
  type KrSourceVintagePrivateApprovalV2,
  type KrSourceVintagePrivateApprovalV3,
  type KrSourceVintageReview,
} from "../../src/lib/ledger/krSourceVintage";
import { krExecutionBar } from "../../src/lib/ledger/octoberShadowArchive";
import type { FinalCaptureV1 } from "../kr-final-retrospective/contracts";
import { recordOctoberPublication } from "../../src/lib/ledger/octoberShadowPipeline";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import {
  analyzeKrReplayDataset,
  sliceKrDatasetForReplay,
} from "../../src/lib/shadowReplayCalculation";
import { buildSnapshot } from "../../src/lib/screeningSnapshot";
import { currentDateEvidence } from "../kr-vintage-preflight-dated-evidence";
import { createRecoveryMemoryStore } from "../kr-adjusted-recovery/ordered-plan";
import type { FinalCapture } from "../kr-final-retrospective/contracts";
import {
  captureCanonicalProof,
  hydrateFinalCapture,
} from "../kr-final-retrospective/capture-codec";

export const KINDS = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
export const DATES = ["2026-11-03"];
export const PREDECESSOR = "2026-11-02";
export const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export function check(v: unknown, code: string): asserts v {
  if (!v) throw new Error(`KR_NOV3_RECOVERY_${code}`);
}
const H = /^sha256:[a-f0-9]{64}$/;
/** These clocks are modeled decisions ONLY, never assertions of historical availability. */
function modeledClock(date: string) {
  const next = nextKrRegularSession(date);
  check(next, "SESSION_DATE");
  return { availableAt: `${next}T08:00:00+09:00`, decisionAt: `${next}T08:10:00+09:00` };
}
export async function prepareKrNov3Recovery(
  storedCapture: FinalCapture,
  phase: (stage: string) => void = () => {},
) {
  phase("HYDRATE");
  const c = await hydrateFinalCapture(storedCapture);
  phase("IDENTITY");
  check(
    c.version === "kr-final-retrospective-capture-v1" &&
      typeof c.owner === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(c.owner),
    "CAPTURE_IDENTITY",
  );
  check(
    typeof c.codeCommit === "string" &&
      /^[a-f0-9]{40}$/.test(c.codeCommit) &&
      same(Object.keys(c.runtimeHashes).sort(), ["kospi", "october"]) &&
      Object.values(c.runtimeHashes).every((h) => typeof h === "string" && H.test(h)),
    "RUNTIME",
  );
  check(
    c.dataset.isLive === true &&
      c.dataset.asOfDate === DATES[0] &&
      c.finalPublication.asOfDate === DATES[0] &&
      typeof c.finalPublication.hash === "string" &&
      H.test(c.finalPublication.hash),
    "FINAL_HORIZON",
  );
  check(
    [c.computedAt, c.capturedAt, c.finalPublication.activatedAt].every(
      (t) => typeof t === "string" && Number.isFinite(Date.parse(t)),
    ) &&
      Date.parse(c.computedAt) >= Date.parse(c.capturedAt) &&
      Date.parse(c.capturedAt) >= Date.parse(c.finalPublication.activatedAt) &&
      Date.parse(c.finalPublication.activatedAt) >= Date.parse(DATES[0] + "T06:30:00Z"),
    "ACTUAL_CLOCKS",
  );
  check(
    same(
      c.predecessors.map((x) => x.series.policy.kind),
      KINDS,
    ) && c.predecessors.every((x) => x.run.receipt.date === PREDECESSOR),
    "EXACT_FIVE_PREDECESSORS",
  );
  phase("SOURCE_AUTHORITY");
  await verifyKrSourceVintagePrivateApproval(c.sourceVintageApproval);
  const vintageAuthorityCandidate = await prepareUnisonVintageCandidate(c);
  phase("CAPTURE_HASHES");
  // The stored compact identity and fully restored original identity are distinct.
  const captureHash = captureCanonicalProof(storedCapture).hash;
  const decodedCaptureHash = captureCanonicalProof(c).hash;
  const sourceManifestHash = await hashSeriesValue(c.sourceManifest);
  const captureManifestHash = await hashSeriesValue(c.captureManifest);
  const datasetHash = captureCanonicalProof(c.dataset).hash;
  const configHash = await hashSeriesValue(c.config);
  // This derived analytical basis is NOT a registered source. Registered originals remain untouched.
  const basis = {
    version: "kr-nov3-recovery-derived-basis-v1",
    sourceManifestHash,
    captureManifestHash,
    datasetHash,
    configHash,
    historicalAvailabilityClaim: false,
    sourceRegistryMutation: false,
  };
  const basisHash = await hashSeriesValue(basis);
  const preparation = {
    version: "kr-nov3-recovery-preparation-v1",
    captureHash,
    decodedCaptureHash,
    owner: c.owner,
    codeCommit: c.codeCommit,
    runtimeHashes: c.runtimeHashes,
    scope: { predecessorDate: PREDECESSOR, dates: DATES, kinds: KINDS },
    basis,
    basisHash,
    computedAt: c.computedAt,
    capturedAt: c.capturedAt,
    preservationBaseline: c.preservationBaseline,
    historicalAvailabilityClaim: false,
    operationalApproval: false,
  };
  const preparationHash = await hashSeriesValue(preparation);
  const analyses = DATES.map((date) => {
    phase("ANALYZE_NOV3");
    return analyzeKrReplayDataset(sliceKrDatasetForReplay(c.dataset, date), c.config);
  });
  phase("SNAPSHOTS");
  const snapshots = analyses.map((x, i) => ({
    ...buildSnapshot(x.analysis),
    savedAt: modeledClock(DATES[i]!).availableAt,
  }));
  phase("DATE_PROOFS");
  const dateProofs = await Promise.all(
    analyses.map(async (x, i) => ({
      date: DATES[i]!,
      sourceHash: await hashSeriesValue(currentDateEvidence(x.dataset, snapshots[i]!)),
      datasetHash: captureCanonicalProof(x.dataset).hash,
      configHash,
      evidenceStoredAt: c.computedAt,
      modelAvailableAt: modeledClock(DATES[i]!).availableAt,
      modelDecisionAt: modeledClock(DATES[i]!).decisionAt,
    })),
  );
  phase("RETROSPECTIVE_AUTHORITY");
  const receipt: KrRetrospectiveAuthority["receipt"] = {
    version: "kr-reviewed-retrospective-source-v2",
    owner: c.owner,
    preparationHash,
    capsuleHash: captureHash,
    captureManifestHash,
    sourceManifestHash,
    captureFinishedAt: c.capturedAt,
    originFinalPublicationHash: c.finalPublication.hash,
    originFinalActivatedAt: c.finalPublication.activatedAt,
    derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
    preparationRuntimeCodeHash: c.runtimeHashes.october,
    runtimeCodeHash: c.runtimeHashes.october,
    predecessorDate: PREDECESSOR,
    predecessorHeads: c.predecessors.map((x) => ({
      bookId: x.series.bookId,
      stateHash: x.run.stateHash,
    })),
    dates: dateProofs,
    historicalAvailabilityClaim: false,
  };
  const registry: KrRetrospectiveAuthority["registry"] = {
    version: "kr-reviewed-retrospective-registry-v2",
    status: "APPROVED",
    policy: KR_RETROSPECTIVE_POLICY,
    receiptHash: await hashSeriesValue(receipt),
  };
  const retrospectiveAuthorityCandidate = {
    receipt,
    registry,
    authoritativeRegistryHash: await hashSeriesValue(registry),
  };
  await verifyKrRetrospectiveAuthority(retrospectiveAuthorityCandidate);
  // Existing target-date archives may have been staged by another completed
  // consumer (e.g. integrated). Preserve them in the captured full inventory;
  // they are not predecessor inputs and must never be overwritten or relabeled.
  phase("ARCHIVE_VERIFY");
  for (const archive of c.archives)
    check((await hashSeriesValue(archive.payload)) === archive.hash, "CAPTURED_ARCHIVE_HASH");
  // Only exact immutable predecessor references are analytical inputs. Other
  // valid variants remain captured/preserved, but date equality grants no use.
  const referencedArchives = new Map<string, FinalCapture["archives"][number]>();
  for (const { run } of c.predecessors) {
    if (!("frozenInputArchive" in run) || !run.frozenInputArchive) continue;
    for (const ref of run.frozenInputArchive.days) {
      const matches = c.archives.filter(
        (archive) => archive.payload.date === ref.date && archive.hash === ref.hash,
      );
      check(matches.length === 1, "PREDECESSOR_ARCHIVE_REFERENCE");
      referencedArchives.set(`${ref.date}:${ref.hash}`, matches[0]!);
    }
  }
  phase("PREDECESSOR_MEMORY");
  const memory = await createRecoveryMemoryStore({
    predecessors: c.predecessors,
    archives: [...referencedArchives.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, archive]) => archive),
  });
  const codeHash = c.predecessors[0]!.series.codeHash;
  check(
    c.predecessors.every((x) => x.series.codeHash === codeHash),
    "FROZEN_RUNTIME",
  );
  // Diagnostics wrap only the local in-memory adapter; preserve arguments/results.
  const originalReadLatest = memory.store.readLatest;
  memory.store.readLatest = async <T extends ModelJournalRun>(id: string): Promise<T | null> => {
    const index = c.predecessors.findIndex((x) => x.series.bookId === id);
    if (index >= 0 && index < 5) phase(`MODEL_READ_${index}`);
    return originalReadLatest<T>(id);
  };
  const originalAppend = memory.store.append;
  memory.store.append = async (...args) => {
    const index = c.predecessors.findIndex((x) => x.series.bookId === args[0].bookId);
    if (index >= 0 && index < 5) phase(`MODEL_APPEND_${index}`);
    return originalAppend(...args);
  };
  phase("PRIOR_ANALYSIS");
  const prior = analyzeKrReplayDataset(sliceKrDatasetForReplay(c.dataset, PREDECESSOR), c.config);
  let previousSnapshot = {
    ...buildSnapshot(prior.analysis),
    savedAt: modeledClock(PREDECESSOR).availableAt,
  };
  for (let i = 0; i < DATES.length; i++) {
    const date = DATES[i]!,
      { dataset, analysis } = analyses[i]!,
      snapshot = snapshots[i]!;
    const current = new Set(snapshot.entries.map((e) => e.symbol));
    const priorSymbols = previousSnapshot.entries
      .map((e) => e.symbol)
      .filter((s) => current.has(s));
    phase("ADOPTED_NOV3");
    await recordOctoberPublication(memory.store, {
      market: "KR",
      sourceVintageApproval: vintageAuthorityCandidate,
      reviewedRetrospective: retrospectiveAuthorityCandidate,
      dataset,
      analysis,
      snapshot,
      config: c.config,
      codeHash,
      runtimeCodeHash: c.runtimeHashes.october,
      sourceHash: dateProofs[i]!.sourceHash,
      ...modeledClock(date),
      confirmedRegularClose: true,
      failedSymbols: 0,
      universeEvidence: {
        asOfDate: previousSnapshot.asOfDate,
        sourceHash: await hashSeriesValue(previousSnapshot),
        symbols: [...new Set(priorSymbols.length ? priorSymbols : [...current])].sort(),
      },
      sourceEvidence: [],
    });
    previousSnapshot = snapshot;
  }
  phase("PREFIX_CHECK");
  memory.assertPrefix();
  check(
    memory.appended.length === 5 && memory.prepared.size === 1 && memory.newArchives.length === 1,
    "EXACT_MODEL_SCOPE",
  );
  return {
    version: "kr-nov3-recovery-plan-v1" as const,
    operationalApproval: false as const,
    historicalAvailabilityClaim: false as const,
    preparation,
    preparationHash,
    captureHash,
    sourceManifest: c.sourceManifest,
    captureManifest: c.captureManifest,
    predecessors: c.predecessors,
    sourceVintagePredecessor: c.sourceVintageApproval,
    sourceVintageApproval: vintageAuthorityCandidate,
    vintageAuthorityCandidate,
    retrospectiveAuthorityCandidate,
    newAdoptedSessions: memory.appended,
    newArchives: memory.newArchives,
    preparedPublications: [...memory.prepared.values()],
    expectedNewModelSessions: 5 as const,
    sourceRegistryMutation: false as const,
    integratedMutation: false as const,
    actualMutation: false as const,
  };
}
export type KrNov3Plan = Awaited<ReturnType<typeof prepareKrNov3Recovery>>;

/** Build a proposal from exact captured bars. This function does not grant operational authority. */
export async function prepareUnisonVintageCandidate(
  c: Pick<
    FinalCaptureV1,
    "sourceVintageApproval" | "dataset" | "archives" | "predecessors" | "captureManifest"
  >,
): Promise<KrSourceVintagePrivateApprovalV3> {
  check(
    c.sourceVintageApproval.registry.version === "kr-source-vintage-approval-v2",
    "EXACT_V2_PREDECESSOR",
  );
  const predecessor = c.sourceVintageApproval as KrSourceVintagePrivateApprovalV2;
  const parent = await verifyKrSourceVintagePrivateApproval(predecessor);
  const expectedDates: string[] = [];
  for (
    let date: string | null = "2026-10-12";
    date && date <= PREDECESSOR;
    date = nextKrRegularSession(date)
  )
    expectedDates.push(date);
  check(expectedDates.length === 16, "UNISON_DATE_SCOPE");
  const refs = new Map<string, string>();
  for (const { run } of c.predecessors) {
    if (!("frozenInputArchive" in run) || !run.frozenInputArchive) continue;
    for (const ref of run.frozenInputArchive.days) {
      check(!refs.has(ref.date) || refs.get(ref.date) === ref.hash, "ARCHIVE_REFERENCE_CONFLICT");
      refs.set(ref.date, ref.hash);
    }
  }
  const reviews: KrSourceVintageReview[] = [];
  for (const date of expectedDates) {
    const matching = c.archives.filter((a) => a.payload.date === date && a.hash === refs.get(date));
    check(
      matching.length === 1 && (await hashSeriesValue(matching[0]!.payload)) === matching[0]!.hash,
      "UNISON_ARCHIVE_REFERENCE",
    );
    const old = matching[0]!.payload.inputs.bars["018000"] ?? [];
    const incoming = (c.dataset.bars["018000"] ?? []).filter((b) => b.tradeDate === date);
    check(
      old.length === 1 && incoming.length === 1 && old[0]!.tradeDate === date,
      "UNISON_EXACT_BAR_PAIR",
    );
    const a = krExecutionBar(old[0]!),
      b = krExecutionBar(incoming[0]!);
    for (const field of ["open", "high", "low", "close"] as const)
      check(
        typeof a[field] === "number" && a[field] > 0 && b[field] === a[field] * 5,
        "UNISON_FIVE_TO_ONE",
      );
    const auxiliary = new Set([
      "volume",
      "tradingValue",
      "foreignNetBuyValue",
      "institutionNetBuyValue",
      "shortSellingVolumeRate",
    ]);
    const early = date <= "2026-10-14";
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const field of fields) {
      check(Object.hasOwn(a, field) === Object.hasOwn(b, field), "UNISON_FIELD_PRESENCE");
      if (["open", "high", "low", "close"].includes(field) || (early && auxiliary.has(field)))
        continue;
      check(
        same(a[field as keyof typeof a], b[field as keyof typeof b]),
        "UNISON_UNREVIEWED_AUXILIARY_FIELD",
      );
    }
    if (early) {
      const evidence = (
        c.captureManifest as {
          unisonRawEvidence?: {
            sourceId: string;
            sourceHash: string;
            rows: Array<{
              date: string;
              symbol: string;
              shortSellingVolume: number;
              tradingValueSource: string;
              investorValueSource: string;
            }>;
          };
        }
      ).unisonRawEvidence;
      check(
        evidence &&
          typeof evidence.sourceId === "string" &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(evidence.sourceId) &&
          typeof evidence.sourceHash === "string" &&
          H.test(evidence.sourceHash),
        "UNISON_RAW_EVIDENCE_PIN",
      );
      const sourceObjects = (
        c.captureManifest as {
          sourceObjects?: Array<{
            id: string;
            storedHash: string;
            path: string;
            generation: unknown;
          }>;
        }
      ).sourceObjects;
      check(
        Array.isArray(sourceObjects) &&
          sourceObjects.filter(
            (pin) => pin.id === evidence.sourceId && pin.storedHash === evidence.sourceHash,
          ).length === 1,
        "UNISON_RAW_SOURCE_BINDING",
      );
      const rawRows = evidence.rows.filter((row) => row.date === date && row.symbol === "018000");
      check(
        rawRows.length === 1 &&
          rawRows[0]!.tradingValueSource === "CLOSE_X_VOLUME_PROXY" &&
          rawRows[0]!.investorValueSource === "TOSS_NET_VOLUME_X_CLOSE_PROXY",
        "UNISON_RAW_PROXY_PROVENANCE",
      );
      check(
        Number.isSafeInteger(a.volume) &&
          Number.isSafeInteger(b.volume) &&
          a.volume > 0 &&
          b.volume > 0 &&
          b.volume === Math.floor(a.volume / 5),
        "UNISON_VOLUME_ADJUSTMENT",
      );
      check(
        a.tradingValue === a.close * a.volume && b.tradingValue === b.close * b.volume,
        "UNISON_TRADING_VALUE_PROXY",
      );
      for (const field of ["foreignNetBuyValue", "institutionNetBuyValue"] as const) {
        const before = a[field],
          after = b[field];
        check(
          before === null
            ? after === null
            : typeof before === "number" && Number.isFinite(before) && after === before * 5,
          "UNISON_FLOW_VALUE_PROXY",
        );
      }
      const before = a.shortSellingVolumeRate,
        after = b.shortSellingVolumeRate;
      if (before == null) check(before === after, "UNISON_SHORT_RATE_MISSING");
      else {
        check(
          typeof before === "number" && typeof after === "number" && before >= 0 && after >= 0,
          "UNISON_SHORT_RATE_VALUES",
        );
        const numerator = rawRows[0]!.shortSellingVolume;
        check(Number.isSafeInteger(numerator) && numerator >= 0, "UNISON_SHORT_RATE_NUMERATOR");
        const roundRate = (n: number, v: number) =>
          Number((BigInt(n) * 100000n + BigInt(v) / 2n) / BigInt(v)) / 100000;
        check(
          roundRate(numerator, a.volume) === before && roundRate(numerator, b.volume) === after,
          "UNISON_SHORT_RATE_RECOMPUTATION",
        );
      }
    }
    reviews.push({
      id: KR_SOURCE_VINTAGE_THIRD_REVIEW_ID,
      symbol: "018000",
      date,
      notBefore: "2026-11-03",
      archivedHash: await hashSeriesValue(a),
      incomingHash: await hashSeriesValue(b),
      evidenceUrl: "https://kind.krx.co.kr/external/2026/08/07/000621/20260807001316/70129.htm",
    });
  }
  const receipt: KrSourceVintagePrivateApprovalV3["receipt"] = {
    version: "kr-source-vintage-review-v3",
    reviewId: KR_SOURCE_VINTAGE_THIRD_REVIEW_ID,
    parentReceiptHash: parent.receiptHash,
    reviews: [...parent.reviews, ...reviews],
  };
  const registry: KrSourceVintagePrivateApprovalV3["registry"] = {
    version: "kr-source-vintage-approval-v3",
    reviewId: KR_SOURCE_VINTAGE_THIRD_REVIEW_ID,
    status: "APPROVED",
    receiptHash: await hashSeriesValue(receipt),
    parentRegistryHash: parent.registryHash,
    policy: KR_SOURCE_VINTAGE_POLICY,
  };
  const candidate = { registry, receipt, predecessor };
  await verifyKrSourceVintagePrivateApproval(candidate);
  return candidate;
}
