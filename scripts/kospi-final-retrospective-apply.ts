/** Narrow MODEL-only orchestration. Caller owns authenticated approval/runtime lookup and admission. */
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  shadowObjectPath,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  openKospiShadowRevisionStore,
} from "../src/lib/kospiShadowSeries";
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { nextKrRegularSession } from "../src/lib/ledger/krShadowDecision";
import type { prepareKospiFinalRetrospective } from "./kospi-final-retrospective-preparation";
import { verifyKospiPriorityAdmission } from "./kospi-priority-admission";

type Prepared = Extract<
  Awaited<ReturnType<typeof prepareKospiFinalRetrospective>>,
  { status: "PREPARED_FOR_INDEPENDENT_REVIEW" }
>;
interface KospiRetrospectiveApprovalBase {
  status: "APPROVED";
  owner: string;
  preparationHash: string;
  planHash: string;
  runtimeCodeHash: string;
  predecessorDate: string;
  targetDates: string[];
  predecessorHash: string;
  snapshotHashes: string[];
  finalProjectionHash: string;
}
export type KospiRetrospectiveApproval = KospiRetrospectiveApprovalBase &
  (
    | { version: "kospi-final-retrospective-approval-v1" }
    | {
        version: "kospi-priority-continuation-approval-v1";
        boundaryMode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION";
        boundaryProofHash: string;
      }
  );
/** Candidate shape only. Independent private review/provisioning remains mandatory. */
export function kospiRetrospectiveApprovalCandidate(
  preparationHash: string,
  prepared: Prepared,
): KospiRetrospectiveApproval {
  const p = prepared.plan,
    a = prepared.authority;
  const common = {
    status: "APPROVED" as const,
    owner: a.owner,
    preparationHash,
    planHash: prepared.planHash,
    runtimeCodeHash: a.runtimeCodeHash,
    predecessorDate: a.predecessorDate,
    targetDates: a.targetDates,
    predecessorHash: p.predecessorHash,
    snapshotHashes: p.snapshotHashes,
    finalProjectionHash: p.finalProjectionHash,
  };
  if (p.boundaryAdmission.mode === "PRIORITY_ONLY_PREDECESSOR_CONTINUATION") {
    requireValue(
      prepared.adjustedBoundaryEquivalent === false &&
        isHash(p.boundaryAdmission.proofHash) &&
        prepared.priorityContinuation?.status === "PROVEN_PRIORITY_ONLY_CONTINUATION" &&
        prepared.priorityContinuationHash === p.boundaryAdmission.proofHash,
      "PRIORITY_CANDIDATE_PROOF",
    );
    return {
      ...common,
      version: "kospi-priority-continuation-approval-v1",
      boundaryMode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION",
      boundaryProofHash: p.boundaryAdmission.proofHash,
    };
  }
  requireValue(
    p.boundaryAdmission.mode === "STRICT_COMPLETED_EQUIVALENCE" &&
      prepared.adjustedBoundaryEquivalent === true,
    "STRICT_CANDIDATE_BOUNDARY",
  );
  return { ...common, version: "kospi-final-retrospective-approval-v1" };
}
export interface KospiRecoveryPreparationReceipt {
  version: "kr-adjusted-recovery-preparation-v1";
  kind: "RECOVERY_PREPARATION_ONLY";
  operationalApproval: false;
  historicalAvailabilityClaim: false;
  kospi: {
    capturedObjects: Array<{ path: string; hash: string; payload: unknown }>;
    result: Prepared;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface ApplyKospiRetrospectiveInput {
  store: ShadowObjectStore;
  preparationReceipt: KospiRecoveryPreparationReceipt;
  approval: KospiRetrospectiveApproval;
  /** These pins MUST come from independent authoritative private reads, not untrusted dispatch input. */
  authoritativePreparationHash: string;
  authoritativeApprovalHash: string;
  /** Actual admitted running code identity, separately verified by the caller before this import. */
  approvedRuntimeCodeHash: string;
  /**
   * Mandatory entrypoint obligation: prove this entire job holds the shared workflow
   * exclusion used by EVERY admitted legacy writer. This assertion is not a DB lease/CAS.
   */
  assertExclusiveWriter(scope: {
    owner: string;
    namespace: string;
    requiredConcurrencyGroup: "kospi-prospective-shadow";
  }): Promise<void>;
}
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const clone = <T>(v: T): T => structuredClone(v);
const isHash = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`KOSPI_RETROSPECTIVE_${code}`);
}
function memoryStore(initial: Map<string, unknown>) {
  const values = new Map([...initial].map(([k, v]) => [k, clone(v)]));
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => clone(values.get(p) ?? null) as T | null,
    latestSessionDate: async (p) =>
      [...values.keys()]
        .filter((k) => k.startsWith(p + "/"))
        .map((k) => k.slice(p.length + 1))
        .filter((k) => /^\d{4}-\d{2}-\d{2}\.json$/.test(k))
        .map((k) => k.slice(0, -5))
        .sort()
        .at(-1) ?? null,
    putImmutable: async (p, v) => {
      requireValue(!values.has(p) || same(values.get(p), v), "MEMORY_IMMUTABLE_CONFLICT");
      values.set(p, clone(v));
    },
    putLatest: async (p, v) => {
      values.set(p, clone(v));
    },
  };
  return { store, values };
}

/** No automatic recovery fallback. Append only the exact independently reviewed plan. */
export async function applyPreparedKospiRetrospective(input: ApplyKospiRetrospectiveInput) {
  const { store, preparationReceipt: receipt, approval } = input;
  requireValue(
    [
      input.authoritativePreparationHash,
      input.authoritativeApprovalHash,
      input.approvedRuntimeCodeHash,
    ].every(isHash),
    "MISSING_AUTHORITATIVE_PINS",
  );
  requireValue(
    (await hashSeriesValue(receipt)) === input.authoritativePreparationHash &&
      (await hashSeriesValue(approval)) === input.authoritativeApprovalHash,
    "AUTHORITY_MISMATCH",
  );
  requireValue(
    same(
      Object.keys(approval).sort(),
      [
        "version",
        "status",
        "owner",
        "preparationHash",
        "planHash",
        "runtimeCodeHash",
        "predecessorDate",
        "targetDates",
        "predecessorHash",
        "snapshotHashes",
        "finalProjectionHash",
        ...(approval.version === "kospi-priority-continuation-approval-v1"
          ? ["boundaryMode", "boundaryProofHash"]
          : []),
      ].sort(),
    ),
    "APPROVAL_SCHEMA",
  );
  requireValue(
    receipt.version === "kr-adjusted-recovery-preparation-v1" &&
      receipt.kind === "RECOVERY_PREPARATION_ONLY" &&
      receipt.operationalApproval === false &&
      receipt.historicalAvailabilityClaim === false,
    "PREPARATION_SCHEMA",
  );
  const prepared = receipt.kospi.result,
    plan = prepared.plan,
    authority = prepared.authority;
  requireValue(
    prepared.status === "PREPARED_FOR_INDEPENDENT_REVIEW" &&
      prepared.operationalApproval === false &&
      prepared.historicalAvailabilityClaim === false &&
      prepared.resetCapital === false &&
      plan &&
      plan.immutablePrefixPreserved === true &&
      plan.resetCapital === false &&
      plan.historicalAvailabilityClaim === false,
    "UNPREPARED_OR_UNSAFE_PLAN",
  );
  requireValue(
    (approval.version === "kospi-final-retrospective-approval-v1" ||
      approval.version === "kospi-priority-continuation-approval-v1") &&
      approval.status === "APPROVED" &&
      approval.preparationHash === input.authoritativePreparationHash &&
      approval.planHash === prepared.planHash &&
      (await hashSeriesValue(plan)) === approval.planHash &&
      approval.runtimeCodeHash === input.approvedRuntimeCodeHash &&
      authority.runtimeCodeHash === input.approvedRuntimeCodeHash &&
      same(plan.authority, authority),
    "PLAN_AUTHORITY_MISMATCH",
  );
  if (approval.version === "kospi-priority-continuation-approval-v1") {
    requireValue(
      approval.boundaryMode === "PRIORITY_ONLY_PREDECESSOR_CONTINUATION" &&
        isHash(approval.boundaryProofHash) &&
        approval.boundaryProofHash === prepared.priorityContinuationHash &&
        prepared.adjustedBoundaryEquivalent === false &&
        plan.boundaryAdmission.mode === "PRIORITY_ONLY_PREDECESSOR_CONTINUATION" &&
        plan.boundaryAdmission.proofHash === approval.boundaryProofHash &&
        prepared.priorityContinuation?.status === "PROVEN_PRIORITY_ONLY_CONTINUATION",
      "PRIORITY_PROOF_AUTHORITY",
    );
  } else {
    requireValue(
      prepared.adjustedBoundaryEquivalent === true &&
        (!plan.boundaryAdmission || plan.boundaryAdmission.mode === "STRICT_COMPLETED_EQUIVALENCE"),
      "STRICT_BOUNDARY_REQUIRED",
    );
  }
  requireValue(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(approval.owner) &&
      authority.owner === approval.owner &&
      approval.predecessorDate === authority.predecessorDate &&
      same(approval.targetDates, authority.targetDates) &&
      approval.predecessorHash === plan.predecessorHash &&
      same(approval.snapshotHashes, plan.snapshotHashes) &&
      approval.finalProjectionHash === plan.finalProjectionHash,
    "SCOPE_OR_OUTPUT_MISMATCH",
  );
  const dates = approval.targetDates;
  requireValue(
    dates.length >= 1 &&
      dates.length <= 2 &&
      dates.length === plan.sessions.length &&
      dates.length === prepared.snapshots.length &&
      dates.length === approval.snapshotHashes.length,
    "TARGET_COUNT",
  );
  let previous = approval.predecessorDate;
  for (const d of dates) {
    requireValue(nextKrRegularSession(previous) === d, "TARGET_CALENDAR");
    previous = d;
  }
  const root = `${approval.owner}/${KOSPI_SHADOW_NAMESPACE}`;
  const revisionRoot = `${root}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const latestPath = `${revisionRoot}/latest.json`;
  const oldApprovalPath = `${root}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`;
  requireValue(typeof input.assertExclusiveWriter === "function", "EXCLUSIVE_WRITER_REQUIRED");
  const assertExclusiveWriter = () =>
    input.assertExclusiveWriter({
      owner: approval.owner,
      namespace: revisionRoot,
      requiredConcurrencyGroup: "kospi-prospective-shadow",
    });
  const journalPath = new RegExp(
    `^(${root}|${revisionRoot})/(registry\\.json|latest\\.json|sessions/\\d{4}-\\d{2}-\\d{2}\\.json)$`,
  );
  for (const path of Object.keys(plan.prefixHashes))
    requireValue(
      journalPath.test(path) || path === `${revisionRoot}/revision.json`,
      "PREFIX_PATH_ESCAPE",
    );
  const captured = new Map<string, unknown>(),
    capturedHashes = new Map<string, string>();
  for (const item of receipt.kospi.capturedObjects) {
    requireValue(
      !captured.has(item.path) &&
        isHash(item.hash) &&
        (await hashSeriesValue(item.payload)) === item.hash,
      "CAPTURE_IDENTITY",
    );
    requireValue(
      item.path === oldApprovalPath || Object.hasOwn(plan.prefixHashes, item.path),
      "CAPTURE_PATH",
    );
    captured.set(item.path, clone(item.payload));
    capturedHashes.set(item.path, item.hash);
  }
  requireValue(
    captured.has(oldApprovalPath) &&
      captured.size === Object.keys(plan.prefixHashes).length + 1 &&
      same(plan.prefixHashes, prepared.inputObjectHashes),
    "CAPTURE_INVENTORY",
  );
  for (const [p, h] of Object.entries(plan.prefixHashes))
    requireValue(capturedHashes.get(p) === h, "PREFIX_PIN");
  const oldApproval = captured.get(oldApprovalPath) as Record<string, unknown>;
  const metadata = captured.get(`${revisionRoot}/revision.json`) as Record<string, unknown>;
  requireValue(
    oldApproval &&
      metadata &&
      [
        "revisionId",
        "predecessorDate",
        "correctionDate",
        "expectedPredecessorHash",
        "expectedOriginalTargetHash",
      ].every((k) => same(oldApproval[k], metadata[k])) &&
      oldApproval["expectedCorrectedSourceHash"] === metadata["correctedSourceHash"],
    "ORIGINAL_APPROVAL",
  );
  const baseline = captured.get(latestPath) as KospiShadowView;
  requireValue(
    baseline?.latest.source.date === approval.predecessorDate &&
      (await hashSeriesValue(baseline.latest)) === approval.predecessorHash,
    "BASELINE_ANCHOR",
  );
  if (approval.version === "kospi-priority-continuation-approval-v1") {
    // Recompute all three exact target chains before ANY live read/write orchestration.
    await verifyKospiPriorityAdmission(prepared, receipt.kospi.capturedObjects);
  }
  const memory = memoryStore(captured),
    simulated = await openKospiShadowRevisionStore(memory.store, approval.owner);
  const projections = new Map<string, KospiShadowView>([
    [approval.predecessorDate, clone(baseline)],
  ]);
  const snapshots = new Map<string, unknown>();
  // Recompute from the original approved predecessor, regardless of current live progress.
  for (const [i, date] of dates.entries()) {
    const session = plan.sessions[i]!;
    requireValue(
      session.date === date &&
        session.previousSessionDate === (i === 0 ? approval.predecessorDate : dates[i - 1]) &&
        session.codeVersion === authority.codeVersion &&
        session.sourceHash === authority.adjustedBasisHash &&
        session.configHash === plan.configHash &&
        session.sourceCollectedAt === authority.adjustedCapturedAt &&
        session.lateRecovery?.version === "kospi-final-retrospective-v1" &&
        session.lateRecovery.runtimeCodeHash === approval.runtimeCodeHash &&
        session.lateRecovery.historicalAvailabilityClaim === false,
      "SESSION_SCOPE",
    );
    const result = await persistKospiShadow(
      simulated,
      approval.owner,
      session,
      baseline.registry.config,
    );
    requireValue(
      (await hashSeriesValue(result.view.latest)) === approval.snapshotHashes[i] &&
        same(result.view.latest, prepared.snapshots[i]),
      "REPLAY_OUTPUT",
    );
    projections.set(date, clone(result.view));
    snapshots.set(`${revisionRoot}/sessions/${date}.json`, clone(result.view.latest));
  }
  await openKospiShadowRevisionStore(memory.store, approval.owner);
  const expectedFinal = projections.get(dates.at(-1)!)!;
  requireValue(
    (await hashSeriesValue(expectedFinal)) === approval.finalProjectionHash &&
      same(expectedFinal, prepared.finalProjection),
    "FINAL_OUTPUT",
  );
  const ordered = [approval.predecessorDate, ...dates];
  async function verifyImmutablePrefix() {
    for (const [path, hash] of capturedHashes) {
      if (path === latestPath) continue;
      const current = await store.read(path);
      requireValue(
        current !== null && (await hashSeriesValue(current)) === hash,
        "LIVE_PREFIX_CHANGED",
      );
    }
  }
  async function liveProgress() {
    await openKospiShadowRevisionStore(store, approval.owner);
    const current = await store.read<KospiShadowView>(latestPath);
    const date = current?.latest.source.date;
    requireValue(
      date && projections.has(date) && same(current, projections.get(date)),
      "LIVE_PROJECTION_NOT_APPROVED_PREFIX",
    );
    const index = ordered.indexOf(date);
    let seenMissing = false;
    for (const [i, target] of dates.entries()) {
      const path = `${revisionRoot}/sessions/${target}.json`,
        actual = await store.read(path);
      if (actual === null) {
        seenMissing = true;
        requireValue(i + 1 > index, "PROJECTED_SNAPSHOT_MISSING");
      } else {
        requireValue(
          !seenMissing && same(actual, snapshots.get(path)) && i + 1 <= index + 1,
          "LIVE_TARGET_CONFLICT",
        );
      }
    }
    return index;
  }
  await assertExclusiveWriter();
  await verifyImmutablePrefix();
  const initialIndex = await liveProgress();
  let writes = 0;
  const checked: ShadowObjectStore = {
    read: store.read.bind(store),
    latestSessionDate: store.latestSessionDate.bind(store),
    putImmutable: async (p, v) => {
      requireValue(snapshots.has(p) && same(v, snapshots.get(p)), "WRITE_SET_ESCAPE");
      const old = await store.read(p);
      if (old !== null) {
        requireValue(same(old, v), "IMMUTABLE_CONFLICT");
        return;
      }
      await assertExclusiveWriter();
      await verifyImmutablePrefix();
      try {
        await store.putImmutable(p, v);
      } catch {
        /* The operation may have committed. Never retry blindly. */
      }
      let observed: unknown;
      try {
        observed = await store.read(p);
      } catch {
        throw new Error("KOSPI_RETROSPECTIVE_UNCERTAIN_IMMUTABLE_READBACK");
      }
      requireValue(observed !== null && same(observed, v), "UNCERTAIN_IMMUTABLE_READBACK");
      writes++;
    },
    putLatest: async (p, v) => {
      const next = v as KospiShadowView,
        date = next.latest?.source.date;
      requireValue(
        p === latestPath && dates.includes(date) && same(v, projections.get(date)),
        "PROJECTION_WRITE_SET_ESCAPE",
      );
      const old = await store.read<KospiShadowView>(p);
      requireValue(
        old &&
          projections.has(old.latest.source.date) &&
          same(old, projections.get(old.latest.source.date)) &&
          ordered.indexOf(old.latest.source.date) <= ordered.indexOf(date),
        "PROJECTION_REWIND_OR_CONFLICT",
      );
      if (same(old, v)) return;
      requireValue(
        ordered.indexOf(date) === ordered.indexOf(old.latest.source.date) + 1,
        "PROJECTION_SKIP",
      );
      await assertExclusiveWriter();
      await verifyImmutablePrefix();
      try {
        await store.putLatest(p, v);
      } catch {
        /* Read back exactly once; caller may later retry the same approved plan. */
      }
      let observed: unknown;
      try {
        observed = await store.read(p);
      } catch {
        throw new Error("KOSPI_RETROSPECTIVE_UNCERTAIN_PROJECTION_READBACK");
      }
      requireValue(observed !== null && same(observed, v), "UNCERTAIN_PROJECTION_READBACK");
      writes++;
    },
  };
  for (const [i, session] of plan.sessions.entries()) {
    const progress = await liveProgress();
    if (progress >= i + 1) continue;
    requireValue(progress === i, "LIVE_PREFIX_SKIPPED");
    await verifyImmutablePrefix();
    const adapter = await openKospiShadowRevisionStore(checked, approval.owner);
    await persistKospiShadow(adapter, approval.owner, session, baseline.registry.config);
    requireValue((await liveProgress()) === i + 1, "APPEND_READBACK");
  }
  await verifyImmutablePrefix();
  requireValue((await liveProgress()) === dates.length, "TERMINAL_READBACK");
  return {
    version: "kospi-final-retrospective-apply-result-v1",
    status: "VERIFIED",
    preparationHash: input.authoritativePreparationHash,
    approvalHash: input.authoritativeApprovalHash,
    planHash: approval.planHash,
    finalProjectionHash: approval.finalProjectionHash,
    completedDates: clone(dates),
    alreadyCompletedCount: initialIndex,
    verifiedWriteCount: writes,
    originalPrefixUnchanged: true,
    historicalAvailabilityClaim: false,
    actualLedgerWrites: 0,
  };
}
