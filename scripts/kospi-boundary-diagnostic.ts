/** PRIVATE DIAGNOSTIC ONLY. No store, network, filesystem, approval or alternate acceptance path. */
import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  validateShadowSession,
  type KospiShadowRow,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../src/lib/kospiShadowEquivalence";
import type { KospiShadowRegistry } from "../src/lib/kospiShadowStore";
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";

interface Captured<T> {
  path: string;
  hash: string;
  payload: T;
}
export interface KospiBoundaryDiagnosticInput {
  baselineSession: KospiShadowSession;
  adjustedSession: KospiShadowSession;
  completed: Captured<KospiShadowSnapshot>;
  predecessor: Captured<KospiShadowSnapshot> | null;
  registry: Captured<KospiShadowRegistry>;
  /** Results from the existing, unchanged equivalence calls. These never become approval. */
  guardResults: { baseline: boolean; adjusted: boolean };
}
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
const H = /^sha256:[a-f0-9]{64}$/;
const completeRows = (rows: Record<string, KospiShadowRow>, date: string) =>
  record(rows) &&
  Object.entries(rows).every(([symbol, row]) => {
    if (!record(row) || row.symbol !== symbol || row.date !== date) return false;
    if (![row.symbol, row.name, row.sector].every((x) => typeof x === "string" && x)) return false;
    for (const key of ["open", "close", "volume", "score", "priority", "rsAccel"] as const)
      if (row[key] !== null && !(typeof row[key] === "number" && Number.isFinite(row[key])))
        return false;
    if (typeof row.commonHistory !== "boolean" || typeof row.onsetEligible !== "boolean")
      return false;
    for (const key of ["priceObserved", "universeDataPending"] as const)
      if (Object.hasOwn(row, key) && typeof row[key] !== "boolean") return false;
    return true;
  });
function economicPolicy(value: unknown) {
  if (!record(value)) throw new Error("KOSPI_DIAGNOSTIC_POLICY_INVALID");
  const { researchReference, ...rest } = value;
  if (Object.hasOwn(value, "researchReference") && typeof researchReference !== "string")
    throw new Error("KOSPI_DIAGNOSTIC_POLICY_INVALID");
  return rest;
}
function economicSource(source: KospiShadowSnapshot["source"]) {
  const { sourceHash: _h, sourceCollectedAt: _t, codeVersion: _v, ...rest } = source;
  return rest;
}
function comparisonSnapshot(s: KospiShadowSnapshot) {
  return {
    ...s,
    source: economicSource(s.source),
    policy: economicPolicy(s.policy),
  };
}
function changingKeys(a: Record<string, unknown>, b: Record<string, unknown>) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => !Object.hasOwn(a, k) || !Object.hasOwn(b, k) || !same(a[k], b[k]));
}

/** Mirror predicates diagnose the existing guard; disagreement throws rather than widening it. */
async function inspect(
  incoming: KospiShadowSession,
  existing: KospiShadowSnapshot,
  predecessor: KospiShadowSnapshot | null,
  initializedDate: string,
  expected: boolean,
) {
  const guardResult = equivalentCompletedKospiShadow(
    incoming,
    existing,
    predecessor,
    initializedDate,
  );
  if (guardResult !== expected) throw new Error("KOSPI_DIAGNOSTIC_GUARD_RESULT_CHANGED");
  const checks: Record<string, boolean> = {};
  const check = (key: string, fn: () => unknown) => {
    try {
      checks[key] = Boolean(fn());
    } catch {
      checks[key] = false;
    }
    return checks[key]!;
  };
  let sourceDifferenceKeys: string[] | null = null,
    rowComparison: {
      added: string[];
      removed: string[];
      changed: string[];
      incomingOrderEqualsStoredMapEnumeration: boolean;
    } | null = null;
  let replay: {
    evaluated: boolean;
    equal: boolean | null;
    hash: string | null;
    existingHash: string | null;
    differingTopLevelFields: string[];
    error: boolean;
  } = {
    evaluated: false,
    equal: null,
    hash: null,
    existingHash: null,
    differingTopLevelFields: [],
    error: false,
  };
  const finish = (category: string, mirrorEquivalent = false) => {
    if (mirrorEquivalent !== guardResult) throw new Error("KOSPI_BOUNDARY_DIAGNOSTIC_DRIFT");
    return {
      category,
      guardFunction: "equivalentCompletedKospiShadow",
      guardResult,
      mirrorEquivalent,
      mirrorAgreesWithGuard: true,
      checks,
      failedChecks: Object.keys(checks).filter((k) => !checks[k]),
      sourceDifferenceKeys,
      rowComparison,
      replay,
    };
  };
  if (
    !check("incomingSessionValid", () => {
      validateShadowSession(incoming);
      return true;
    }) ||
    !check("incomingTimestampValid", () => Number.isFinite(Date.parse(incoming.sourceCollectedAt)))
  )
    return finish("INCOMING_VALIDATION");
  const eligibility = [
    check("existingSchemaV1", () => existing.schemaVersion === 1),
    check("existingPolicyEquivalent", () =>
      same(economicPolicy(existing.policy), KOSPI_SHADOW_POLICY),
    ),
    check("existingSourceDateMatches", () => existing.source.date === incoming.date),
    check("existingDailyDateMatches", () => existing.daily.date === incoming.date),
    check("existingStateDateMatches", () => existing.state.lastDate === incoming.date),
    check("existingStrategyMatches", () => existing.state.strategyId === KOSPI_SHADOW_POLICY.id),
    check(
      "existingRuleVersionMatches",
      () => existing.state.ruleVersion === KOSPI_SHADOW_POLICY.version,
    ),
    check("existingConfigMatches", () => existing.state.configHash === incoming.configHash),
    check(
      "existingInitializedDateMatches",
      () => existing.state.initializedDate === initializedDate,
    ),
    check("existingExecutionPolicyNotEnabled", () => !existing.state.executionPolicy),
    check("existingWarmupRowsAbsent", () => !Object.hasOwn(existing.source, "warmupRows")),
    check("existingLateRecoveryAbsent", () => !Object.hasOwn(existing.source, "lateRecovery")),
    check("incomingWarmupRowsAbsent", () => !Object.hasOwn(incoming, "warmupRows")),
    check("incomingLateRecoveryAbsent", () => !Object.hasOwn(incoming, "lateRecovery")),
    check("existingRowsComplete", () => completeRows(existing.state.previousRows, incoming.date)),
  ];
  if (!eligibility.every(Boolean)) return finish("COMPLETED_STRUCTURAL_ELIGIBILITY");
  const original = {
    ...existing.source,
    rows: Object.values(existing.state.previousRows),
  };
  if (
    !check("originalSessionValid", () => {
      validateShadowSession(original);
      return true;
    }) ||
    !check("originalTimestampValid", () => Number.isFinite(Date.parse(original.sourceCollectedAt)))
  )
    return finish("ORIGINAL_VALIDATION");
  const { rows, ...source } = incoming,
    keyedRows = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  sourceDifferenceKeys = changingKeys(economicSource(source), economicSource(existing.source));
  const oldRows = existing.state.previousRows;
  rowComparison = {
    added: Object.keys(keyedRows)
      .filter((k) => !Object.hasOwn(oldRows, k))
      .sort(),
    removed: Object.keys(oldRows)
      .filter((k) => !Object.hasOwn(keyedRows, k))
      .sort(),
    changed: Object.keys(keyedRows)
      .filter((k) => Object.hasOwn(oldRows, k) && !same(keyedRows[k], oldRows[k]))
      .sort(),
    incomingOrderEqualsStoredMapEnumeration: same(
      rows.map((r) => r.symbol),
      Object.keys(oldRows),
    ),
  };
  const sources = [
    check("incomingRowsComplete", () => completeRows(keyedRows, incoming.date)),
    check("economicSourceEqual", () =>
      same(economicSource(source), economicSource(existing.source)),
    ),
    check("keyedRowsEqual", () => same(keyedRows, oldRows)),
  ];
  if (!sources.every(Boolean)) return finish("SOURCE_OR_ROWS_MISMATCH");
  if (incoming.date === initializedDate) {
    if (
      !check("initialPredecessorAbsent", () => predecessor === null) ||
      !check("initialSessionCountOne", () => existing.state.sessions === 1)
    )
      return finish("PREDECESSOR_LINK");
  } else {
    const links = [
      check("predecessorPresent", () => !!predecessor),
      check("predecessorSchemaV1", () => predecessor?.schemaVersion === 1),
      check("predecessorPolicyEquivalent", () =>
        same(economicPolicy(predecessor?.policy), economicPolicy(existing.policy)),
      ),
      check(
        "predecessorSourceDateMatches",
        () => predecessor?.source.date === incoming.previousSessionDate,
      ),
      check(
        "predecessorDailyDateMatches",
        () => predecessor?.daily.date === incoming.previousSessionDate,
      ),
      check(
        "predecessorStateDateMatches",
        () => predecessor?.state.lastDate === incoming.previousSessionDate,
      ),
      check(
        "predecessorConfigMatches",
        () => predecessor?.source.configHash === incoming.configHash,
      ),
      check(
        "predecessorInitializedDateMatches",
        () => predecessor?.state.initializedDate === initializedDate,
      ),
      check(
        "predecessorSessionCountConsecutive",
        () => predecessor!.state.sessions + 1 === existing.state.sessions,
      ),
      check("predecessorExecutionPolicyNotEnabled", () => !predecessor!.state.executionPolicy),
      check("predecessorRowsComplete", () =>
        completeRows(predecessor!.state.previousRows, predecessor!.source.date),
      ),
    ];
    if (!links.every(Boolean)) return finish("PREDECESSOR_LINK");
  }
  if (predecessor) {
    if (
      !check("predecessorSessionValid", () => {
        validateShadowSession({
          ...predecessor.source,
          rows: Object.values(predecessor.state.previousRows),
        });
        return true;
      }) ||
      !check("predecessorTimestampValid", () =>
        Number.isFinite(Date.parse(predecessor.source.sourceCollectedAt)),
      )
    )
      return finish("PREDECESSOR_VALIDATION");
  }
  try {
    const replayed = comparisonSnapshot(stepKospiShadow(incoming, predecessor?.state ?? null)),
      stored = comparisonSnapshot(existing);
    replay = {
      evaluated: true,
      equal: same(replayed, stored),
      hash: await hashSeriesValue(replayed),
      existingHash: await hashSeriesValue(stored),
      differingTopLevelFields: changingKeys(replayed, stored),
      error: false,
    };
  } catch {
    replay = { ...replay, evaluated: true, error: true };
    return finish("REPLAY_ERROR");
  }
  return finish(replay.equal ? "EQUIVALENT" : "REPLAY_MISMATCH", replay.equal === true);
}

/** Result contains private complete sessions and symbol details: never public logs/artifacts. */
export async function diagnoseKospiCompletedBoundary(input: KospiBoundaryDiagnosticInput) {
  const { completed, predecessor, registry } = input;
  for (const object of [completed, predecessor, registry])
    if (object && (!H.test(object.hash) || (await hashSeriesValue(object.payload)) !== object.hash))
      throw new Error("KOSPI_DIAGNOSTIC_CAPTURE_HASH_MISMATCH");
  const root = registry.path.slice(0, -"/registry.json".length);
  if (
    !registry.path.endsWith("/registry.json") ||
    completed.path !== `${root}/sessions/${completed.payload.source.date}.json` ||
    (predecessor && predecessor.path !== `${root}/sessions/${predecessor.payload.source.date}.json`)
  )
    throw new Error("KOSPI_DIAGNOSTIC_CAPTURE_PATH_MISMATCH");
  if (
    input.baselineSession.date !== input.adjustedSession.date ||
    input.baselineSession.date !== completed.payload.source.date
  )
    throw new Error("KOSPI_DIAGNOSTIC_BOUNDARY_DATE_MISMATCH");
  const baseline = await inspect(
      input.baselineSession,
      completed.payload,
      predecessor?.payload ?? null,
      registry.payload.initializedDate,
      input.guardResults.baseline,
    ),
    adjusted = await inspect(
      input.adjustedSession,
      completed.payload,
      predecessor?.payload ?? null,
      registry.payload.initializedDate,
      input.guardResults.adjusted,
    );
  const source = (s: KospiShadowSession) => {
    const { rows, ...rest } = s;
    return {
      source: economicSource(rest),
      rows: Object.fromEntries(rows.map((r) => [r.symbol, r])),
    };
  };
  return {
    version: "kospi-completed-boundary-diagnostic-v1",
    diagnosticOnly: true,
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    acceptanceGuardUnchanged: true,
    capturedReferences: {
      registry: { path: registry.path, hash: registry.hash },
      completed: { path: completed.path, hash: completed.hash },
      predecessor: predecessor ? { path: predecessor.path, hash: predecessor.hash } : null,
    },
    initializedDate: registry.payload.initializedDate,
    registryConfigHash: registry.payload.configHash,
    sessions: {
      baseline: {
        hash: await hashSeriesValue(input.baselineSession),
        payload: structuredClone(input.baselineSession),
      },
      adjusted: {
        hash: await hashSeriesValue(input.adjustedSession),
        payload: structuredClone(input.adjustedSession),
      },
    },
    baseline,
    adjusted,
    baselineVsAdjusted: {
      economicSourceEqual: same(
        source(input.baselineSession).source,
        source(input.adjustedSession).source,
      ),
      keyedRowsEqual: same(source(input.baselineSession).rows, source(input.adjustedSession).rows),
      rowOrderEqual: same(
        input.baselineSession.rows.map((r) => r.symbol),
        input.adjustedSession.rows.map((r) => r.symbol),
      ),
    },
  };
}

/** The sole public projection: finite categories and booleans/counts, no private strings. */
export function publicKospiBoundarySummary(
  report: Awaited<ReturnType<typeof diagnoseKospiCompletedBoundary>>,
) {
  const categories = new Set([
    "INCOMING_VALIDATION",
    "COMPLETED_STRUCTURAL_ELIGIBILITY",
    "ORIGINAL_VALIDATION",
    "SOURCE_OR_ROWS_MISMATCH",
    "PREDECESSOR_LINK",
    "PREDECESSOR_VALIDATION",
    "REPLAY_ERROR",
    "REPLAY_MISMATCH",
    "EQUIVALENT",
  ]);
  if (!categories.has(report.baseline.category) || !categories.has(report.adjusted.category))
    throw new Error("KOSPI_DIAGNOSTIC_PUBLIC_CATEGORY_REJECTED");
  const booleans = [
    report.baseline.guardResult,
    report.adjusted.guardResult,
    report.baseline.replay.evaluated,
    report.adjusted.replay.evaluated,
    ...Object.values(report.baselineVsAdjusted),
  ];
  if (booleans.some((x) => typeof x !== "boolean"))
    throw new Error("KOSPI_DIAGNOSTIC_PUBLIC_BOOLEAN_REJECTED");
  const counts = [
    report.baseline.failedChecks.length,
    report.adjusted.failedChecks.length,
    report.sessions.baseline.payload.rows.length,
    report.sessions.adjusted.payload.rows.length,
  ];
  if (counts.some((x) => !Number.isSafeInteger(x) || x < 0))
    throw new Error("KOSPI_DIAGNOSTIC_PUBLIC_COUNT_REJECTED");
  // Every key is fixed here. Never spread a private checks/source/row object.
  const checkNames = [
    "incomingSessionValid",
    "incomingTimestampValid",
    "existingSchemaV1",
    "existingPolicyEquivalent",
    "existingSourceDateMatches",
    "existingDailyDateMatches",
    "existingStateDateMatches",
    "existingStrategyMatches",
    "existingRuleVersionMatches",
    "existingConfigMatches",
    "existingInitializedDateMatches",
    "existingExecutionPolicyNotEnabled",
    "existingWarmupRowsAbsent",
    "existingLateRecoveryAbsent",
    "incomingWarmupRowsAbsent",
    "incomingLateRecoveryAbsent",
    "existingRowsComplete",
    "originalSessionValid",
    "originalTimestampValid",
    "incomingRowsComplete",
    "economicSourceEqual",
    "keyedRowsEqual",
    "initialPredecessorAbsent",
    "initialSessionCountOne",
    "predecessorPresent",
    "predecessorSchemaV1",
    "predecessorPolicyEquivalent",
    "predecessorSourceDateMatches",
    "predecessorDailyDateMatches",
    "predecessorStateDateMatches",
    "predecessorConfigMatches",
    "predecessorInitializedDateMatches",
    "predecessorSessionCountConsecutive",
    "predecessorExecutionPolicyNotEnabled",
    "predecessorRowsComplete",
    "predecessorSessionValid",
    "predecessorTimestampValid",
  ] as const;
  const projectChecks = (checks: Record<string, boolean>) =>
    Object.fromEntries(
      checkNames.map((key) => {
        const evaluated = Object.hasOwn(checks, key);
        if (evaluated && typeof checks[key] !== "boolean")
          throw new Error("KOSPI_DIAGNOSTIC_PUBLIC_BOOLEAN_REJECTED");
        return [key, { evaluated, passed: evaluated && checks[key] === true }];
      }),
    );
  const projectDifferences = (part: typeof report.baseline) => {
    const result = {
      sourceComparisonEvaluated: part.sourceDifferenceKeys !== null,
      sourceDifferenceCount: part.sourceDifferenceKeys?.length ?? 0,
      rowComparisonEvaluated: part.rowComparison !== null,
      addedRowCount: part.rowComparison?.added.length ?? 0,
      removedRowCount: part.rowComparison?.removed.length ?? 0,
      changedRowCount: part.rowComparison?.changed.length ?? 0,
      replayComparisonEvaluated: part.replay.equal !== null,
      replayEqual: part.replay.equal === true,
      replayError: part.replay.error,
      differingReplaySectionCount: part.replay.differingTopLevelFields.length,
    };
    if (
      Object.values(result).some(
        (value) => typeof value !== "boolean" && !(Number.isSafeInteger(value) && value >= 0),
      )
    )
      throw new Error("KOSPI_DIAGNOSTIC_PUBLIC_COUNT_REJECTED");
    return result;
  };
  return {
    version: "kospi-boundary-public-summary-v1",
    diagnosticOnly: true,
    operationalApproval: false,
    baselineChecks: projectChecks(report.baseline.checks),
    adjustedChecks: projectChecks(report.adjusted.checks),
    baselineDifferences: projectDifferences(report.baseline),
    adjustedDifferences: projectDifferences(report.adjusted),
    baselineCategory: report.baseline.category,
    adjustedCategory: report.adjusted.category,
    baselineEquivalent: report.baseline.guardResult,
    adjustedEquivalent: report.adjusted.guardResult,
    baselineReplayEvaluated: report.baseline.replay.evaluated,
    adjustedReplayEvaluated: report.adjusted.replay.evaluated,
    baselineFailedCheckCount: report.baseline.failedChecks.length,
    adjustedFailedCheckCount: report.adjusted.failedChecks.length,
    baselineRowCount: report.sessions.baseline.payload.rows.length,
    adjustedRowCount: report.sessions.adjusted.payload.rows.length,
    baselineVsAdjustedEconomicSourceEqual: report.baselineVsAdjusted.economicSourceEqual,
    baselineVsAdjustedKeyedRowsEqual: report.baselineVsAdjusted.keyedRowsEqual,
    baselineVsAdjustedRowOrderEqual: report.baselineVsAdjusted.rowOrderEqual,
  };
}
