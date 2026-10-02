import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiShadowSession,
  type KospiShadowSnapshot,
  type ShadowDaily,
  type ShadowTrade,
} from "./engine/kospiShadow";
export const KOSPI_SHADOW_NAMESPACE = "shadow/kospi-confirm1-bear-rsaccel-v1";
export interface ShadowObjectStore {
  read<T>(path: string): Promise<T | null>;
  latestSessionDate(namespacePath: string): Promise<string | null>;
  putImmutable(path: string, value: unknown): Promise<void>;
  putLatest(path: string, value: unknown): Promise<void>;
}
export interface KospiShadowRegistry {
  strategyId: typeof KOSPI_SHADOW_POLICY.id;
  ruleVersion: string;
  initializedDate: string;
  configHash: string;
  config: unknown;
  initialSourceHash: string;
  initialCodeVersion: string;
}
export interface KospiShadowView {
  schemaVersion: 1;
  registry: KospiShadowRegistry;
  latest: KospiShadowSnapshot;
  history: ShadowDaily[];
  recentTrades: ShadowTrade[];
  tradeHistoryTruncated: boolean;
}
export function shadowObjectPath(userId: string, suffix: string) {
  if (
    !/^[a-f\d-]{36}$/i.test(userId) ||
    !/^(registry\.json|latest\.json|sessions\/\d{4}-\d{2}-\d{2}\.json)$/.test(suffix)
  )
    throw new Error("Invalid private Shadow object path");
  return `${userId}/${KOSPI_SHADOW_NAMESPACE}/${suffix}`;
}
function sameFreeze(a: KospiShadowSession, b: KospiShadowSnapshot["source"]) {
  return a.date === b.date && a.sourceHash === b.sourceHash && a.configHash === b.configHash;
}
/** Append-only dated snapshots are authoritative; latest is a recoverable private projection. */
export async function persistKospiShadow(
  store: ShadowObjectStore,
  userId: string,
  session: KospiShadowSession,
  config: unknown,
): Promise<{ reused: boolean; view: KospiShadowView }> {
  const path = (suffix: string) => shadowObjectPath(userId, suffix);
  let registry = await store.read<KospiShadowRegistry>(path("registry.json"));
  let previous = await store.read<KospiShadowView>(path("latest.json"));
  if (
    previous &&
    (!registry ||
      previous.registry.initializedDate !== registry.initializedDate ||
      previous.latest.state.strategyId !== KOSPI_SHADOW_POLICY.id)
  )
    throw new Error("Shadow registry/projection mismatch; do not reconstruct or reset capital");
  if (previous) {
    const authoritative = await store.read<KospiShadowSnapshot>(
      path(`sessions/${previous.latest.source.date}.json`),
    );
    if (!authoritative || JSON.stringify(authoritative) !== JSON.stringify(previous.latest))
      throw new Error(
        "Previous authoritative Shadow snapshot is missing or mismatched; cannot advance",
      );
  }
  if (
    registry &&
    (registry.strategyId !== KOSPI_SHADOW_POLICY.id ||
      registry.ruleVersion !== KOSPI_SHADOW_POLICY.version ||
      registry.configHash !== session.configHash)
  )
    throw new Error("Shadow registry is frozen; rule/config mismatch");
  if (previous && session.date < previous.latest.source.date)
    throw new Error("Past Shadow date cannot replace latest");
  if (registry && !previous && registry.initializedDate !== session.date)
    throw new Error("Incomplete initial Shadow snapshot; retry the initialization date first");
  const newestDate = await store.latestSessionDate(`${userId}/${KOSPI_SHADOW_NAMESPACE}/sessions`);
  if (
    newestDate &&
    ((!previous && newestDate !== registry?.initializedDate) || newestDate > session.date)
  )
    throw new Error(
      "Newer immutable Shadow history exists; recover projection without resetting or rewinding capital",
    );
  const existing = await store.read<KospiShadowSnapshot>(path(`sessions/${session.date}.json`));
  if (
    existing &&
    (!sameFreeze(session, existing.source) ||
      existing.policy.version !== KOSPI_SHADOW_POLICY.version)
  )
    throw new Error("Completed Shadow date is immutable (input/config mismatch)");
  if (
    registry &&
    !previous &&
    !existing &&
    (registry.initialSourceHash !== session.sourceHash ||
      registry.initialCodeVersion !== session.codeVersion)
  )
    throw new Error(
      "Initial Shadow registry froze source and code; retry the original initialization input",
    );
  if (previous?.latest.source.date === session.date) {
    if (!existing) throw new Error("Completed Shadow snapshot is missing");
    return { reused: true, view: previous };
  }
  const snapshot = existing ?? stepKospiShadow(session, previous?.latest.state ?? null);
  if (existing && previous && existing.source.previousSessionDate !== previous.latest.source.date)
    throw new Error("Shadow replay predecessor mismatch");
  if (!registry) {
    registry = {
      strategyId: KOSPI_SHADOW_POLICY.id,
      ruleVersion: KOSPI_SHADOW_POLICY.version,
      initializedDate: session.date,
      configHash: session.configHash,
      config,
      initialSourceHash: session.sourceHash,
      initialCodeVersion: session.codeVersion,
    };
    await store.putImmutable(path("registry.json"), registry);
  }
  if (!existing) await store.putImmutable(path(`sessions/${session.date}.json`), snapshot);
  const allTrades = [...(previous?.recentTrades ?? []), ...snapshot.trades];
  const view: KospiShadowView = {
    schemaVersion: 1,
    registry,
    latest: snapshot,
    history: [...(previous?.history ?? []), snapshot.daily],
    recentTrades: allTrades.slice(-1000),
    tradeHistoryTruncated: (previous?.tradeHistoryTruncated ?? false) || allTrades.length > 1000,
  };
  await store.putLatest(path("latest.json"), view);
  previous = view;
  return { reused: !!existing, view };
}
