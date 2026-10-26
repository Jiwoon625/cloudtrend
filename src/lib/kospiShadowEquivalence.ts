import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  validateShadowSession,
  type KospiShadowRow,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "./engine/kospiShadow";
import { canonicalSeriesJson } from "./ledger/modelSeries";

const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

function completeRows(rows: Record<string, KospiShadowRow>, date: string): boolean {
  return (
    record(rows) &&
    Object.entries(rows).every(([symbol, row]) => {
      if (!record(row) || row.symbol !== symbol || row.date !== date) return false;
      if (![row.symbol, row.name, row.sector].every((value) => typeof value === "string" && value))
        return false;
      for (const key of ["open", "close", "volume", "score", "priority", "rsAccel"] as const)
        if (row[key] !== null && !(typeof row[key] === "number" && Number.isFinite(row[key])))
          return false;
      if (typeof row.commonHistory !== "boolean" || typeof row.onsetEligible !== "boolean")
        return false;
      for (const key of ["priceObserved", "universeDataPending"] as const)
        if (Object.hasOwn(row, key) && typeof row[key] !== "boolean") return false;
      return true;
    })
  );
}

/** Historical display-only metadata; no other unknown policy field is ignored. */
function economicPolicy(policy: unknown) {
  if (!record(policy)) throw new Error("Missing policy evidence");
  const { researchReference, ...fields } = policy;
  if (Object.hasOwn(policy, "researchReference") && typeof researchReference !== "string")
    throw new Error("Malformed legacy research reference");
  return fields;
}

/** Only transport/audit provenance is excluded; all other source fields remain binding. */
function economicSource(source: KospiShadowSnapshot["source"]) {
  const {
    sourceHash: _sourceHash,
    sourceCollectedAt: _collectedAt,
    codeVersion: _code,
    ...input
  } = source;
  return input;
}

/**
 * A read-only equivalence proof for an already completed prospective session.
 *
 * Legacy snapshots retain the complete original materialized input: source plus
 * state.previousRows (unconditionally cloned by stepKospiShadow). Do NOT derive an
 * old fingerprint from today's raw dataset, latest projection, or raw source hash.
 * Compare that evidence first, then replay from the immutable predecessor and
 * require the ENTIRE snapshot to match. The replay also checks array-order effects
 * which cannot be recovered from the symbol-keyed row map alone.
 *
 * This does not repair history or publish a replacement. A false result leaves the
 * original input/config guard in force, including when evidence is incomplete.
 */
export function equivalentCompletedKospiShadow(
  incoming: KospiShadowSession,
  existing: KospiShadowSnapshot,
  predecessor: KospiShadowSnapshot | null,
  initializedDate: string,
): boolean {
  try {
    validateShadowSession(incoming);
    if (!Number.isFinite(Date.parse(incoming.sourceCollectedAt))) return false;
    if (
      existing.schemaVersion !== 1 ||
      !same(economicPolicy(existing.policy), KOSPI_SHADOW_POLICY) ||
      existing.source.date !== incoming.date ||
      existing.daily.date !== incoming.date ||
      existing.state.lastDate !== incoming.date ||
      existing.state.strategyId !== KOSPI_SHADOW_POLICY.id ||
      existing.state.ruleVersion !== KOSPI_SHADOW_POLICY.version ||
      existing.state.configHash !== incoming.configHash ||
      existing.state.initializedDate !== initializedDate ||
      existing.state.executionPolicy ||
      Object.hasOwn(existing.source, "warmupRows") ||
      Object.hasOwn(existing.source, "lateRecovery") ||
      Object.hasOwn(incoming, "warmupRows") ||
      Object.hasOwn(incoming, "lateRecovery") ||
      !completeRows(existing.state.previousRows, incoming.date)
    )
      return false;
    // Fail closed on missing/invalid legacy evidence rather than supplying defaults.
    const original: KospiShadowSession = {
      ...existing.source,
      rows: Object.values(existing.state.previousRows),
    };
    validateShadowSession(original);
    if (!Number.isFinite(Date.parse(original.sourceCollectedAt))) return false;
    const { rows, ...source } = incoming;
    const keyedRows = Object.fromEntries(rows.map((row) => [row.symbol, row]));
    if (
      !completeRows(keyedRows, incoming.date) ||
      !same(economicSource(source), economicSource(existing.source)) ||
      !same(keyedRows, existing.state.previousRows)
    )
      return false;
    if (incoming.date === initializedDate) {
      if (predecessor !== null || existing.state.sessions !== 1) return false;
    } else if (
      !predecessor ||
      predecessor.schemaVersion !== 1 ||
      !same(economicPolicy(predecessor.policy), economicPolicy(existing.policy)) ||
      predecessor.source.date !== incoming.previousSessionDate ||
      predecessor.daily.date !== incoming.previousSessionDate ||
      predecessor.state.lastDate !== incoming.previousSessionDate ||
      predecessor.source.configHash !== incoming.configHash ||
      predecessor.state.initializedDate !== initializedDate ||
      predecessor.state.sessions + 1 !== existing.state.sessions ||
      predecessor.state.executionPolicy ||
      !completeRows(predecessor.state.previousRows, predecessor.source.date)
    )
      return false;
    if (predecessor) {
      validateShadowSession({
        ...predecessor.source,
        rows: Object.values(predecessor.state.previousRows),
      });
      if (!Number.isFinite(Date.parse(predecessor.source.sourceCollectedAt))) return false;
    }
    // Preserve incoming row order. Matching the keyed rows alone is insufficient:
    // onset candidate/awaiting arrays can depend on that order.
    const replay = stepKospiShadow(incoming, predecessor?.state ?? null);
    return same(
      { ...replay, source: economicSource(replay.source), policy: economicPolicy(replay.policy) },
      {
        ...existing,
        source: economicSource(existing.source),
        policy: economicPolicy(existing.policy),
      },
    );
  } catch {
    // Malformed/missing evidence and non-finite JSON are never an equivalence proof.
    return false;
  }
}
