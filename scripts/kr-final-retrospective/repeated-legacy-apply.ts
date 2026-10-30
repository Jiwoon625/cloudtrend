/* eslint-disable @typescript-eslint/no-explicit-any */
/** Separate exact repeated-retrospective writer. Existing frozen admission is never changed. */
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  type ShadowObjectStore,
  type KospiShadowView,
} from "../../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  openKospiShadowRevisionStore,
} from "../../src/lib/kospiShadowSeries";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import { proveRepeatedRetrospectiveBoundary } from "./repeated-predecessor";
const clone = structuredClone;
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const isHash = (v: unknown): v is SeriesHash =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
function requireValue(v: unknown, code: string): asserts v {
  if (!v) throw Error(`REPEATED_LEGACY_${code}`);
}
export async function repeatedLegacyApprovalCandidate(preparationHash: SeriesHash, prepared: any) {
  requireValue(
    prepared.status === "PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION" && prepared.plan,
    "BLOCKED_CANNOT_APPROVE",
  );
  const plan = prepared.plan;
  return {
    version: "kr-repeated-legacy-approval-v1",
    status: "APPROVED",
    owner: prepared.authority.owner,
    preparationHash,
    proofHash: await hashSeriesValue(prepared),
    planHash: await hashSeriesValue(plan),
    runtimeCodeHash: prepared.authority.runtimeCodeHash,
    predecessorDate: "2026-10-27",
    targetDates: ["2026-10-28", "2026-10-29"],
    predecessorHash: plan.predecessorHash,
    snapshotHashes: plan.snapshotHashes,
    finalProjectionHash: plan.finalProjectionHash,
    historicalAvailabilityClaim: false,
  } as const;
}
export interface ApplyRepeatedLegacyInput {
  store: ShadowObjectStore;
  preparationReceipt: any;
  approval: Awaited<ReturnType<typeof repeatedLegacyApprovalCandidate>>;
  authoritativePreparationHash: SeriesHash;
  authoritativeApprovalHash: SeriesHash;
  approvedRuntimeCodeHash: SeriesHash;
  assertExclusiveWriter(scope: {
    owner: string;
    namespace: string;
    requiredConcurrencyGroup: string;
  }): Promise<void>;
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

/** Recompute the complete new proof before any live read/write. No old authority admission. */
export async function applyRepeatedLegacy(input: ApplyRepeatedLegacyInput) {
  const { store, preparationReceipt: receipt, approval } = input;
  requireValue(
    [
      input.authoritativePreparationHash,
      input.authoritativeApprovalHash,
      input.approvedRuntimeCodeHash,
    ].every(isHash),
    "AUTHORITATIVE_PINS",
  );
  requireValue(
    (await hashSeriesValue(receipt)) === input.authoritativePreparationHash &&
      (await hashSeriesValue(approval)) === input.authoritativeApprovalHash,
    "AUTHORITY_HASH",
  );
  requireValue(
    receipt.version === "kr-repeated-retrospective-preparation-v1" &&
      receipt.kind === "RECOVERY_PREPARATION_ONLY" &&
      receipt.operationalApproval === false &&
      receipt.historicalAvailabilityClaim === false,
    "RECEIPT_SCHEMA",
  );
  const prepared = receipt.kospi.result,
    plan = prepared.plan,
    authority = prepared.authority;
  requireValue(
    prepared.status === "PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION" &&
      prepared.operationalApproval === false &&
      prepared.historicalAvailabilityClaim === false &&
      plan,
    "BLOCKED_OR_UNPROVEN",
  );
  requireValue(
    same(
      approval,
      await repeatedLegacyApprovalCandidate(input.authoritativePreparationHash, prepared),
    ),
    "NEW_APPROVAL_EXACT",
  );
  requireValue(
    authority.owner === approval.owner &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(approval.owner) &&
      authority.runtimeCodeHash === input.approvedRuntimeCodeHash &&
      authority.predecessorDate === "2026-10-27" &&
      same(authority.targetDates, ["2026-10-28", "2026-10-29"]),
    "EXACT_OWNER_RUNTIME_SCOPE",
  );
  requireValue(
    same(receipt.kospi.repeatedProofInput.capturedObjects, receipt.kospi.capturedObjects),
    "PROOF_CAPTURE_BINDING",
  );
  requireValue(
    same(await proveRepeatedRetrospectiveBoundary(receipt.kospi.repeatedProofInput), prepared),
    "WHOLE_PROOF_REPRODUCTION",
  );
  const dates: readonly string[] = approval.targetDates;
  requireValue(
    plan.sessions.length === 2 &&
      prepared.snapshots.length === 2 &&
      approval.snapshotHashes.length === 2,
    "EXACT_TARGET_COUNT",
  );
  let previous: string = approval.predecessorDate;
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
      journalPath.test(path) ||
        path === `${revisionRoot}/revision.json` ||
        path === oldApprovalPath,
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
    captured.has(oldApprovalPath) && captured.size === Object.keys(plan.prefixHashes).length,
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
  const ordered: readonly string[] = [approval.predecessorDate, ...dates];
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
    version: "kr-repeated-legacy-apply-result-v1",
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
