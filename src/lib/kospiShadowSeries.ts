import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  validateShadowSession,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "./engine/kospiShadow";
import {
  KOSPI_SHADOW_NAMESPACE,
  shadowObjectPath,
  type KospiShadowRegistry,
  type KospiShadowView,
  type ShadowObjectStore,
} from "./kospiShadowStore";
import { canonicalSeriesJson, hashSeriesValue } from "./ledger/modelSeries";

/** This is an explicitly retrospective continuation, never a replacement of the original journal. */
export const KOSPI_SHADOW_CORRECTION_REVISION_ID = "october14-retrospective-v1";
export interface KospiShadowRevisionApproval {
  revisionId: string;
  predecessorDate: "2026-10-13";
  correctionDate: "2026-10-14";
  expectedPredecessorHash: string;
  expectedOriginalTargetHash: string;
  expectedCorrectedSourceHash: string;
  computedAt: string;
}
export interface KospiShadowRevision {
  version: "kospi-shadow-retrospective-v1";
  revisionId: string;
  parentNamespace: typeof KOSPI_SHADOW_NAMESPACE;
  predecessorDate: "2026-10-13";
  correctionDate: "2026-10-14";
  inheritedThrough: "2026-10-13";
  expectedPredecessorHash: string;
  expectedOriginalTargetHash: string;
  correctedSourceHash: string;
  configHash: string;
  codeVersion: string;
  sourceCollectedAt: string;
  computedAt: string;
  parentRegistryHash: string;
  inheritedPrefix: Array<{ date: string; hash: string }>;
  retrospective: true;
  resetCapital: false;
}
type RevisionRegistry = KospiShadowRegistry & { revision: KospiShadowRevision };
type Reader = ShadowObjectStore["read"];
const DATE_13 = "2026-10-13";
const DATE_14 = "2026-10-14";
const REGISTRATION_FLOOR = Date.parse("2026-10-15T08:00:00+09:00");
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
function fail(message: string): never {
  throw new Error(`KOSPI Shadow revision: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    fail("explicit valid timestamp with timezone required");
  return Date.parse(value);
}
function code(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9:+._-]+$/.test(value)
  );
}
function revisionId(value: unknown): asserts value is typeof KOSPI_SHADOW_CORRECTION_REVISION_ID {
  if (value !== KOSPI_SHADOW_CORRECTION_REVISION_ID) fail("unsupported revision ID");
}
function owner(userId: string) {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(userId))
    fail("invalid owner");
}
export function kospiShadowRevisionPath(
  userId: string,
  suffix: string,
  id: string = KOSPI_SHADOW_CORRECTION_REVISION_ID,
): string {
  owner(userId);
  revisionId(id);
  const dated = /^sessions\/(\d{4}-\d{2}-\d{2})\.json$/.exec(suffix);
  if (
    !["revision.json", "registry.json", "latest.json"].includes(suffix) &&
    !(dated && validDate(dated[1]))
  )
    fail("invalid revision object path");
  return `${userId}/${KOSPI_SHADOW_NAMESPACE}/revisions/${id}/${suffix}`;
}
export function validateKospiShadowRevision(value: unknown): KospiShadowRevision {
  if (!record(value)) fail("malformed revision metadata");
  revisionId(value["revisionId"]);
  if (
    value["version"] !== "kospi-shadow-retrospective-v1" ||
    value["parentNamespace"] !== KOSPI_SHADOW_NAMESPACE ||
    value["predecessorDate"] !== DATE_13 ||
    value["correctionDate"] !== DATE_14 ||
    value["inheritedThrough"] !== DATE_13 ||
    value["retrospective"] !== true ||
    value["resetCapital"] !== false
  )
    fail("unsupported revision lineage or capital reset");
  for (const field of [
    "expectedPredecessorHash",
    "expectedOriginalTargetHash",
    "correctedSourceHash",
    "configHash",
    "parentRegistryHash",
  ])
    if (!hash(value[field])) fail(`invalid ${field}`);
  if (!code(value["codeVersion"])) fail("invalid code provenance");
  const sourceAt = timestamp(value["sourceCollectedAt"]);
  if (sourceAt < REGISTRATION_FLOOR || timestamp(value["computedAt"]) < sourceAt)
    fail("source registration/computation timing is invalid");
  const prefix = value["inheritedPrefix"];
  if (!Array.isArray(prefix) || !prefix.length || prefix.length > 10000)
    fail("missing inherited prefix");
  let previous = "";
  for (const entry of prefix) {
    if (
      !record(entry) ||
      !validDate(entry["date"]) ||
      entry["date"] <= previous ||
      entry["date"] > DATE_13 ||
      !hash(entry["hash"]) ||
      Object.keys(entry).sort().join(",") !== "date,hash"
    )
      fail("invalid inherited prefix");
    previous = entry["date"];
  }
  const last = prefix.at(-1)!;
  if (last["date"] !== DATE_13 || last["hash"] !== value["expectedPredecessorHash"])
    fail("inherited predecessor hash mismatch");
  canonicalSeriesJson(value);
  return clone(value) as unknown as KospiShadowRevision;
}
export function kospiShadowRevision(view: KospiShadowView): KospiShadowRevision | null {
  if (!record(view?.registry)) fail("missing registry");
  if (!Object.hasOwn(view.registry, "revision")) return null;
  return validateKospiShadowRevision(
    (view.registry as unknown as Record<string, unknown>)["revision"],
  );
}
function assertRegistry(registry: KospiShadowRegistry, configHash: string) {
  if (
    !record(registry) ||
    registry.strategyId !== KOSPI_SHADOW_POLICY.id ||
    registry.ruleVersion !== KOSPI_SHADOW_POLICY.version ||
    !validDate(registry.initializedDate) ||
    registry.initializedDate > DATE_13 ||
    registry.configHash !== configHash ||
    !hash(registry.configHash) ||
    !hash(registry.initialSourceHash) ||
    !code(registry.initialCodeVersion)
  )
    fail("frozen registry mismatch");
}
function assertSnapshot(
  snapshot: KospiShadowSnapshot,
  date: string,
  registry: KospiShadowRegistry,
) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !record(snapshot.policy) ||
    !Object.entries(KOSPI_SHADOW_POLICY).every(([key, value]) =>
      same((snapshot.policy as unknown as Record<string, unknown>)[key], value),
    ) ||
    snapshot.source?.date !== date ||
    snapshot.daily?.date !== date ||
    snapshot.state?.lastDate !== date ||
    snapshot.source.configHash !== registry.configHash ||
    snapshot.state.configHash !== registry.configHash ||
    snapshot.state.strategyId !== KOSPI_SHADOW_POLICY.id ||
    snapshot.state.ruleVersion !== registry.ruleVersion ||
    snapshot.state.initializedDate !== registry.initializedDate ||
    snapshot.state.initialCapitalKrw !== KOSPI_SHADOW_POLICY.initialCapitalKrw ||
    snapshot.state.executionPolicy ||
    !hash(snapshot.source.sourceHash) ||
    !code(snapshot.source.codeVersion) ||
    !Number.isInteger(snapshot.state.sessions) ||
    snapshot.state.sessions < 1 ||
    !Array.isArray(snapshot.trades) ||
    !Array.isArray(snapshot.candidates)
  )
    fail(`invalid authoritative snapshot ${date}`);
  timestamp(snapshot.source.sourceCollectedAt);
  if (
    !snapshot.source.confirmedClose ||
    snapshot.source.gate?.date !== date ||
    !Number.isFinite(snapshot.source.benchmarkClose) ||
    snapshot.source.benchmarkClose <= 0
  )
    fail(`invalid snapshot source ${date}`);
  const previous = snapshot.source.previousSessionDate;
  if (previous !== null && (!validDate(previous) || previous >= date))
    fail("invalid predecessor date");
  canonicalSeriesJson(snapshot);
}
async function readChain(
  read: Reader,
  root: string,
  latestDate: string,
  registry: KospiShadowRegistry,
): Promise<KospiShadowSnapshot[]> {
  const chain: KospiShadowSnapshot[] = [];
  let date = latestDate;
  while (true) {
    if (!validDate(date) || date < registry.initializedDate || chain.length > 10000)
      fail("invalid or incomplete journal chain");
    const snapshot = await read<KospiShadowSnapshot>(`${root}/sessions/${date}.json`);
    if (!snapshot) fail(`missing authoritative snapshot ${date}`);
    assertSnapshot(snapshot, date, registry);
    chain.push(snapshot);
    if (date === registry.initializedDate) break;
    const prior = snapshot.source.previousSessionDate;
    if (!prior || prior >= date || prior < registry.initializedDate)
      fail("journal predecessor gap");
    date = prior;
  }
  chain.reverse();
  for (const [i, snapshot] of chain.entries())
    if (snapshot.state.sessions !== i + 1) fail("journal session count mismatch");
  return chain;
}
function projected(registry: KospiShadowRegistry, chain: KospiShadowSnapshot[]): KospiShadowView {
  if (!chain.length) fail("empty journal");
  const trades = chain.flatMap((snapshot) => snapshot.trades);
  return {
    schemaVersion: 1,
    registry: clone(registry),
    latest: clone(chain.at(-1)!),
    history: chain.map((snapshot) => clone(snapshot.daily)),
    recentTrades: clone(trades.slice(-1000)),
    tradeHistoryTruncated: trades.length > 1000,
  };
}
function assertProjection(
  view: KospiShadowView,
  registry: KospiShadowRegistry,
  chain: KospiShadowSnapshot[],
) {
  if (!same(view, projected(registry, chain)))
    fail("authoritative history/trades projection mismatch");
}
export async function assertKospiShadowRevisionView(
  view: KospiShadowView,
  revision: KospiShadowRevision,
): Promise<void> {
  const metadata = validateKospiShadowRevision(revision);
  const embedded = kospiShadowRevision(view);
  if (!embedded || !same(metadata, embedded)) fail("registry revision descriptor mismatch");
  assertRegistry(view.registry, metadata.configHash);
  if (
    view.schemaVersion !== 1 ||
    view.registry.initializedDate !== metadata.inheritedPrefix[0]!.date ||
    view.latest?.source.date < DATE_14 ||
    !Array.isArray(view.history) ||
    !Array.isArray(view.recentTrades) ||
    typeof view.tradeHistoryTruncated !== "boolean"
  )
    fail("invalid retrospective view");
  assertSnapshot(view.latest, view.latest.source.date, view.registry);
  const originalRegistry = { ...view.registry } as KospiShadowRegistry & {
    revision?: KospiShadowRevision;
  };
  delete originalRegistry.revision;
  if ((await hashSeriesValue(originalRegistry)) !== metadata.parentRegistryHash)
    fail("parent registry hash mismatch");
  if ((await hashSeriesValue(view.registry.config)) !== metadata.configHash)
    fail("registry config content mismatch");
  if (
    view.latest.source.date === DATE_14 &&
    (view.latest.source.sourceHash !== metadata.correctedSourceHash ||
      view.latest.source.codeVersion !== metadata.codeVersion ||
      view.latest.source.sourceCollectedAt !== metadata.sourceCollectedAt ||
      view.latest.source.previousSessionDate !== DATE_13)
  )
    fail("corrected snapshot provenance mismatch");
}
/** Read-only integrity check for the complete authoritative revision journal and its projection. */
export async function validateKospiShadowRevisionJournal(
  read: Reader,
  namespace: string,
  view: KospiShadowView,
  revision: KospiShadowRevision,
): Promise<void> {
  const relative = `${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  if (namespace !== relative) {
    const suffix = `/${relative}`;
    if (!namespace.endsWith(suffix)) fail("invalid revision namespace");
    const uid = namespace.slice(0, -suffix.length);
    owner(uid);
    if (namespace !== kospiShadowRevisionPath(uid, "latest.json").slice(0, -"/latest.json".length))
      fail("invalid revision namespace");
  }
  await assertKospiShadowRevisionView(view, revision);
  const chain = await readChain(read, namespace, view.latest.source.date, view.registry);
  const inherited = chain.filter((snapshot) => snapshot.source.date <= DATE_13);
  if (inherited.length !== revision.inheritedPrefix.length)
    fail("inherited prefix length mismatch");
  for (const [i, snapshot] of inherited.entries()) {
    const entry = revision.inheritedPrefix[i]!;
    if (entry.date !== snapshot.source.date || (await hashSeriesValue(snapshot)) !== entry.hash)
      fail("inherited prefix snapshot hash mismatch");
  }
  const corrected = chain.find((snapshot) => snapshot.source.date === DATE_14);
  if (
    !corrected ||
    corrected.source.previousSessionDate !== DATE_13 ||
    corrected.source.sourceHash !== revision.correctedSourceHash ||
    corrected.source.codeVersion !== revision.codeVersion ||
    corrected.source.sourceCollectedAt !== revision.sourceCollectedAt
  )
    fail("corrected journal provenance mismatch");
  assertProjection(view, view.registry, chain);
}
async function originalAnchors(
  store: ShadowObjectStore,
  uid: string,
  revision: KospiShadowRevision,
) {
  const registry = await store.read<KospiShadowRegistry>(shadowObjectPath(uid, "registry.json"));
  const latest = await store.read<KospiShadowView>(shadowObjectPath(uid, "latest.json"));
  const predecessor = await store.read<KospiShadowSnapshot>(
    shadowObjectPath(uid, `sessions/${DATE_13}.json`),
  );
  const originalTarget = await store.read<KospiShadowSnapshot>(
    shadowObjectPath(uid, `sessions/${DATE_14}.json`),
  );
  if (
    !registry ||
    !latest ||
    !predecessor ||
    !originalTarget ||
    (await hashSeriesValue(registry)) !== revision.parentRegistryHash ||
    (await hashSeriesValue(predecessor)) !== revision.expectedPredecessorHash ||
    (await hashSeriesValue(originalTarget)) !== revision.expectedOriginalTargetHash ||
    !same(latest.registry, registry) ||
    !same(latest.latest, originalTarget) ||
    (await store.latestSessionDate(`${uid}/${KOSPI_SHADOW_NAMESPACE}/sessions`)) !== DATE_14
  )
    fail("original parent anchors changed or advanced");
  const originalChain = await readChain(
    store.read.bind(store),
    `${uid}/${KOSPI_SHADOW_NAMESPACE}`,
    DATE_14,
    registry,
  );
  assertProjection(latest, registry, originalChain);
  for (const [i, entry] of revision.inheritedPrefix.entries()) {
    const snapshot = originalChain[i];
    if (
      !snapshot ||
      snapshot.source.date !== entry.date ||
      (await hashSeriesValue(snapshot)) !== entry.hash
    )
      fail("original inherited prefix changed");
  }
  if (originalChain.length !== revision.inheritedPrefix.length + 1)
    fail("original inherited prefix mismatch");
}
export async function initializeKospiShadowRevision(
  store: ShadowObjectStore,
  userId: string,
  session: KospiShadowSession,
  config: unknown,
  approval: KospiShadowRevisionApproval,
): Promise<{ reused: boolean; view: KospiShadowView }> {
  owner(userId);
  if (!record(approval)) fail("missing approval");
  revisionId(approval.revisionId);
  if (
    approval.predecessorDate !== DATE_13 ||
    approval.correctionDate !== DATE_14 ||
    !hash(approval.expectedPredecessorHash) ||
    !hash(approval.expectedOriginalTargetHash) ||
    !hash(approval.expectedCorrectedSourceHash)
  )
    fail("invalid approval anchors");
  validateShadowSession(session);
  if (
    session.date !== DATE_14 ||
    session.previousSessionDate !== DATE_13 ||
    session.sourceHash !== approval.expectedCorrectedSourceHash ||
    !hash(session.configHash) ||
    !code(session.codeVersion) ||
    session.warmupRows
  )
    fail("correction session does not match approved boundary");
  if (
    timestamp(session.sourceCollectedAt) < REGISTRATION_FLOOR ||
    timestamp(approval.computedAt) < timestamp(session.sourceCollectedAt)
  )
    fail("invalid source registration/computation timing");
  if ((await hashSeriesValue(config)) !== session.configHash) fail("config content hash mismatch");
  const path = (suffix: string) => kospiShadowRevisionPath(userId, suffix, approval.revisionId);
  const root = path("latest.json").slice(0, -"/latest.json".length);
  const registry = await store.read<KospiShadowRegistry>(shadowObjectPath(userId, "registry.json"));
  const latest = await store.read<KospiShadowView>(shadowObjectPath(userId, "latest.json"));
  if (!registry || !latest || Object.hasOwn(registry, "revision"))
    fail("original registry/latest missing or already revised");
  assertRegistry(registry, session.configHash);
  if (
    !same(registry.config, config) ||
    !same(latest.registry, registry) ||
    latest.latest.source.date !== DATE_14 ||
    (await store.latestSessionDate(`${userId}/${KOSPI_SHADOW_NAMESPACE}/sessions`)) !== DATE_14
  )
    fail("original registry/projection or newest date mismatch");
  const originalChain = await readChain(
    store.read.bind(store),
    `${userId}/${KOSPI_SHADOW_NAMESPACE}`,
    DATE_14,
    registry,
  );
  assertProjection(latest, registry, originalChain);
  const originalTarget = originalChain.at(-1)!;
  const prefix = originalChain.slice(0, -1);
  const predecessor = prefix.at(-1);
  if (
    !predecessor ||
    predecessor.source.date !== DATE_13 ||
    originalTarget.source.previousSessionDate !== DATE_13 ||
    (await hashSeriesValue(predecessor)) !== approval.expectedPredecessorHash ||
    (await hashSeriesValue(originalTarget)) !== approval.expectedOriginalTargetHash
  )
    fail("approved predecessor/original target hash mismatch");
  const revision = validateKospiShadowRevision({
    version: "kospi-shadow-retrospective-v1",
    revisionId: approval.revisionId,
    parentNamespace: KOSPI_SHADOW_NAMESPACE,
    predecessorDate: DATE_13,
    correctionDate: DATE_14,
    inheritedThrough: DATE_13,
    expectedPredecessorHash: approval.expectedPredecessorHash,
    expectedOriginalTargetHash: approval.expectedOriginalTargetHash,
    correctedSourceHash: session.sourceHash,
    configHash: session.configHash,
    codeVersion: session.codeVersion,
    sourceCollectedAt: session.sourceCollectedAt,
    computedAt: approval.computedAt,
    parentRegistryHash: await hashSeriesValue(registry),
    inheritedPrefix: await Promise.all(
      prefix.map(async (snapshot) => ({
        date: snapshot.source.date,
        hash: await hashSeriesValue(snapshot),
      })),
    ),
    retrospective: true,
    resetCapital: false,
  });
  const revisedRegistry: RevisionRegistry = { ...clone(registry), revision };
  const corrected = stepKospiShadow(clone(session), clone(predecessor.state));
  assertSnapshot(corrected, DATE_14, revisedRegistry);
  const desired = projected(revisedRegistry, [...prefix, corrected]);
  const objects: Array<[string, unknown]> = [
    [path("revision.json"), revision],
    [path("registry.json"), revisedRegistry],
    ...prefix.map((snapshot): [string, unknown] => [
      path(`sessions/${snapshot.source.date}.json`),
      snapshot,
    ]),
    [path(`sessions/${DATE_14}.json`), corrected],
  ];
  const missing: Array<[string, unknown]> = [];
  // Validate every possible collision before the first mutation. Never repair by replacing an object.
  for (const [target, value] of objects) {
    const existing = await store.read(target);
    if (existing !== null && !same(existing, value)) fail("immutable revision collision");
    if (existing === null) missing.push([target, value]);
  }
  const existingLatest = await store.read<KospiShadowView>(path("latest.json"));
  const newest = await store.latestSessionDate(`${root}/sessions`);
  if (newest && (!validDate(newest) || (newest > DATE_14 && !existingLatest)))
    fail("newer immutable history exists without projection; cannot rewind");
  if (existingLatest) {
    if (
      missing.length ||
      !same(existingLatest.registry, revisedRegistry) ||
      !newest ||
      newest !== existingLatest.latest.source.date ||
      existingLatest.latest.source.date < DATE_14
    )
      fail("incomplete or mismatched existing revision projection");
    await validateKospiShadowRevisionJournal(
      store.read.bind(store),
      root,
      existingLatest,
      revision,
    );
    await originalAnchors(store, userId, revision);
    return { reused: true, view: existingLatest };
  }
  await originalAnchors(store, userId, revision);
  for (const [target, value] of missing) await store.putImmutable(target, clone(value));
  await validateKospiShadowRevisionJournal(store.read.bind(store), root, desired, revision);
  await originalAnchors(store, userId, revision);
  if ((await store.latestSessionDate(`${root}/sessions`)) !== DATE_14)
    fail("revision advanced during initialization; cannot rewind");
  const racedLatest = await store.read<KospiShadowView>(path("latest.json"));
  if (racedLatest && !same(racedLatest, desired))
    fail("revision projection changed during initialization");
  if (!racedLatest) await store.putLatest(path("latest.json"), desired);
  return { reused: missing.length === 0, view: desired };
}
export async function openKospiShadowRevisionStore(
  store: ShadowObjectStore,
  userId: string,
  id: string = KOSPI_SHADOW_CORRECTION_REVISION_ID,
): Promise<ShadowObjectStore> {
  const path = (suffix: string) => kospiShadowRevisionPath(userId, suffix, id);
  const root = path("latest.json").slice(0, -"/latest.json".length);
  const revision = validateKospiShadowRevision(await store.read(path("revision.json")));
  const registry = await store.read<RevisionRegistry>(path("registry.json"));
  const latest = await store.read<KospiShadowView>(path("latest.json"));
  if (
    !registry ||
    !latest ||
    !same(registry, latest.registry) ||
    !same(registry.revision, revision)
  )
    fail("incomplete revision registry/projection");
  await validateKospiShadowRevisionJournal(store.read.bind(store), root, latest, revision);
  const newest = await store.latestSessionDate(`${root}/sessions`);
  if (newest !== latest.latest.source.date) {
    // A single immutable append may have committed before its projection upload failed.
    // Keep the prior projection; the ordinary writer must retry that exact session/input.
    if (!newest || !validDate(newest) || newest <= latest.latest.source.date)
      fail("revision journal/projection date mismatch");
    const pendingChain = await readChain(store.read.bind(store), root, newest, registry);
    const pending = pendingChain.at(-1)!;
    if (
      pending.source.previousSessionDate !== latest.latest.source.date ||
      pending.state.sessions !== latest.latest.state.sessions + 1
    )
      fail("revision has more than one pending journal append");
    assertProjection(latest, registry, pendingChain.slice(0, -1));
    await validateKospiShadowRevisionJournal(
      store.read.bind(store),
      root,
      projected(registry, pendingChain),
      revision,
    );
  }
  await originalAnchors(store, userId, revision);
  const logicalRoot = `${userId}/${KOSPI_SHADOW_NAMESPACE}`;
  function mapped(logicalPath: string) {
    if (!logicalPath.startsWith(`${logicalRoot}/`)) fail("cross-owner or unrelated logical path");
    const suffix = logicalPath.slice(logicalRoot.length + 1);
    // The adapter exposes only the unchanged original store contract, never revision metadata writes.
    shadowObjectPath(userId, suffix);
    return { suffix, physical: path(suffix) };
  }
  const adapter: ShadowObjectStore = {
    read: async <T>(logicalPath: string) => store.read<T>(mapped(logicalPath).physical),
    latestSessionDate: async (namespacePath: string) => {
      if (namespacePath !== `${logicalRoot}/sessions`) fail("unrelated session namespace");
      return store.latestSessionDate(`${root}/sessions`);
    },
    putImmutable: async (logicalPath, value) => {
      const { suffix, physical } = mapped(logicalPath);
      const match = /^sessions\/(\d{4}-\d{2}-\d{2})\.json$/.exec(suffix);
      if (!match || !validDate(match[1]) || match[1] <= DATE_13)
        fail("registry and inherited prefix writes are forbidden");
      const date = match[1];
      const snapshot = value as KospiShadowSnapshot;
      assertSnapshot(snapshot, date, registry);
      const current = await store.read<KospiShadowView>(path("latest.json"));
      if (!current) fail("missing authoritative revision projection");
      await validateKospiShadowRevisionJournal(store.read.bind(store), root, current, revision);
      const existing = await store.read<KospiShadowSnapshot>(physical);
      if (existing) {
        if (!same(existing, snapshot)) fail("immutable revision snapshot collision");
        return;
      }
      if ((await store.latestSessionDate(`${root}/sessions`)) !== current.latest.source.date)
        fail("pending authoritative revision snapshot must be projected first");
      if (
        date <= current.latest.source.date ||
        snapshot.source.previousSessionDate !== current.latest.source.date ||
        snapshot.state.sessions !== current.latest.state.sessions + 1
      )
        fail("revision cannot rewind or skip its predecessor");
      await originalAnchors(store, userId, revision);
      await store.putImmutable(physical, value);
    },
    putLatest: async (logicalPath, value) => {
      const { suffix, physical } = mapped(logicalPath);
      if (suffix !== "latest.json") fail("only latest projection is mutable");
      const next = value as KospiShadowView;
      const current = await store.read<KospiShadowView>(physical);
      if (
        !current ||
        next.latest.source.date < current.latest.source.date ||
        !same(next.registry, registry)
      )
        fail("revision projection cannot reset or rewind");
      await validateKospiShadowRevisionJournal(store.read.bind(store), root, current, revision);
      await validateKospiShadowRevisionJournal(store.read.bind(store), root, next, revision);
      if ((await store.latestSessionDate(`${root}/sessions`)) !== next.latest.source.date)
        fail("newer authoritative revision history exists");
      await originalAnchors(store, userId, revision);
      await store.putLatest(physical, value);
    },
  };
  return adapter;
}
