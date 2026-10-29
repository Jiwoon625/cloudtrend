/* eslint-disable @typescript-eslint/no-explicit-any */
/** Pure exact-capture bridge. Never treats a self-asserted proof flag as authority. */
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { kospiShadowRevisionPath } from "../src/lib/kospiShadowSeries";
import { validateShadowSession } from "../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../src/lib/kospiShadowEquivalence";
import { diagnoseKospiCompletedBoundary } from "./kospi-boundary-diagnostic";
import { proveKospiPriorityContinuation } from "./kospi-priority-continuation";
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
function check(value: unknown): asserts value {
  if (!value) throw new Error("KOSPI_PRIORITY_ADMISSION_MISMATCH");
}

/** Recompute from full immutable inputs before receipt admission and again before APPLY writes. */
export async function verifyKospiPriorityAdmission(
  result: any,
  captured: Array<{ path: string; hash: string; payload: any }>,
) {
  const a = result.authority;
  const get = (suffix: string) => {
    const path = kospiShadowRevisionPath(a.owner, suffix);
    const matches = captured.filter((x) => x.path === path);
    check(matches.length === 1);
    return matches[0]!;
  };
  const registry = get("registry.json"),
    completed = get(`sessions/${a.predecessorDate}.json`),
    originalView = get("latest.json"),
    priorDate = completed.payload.source.previousSessionDate,
    predecessor = priorDate ? get(`sessions/${priorDate}.json`) : null;
  for (const c of [registry, completed, originalView, ...(predecessor ? [predecessor] : [])])
    check(
      (await hashSeriesValue(c.payload)) === c.hash && result.inputObjectHashes[c.path] === c.hash,
    );
  check(
    same(originalView.payload.registry, registry.payload) &&
      same(originalView.payload.latest, completed.payload),
  );
  const d = result.boundaryDiagnostic;
  const input = {
    authority: a,
    registry,
    completed,
    predecessor,
    originalView,
    baselineSession: d.sessions.baseline.payload,
    adjustedSession: d.sessions.adjusted.payload,
    targetSessions: result.targetSessions,
  };
  const strict = {
    baseline: equivalentCompletedKospiShadow(
      input.baselineSession,
      completed.payload,
      predecessor?.payload ?? null,
      registry.payload.initializedDate,
    ),
    adjusted: equivalentCompletedKospiShadow(
      input.adjustedSession,
      completed.payload,
      predecessor?.payload ?? null,
      registry.payload.initializedDate,
    ),
  };
  check(
    strict.baseline === result.baselineBoundaryEquivalent &&
      strict.adjusted === result.adjustedBoundaryEquivalent,
  );
  check(same(d, await diagnoseKospiCompletedBoundary({ ...input, guardResults: strict })));
  check(
    Array.isArray(input.targetSessions) &&
      same(
        input.targetSessions.map((s: any) => s.date),
        a.targetDates,
      ),
  );
  const completedHash = await hashSeriesValue(completed.payload);
  for (const [i, s] of input.targetSessions.entries()) {
    validateShadowSession(s);
    check(
      s.previousSessionDate === (i === 0 ? a.predecessorDate : a.targetDates[i - 1]) &&
        s.configHash === registry.payload.configHash &&
        s.codeVersion === a.codeVersion &&
        s.sourceHash === a.adjustedBasisHash &&
        s.sourceCollectedAt === a.adjustedCapturedAt &&
        same(s.lateRecovery, {
          version: "kospi-final-retrospective-v1",
          historicalAvailabilityClaim: false,
          retrospective: true,
          sourceDataAsOf: a.targetDates.at(-1),
          sourceCollectedAt: a.baselineCollectedAt,
          captureObservedAt: a.adjustedCapturedAt,
          computedAt: a.computedAt,
          sourceManifestHash: a.sourceManifestHash,
          captureManifestHash: a.captureManifestHash,
          adjustedBasisHash: a.adjustedBasisHash,
          runtimeCodeHash: a.runtimeCodeHash,
          predecessorDate: a.predecessorDate,
          predecessorHash: completedHash,
        }),
    );
    // The existing dataset comparison predates retrospective decoration; the full
    // decorated session is separately hash-bound by the continuation certificate.
    const {
      sourceHash: _h,
      sourceCollectedAt: _c,
      codeVersion: _v,
      lateRecovery: _l,
      ...economic
    } = s;
    const comparisons = result.comparisons.filter((c: any) => c.date === s.date);
    check(
      comparisons.length === 1 &&
        comparisons[0].adjustedEconomicHash === (await hashSeriesValue(economic)),
    );
  }
  if (strict.adjusted) {
    check(result.priorityContinuation === null && result.priorityContinuationHash === null);
    check(
      result.plan && same(result.plan.boundaryAdmission, { mode: "STRICT_COMPLETED_EQUIVALENCE" }),
    );
  } else {
    const recomputed = await proveKospiPriorityContinuation(input);
    check(same(result.priorityContinuation, recomputed));
    const hash = await hashSeriesValue(recomputed);
    check(result.priorityContinuationHash === hash);
    if (recomputed.status === "PROVEN_PRIORITY_ONLY_CONTINUATION") {
      const original = recomputed.continuations.original;
      check(
        result.plan &&
          same(result.plan.boundaryAdmission, {
            mode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION",
            proofHash: hash,
          }),
      );
      check(
        same(result.snapshots, original.snapshots) &&
          same(result.finalProjection, original.projections.at(-1)) &&
          same(
            result.plan.snapshotHashes,
            await Promise.all(original.snapshots.map(hashSeriesValue)),
          ) &&
          result.plan.finalProjectionHash === (await hashSeriesValue(original.projections.at(-1))),
      );
    } else check(result.plan === null && result.status === "BLOCKED_ADJUSTED_PREDECESSOR_MISMATCH");
  }
  if (result.plan) check(same(result.plan.sessions, input.targetSessions));
}
