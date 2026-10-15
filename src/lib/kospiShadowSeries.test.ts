import { describe, expect, it } from "vitest";
import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiShadowRow,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "./engine/kospiShadow";
import { hashSeriesValue } from "./ledger/modelSeries";
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  shadowObjectPath,
  type KospiShadowView,
  type ShadowObjectStore,
} from "./kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  initializeKospiShadowRevision,
  kospiShadowRevision,
  openKospiShadowRevisionStore,
} from "./kospiShadowSeries";
const UID = "00000000-0000-0000-0000-000000000001";
const OTHER_UID = "00000000-0000-0000-0000-000000000002";
const REVISION = KOSPI_SHADOW_CORRECTION_REVISION_ID;
const ROOT = `${UID}/${KOSPI_SHADOW_NAMESPACE}`;
const REVISION_ROOT = `${ROOT}/revisions/${REVISION}`;
const CONFIG = { fixture: "synthetic-shadow-revision-test", version: 1 };
const COMPUTED_AT = "2026-10-15T00:10:00Z";
const CORRECTED_COLLECTED_AT = "2026-10-15T00:00:00Z";
const HELD = "TEST_HELD",
  OLD = "TEST_OLD",
  NEW = "TEST_NEW";
const PREFIX_DATES = [
  "2026-10-02",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-12",
  "2026-10-13",
] as const;
type Approval = Parameters<typeof initializeKospiShadowRevision>[4];
type Write = { kind: "immutable" | "latest"; path: string };
type FailurePhase = "before" | "after";
function memoryStore() {
  const data = new Map<string, string>(),
    writes: Write[] = [];
  let writeIndex = 0,
    failure: { index: number; phase: FailurePhase } | null = null;
  function write(kind: Write["kind"], path: string, value: unknown) {
    const index = writeIndex++;
    writes.push({ kind, path });
    if (failure?.index === index && failure.phase === "before")
      throw new Error("injected write failure");
    if (kind === "immutable" && data.has(path)) throw new Error(`immutable collision: ${path}`);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("non-JSON test value");
    data.set(path, serialized);
    if (failure?.index === index && failure.phase === "after")
      throw new Error("injected write failure");
  }
  const io: ShadowObjectStore = {
    read: async <T>(path: string): Promise<T | null> => {
      const serialized = data.get(path);
      return serialized === undefined ? null : (JSON.parse(serialized) as T);
    },
    latestSessionDate: async (namespace: string) => {
      const prefix = `${namespace}/`;
      return (
        [...data.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          .filter((suffix) => /^\d{4}-\d{2}-\d{2}\.json$/.test(suffix))
          .map((suffix) => suffix.slice(0, -5))
          .sort()
          .at(-1) ?? null
      );
    },
    putImmutable: async (path, value) => write("immutable", path, value),
    putLatest: async (path, value) => write("latest", path, value),
  };
  return {
    data,
    writes,
    io,
    get<T>(path: string): T {
      const serialized = data.get(path);
      if (serialized === undefined) throw new Error(`missing test object: ${path}`);
      return JSON.parse(serialized) as T;
    },
    resetWrites() {
      writes.length = 0;
      writeIndex = 0;
      failure = null;
    },
    failAt(index: number, phase: FailurePhase) {
      writes.length = 0;
      writeIndex = 0;
      failure = { index, phase };
    },
    bytes() {
      return [...data.entries()].sort(([a], [b]) => a.localeCompare(b));
    },
  };
}
function row(date: string, symbol: string, score: number, sector: string): KospiShadowRow {
  return {
    symbol,
    name: `Synthetic ${symbol}`,
    sector,
    date,
    open: 100,
    close: 100,
    volume: 1_000,
    score,
    priority: 1,
    rsAccel: 1,
    commonHistory: true,
    onsetEligible: true,
  };
}
function session(
  date: string,
  previousSessionDate: string,
  configHash: string,
  scores: readonly [number, number, number] = [8.5, 7, 7],
): KospiShadowSession {
  return {
    date,
    previousSessionDate,
    sourceHash: `sha256:${"1".repeat(64)}`,
    configHash,
    codeVersion: "synthetic-code-v1",
    sourceCollectedAt: `${date}T08:00:00Z`,
    confirmedClose: true,
    benchmarkClose: 2_500,
    gate: { date, status: "NEUTRAL", issues: [] },
    rows: [
      row(date, HELD, scores[0], "SYNTHETIC_HELD"),
      row(date, OLD, scores[1], "SYNTHETIC_OLD"),
      row(date, NEW, scores[2], "SYNTHETIC_NEW"),
    ],
  };
}
function originalBytes(s: ReturnType<typeof memoryStore>) {
  return s
    .bytes()
    .filter(([path]) => path.startsWith(`${ROOT}/`) && !path.startsWith(`${ROOT}/revisions/`));
}
async function fixture() {
  const s = memoryStore(),
    configHash = await hashSeriesValue(CONFIG);
  let previousDate = "2026-10-01";
  for (const [index, date] of PREFIX_DATES.entries()) {
    const input = session(date, previousDate, configHash, [
      index === 0 ? 7 : index === 1 ? 8 : 8.5,
      7,
      7,
    ]);
    input.sourceHash = await hashSeriesValue({ fixture: "prefix", date });
    await persistKospiShadow(s.io, UID, input, CONFIG);
    previousDate = date;
  }
  const predecessor = s.get<KospiShadowSnapshot>(shadowObjectPath(UID, "sessions/2026-10-13.json"));
  const originalInput = session("2026-10-14", "2026-10-13", configHash, [8.5, 8, 7]);
  originalInput.sourceHash = await hashSeriesValue({ fixture: "original-october14" });
  const original = (await persistKospiShadow(s.io, UID, originalInput, CONFIG)).view;
  const corrected = session("2026-10-14", "2026-10-13", configHash, [8.5, 7, 8]);
  corrected.sourceHash = await hashSeriesValue({ fixture: "corrected-october14" });
  corrected.sourceCollectedAt = CORRECTED_COLLECTED_AT;
  const approval: Approval = {
    revisionId: REVISION,
    predecessorDate: "2026-10-13",
    correctionDate: "2026-10-14",
    expectedPredecessorHash: await hashSeriesValue(predecessor),
    expectedOriginalTargetHash: await hashSeriesValue(original.latest),
    expectedCorrectedSourceHash: corrected.sourceHash,
    computedAt: COMPUTED_AT,
  };
  const before = originalBytes(s);
  s.resetWrites();
  return { s, configHash, predecessor, original, corrected, approval, before };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function bootstrap(f: Fixture, approval: Approval = f.approval) {
  return initializeKospiShadowRevision(f.s.io, UID, f.corrected, CONFIG, approval);
}
function expectOriginalUnchanged(f: Fixture) {
  expect(originalBytes(f.s)).toEqual(f.before);
}
function expectOnlyRevisionWrites(f: Fixture) {
  expect(f.s.writes.every(({ path }) => path.startsWith(`${REVISION_ROOT}/`))).toBe(true);
}
async function nextSession(f: Fixture) {
  const next = session("2026-10-15", "2026-10-14", f.configHash, [8.5, 7, 8.5]);
  next.sourceHash = await hashSeriesValue({ fixture: "next-october15" });
  return next;
}
describe("isolated retrospective KOSPI Shadow revision", () => {
  it("preserves original bytes and inherited capital while replacing only the corrected target", async () => {
    const f = await fixture(),
      expected = stepKospiShadow(f.corrected, f.predecessor.state),
      { reused, view } = await bootstrap(f);
    expect(REVISION).toBe("october14-retrospective-v1");
    expect(reused).toBe(false);
    expect(view.latest).toEqual(expected);
    expect(view.registry.initializedDate).toBe(PREFIX_DATES[0]);
    expect(view.latest.state.initializedDate).toBe(PREFIX_DATES[0]);
    expect(view.latest.state.sessions).toBe(f.predecessor.state.sessions + 1);
    expect(f.predecessor.state.cashKrw).toBeLessThan(KOSPI_SHADOW_POLICY.initialCapitalKrw);
    expect(Object.keys(f.predecessor.state.positions)).toEqual([HELD]);
    expect(view.latest.state.cashKrw).toBe(f.predecessor.state.cashKrw);
    expect(view.latest.state.positions[HELD]).toMatchObject({
      shares: f.predecessor.state.positions[HELD]!.shares,
      entryDate: f.predecessor.state.positions[HELD]!.entryDate,
      entryPrice: f.predecessor.state.positions[HELD]!.entryPrice,
      basisKrw: f.predecessor.state.positions[HELD]!.basisKrw,
    });
    expect(f.original.latest.state.awaiting.map((candidate) => candidate.symbol)).toEqual([OLD]);
    expect(view.latest.state.awaiting.map((candidate) => candidate.symbol)).toEqual([NEW]);
    expect(view.latest.source.sourceHash).toBe(f.corrected.sourceHash);
    expect(view.latest.source.sourceHash).not.toBe(f.original.latest.source.sourceHash);
    expect(view.history).toEqual([...f.original.history.slice(0, -1), expected.daily]);
    expect(view.recentTrades).toEqual(f.original.recentTrades);
    expect(view.tradeHistoryTruncated).toBe(f.original.tradeHistoryTruncated);
    for (const date of PREFIX_DATES)
      expect(f.s.data.get(`${REVISION_ROOT}/sessions/${date}.json`)).toBe(
        f.s.data.get(shadowObjectPath(UID, `sessions/${date}.json`)),
      );
    expect(kospiShadowRevision(view)).toMatchObject({
      version: "kospi-shadow-retrospective-v1",
      revisionId: REVISION,
      predecessorDate: "2026-10-13",
      correctionDate: "2026-10-14",
      expectedPredecessorHash: f.approval.expectedPredecessorHash,
      expectedOriginalTargetHash: f.approval.expectedOriginalTargetHash,
      correctedSourceHash: f.corrected.sourceHash,
      configHash: f.configHash,
      codeVersion: f.corrected.codeVersion,
      sourceCollectedAt: CORRECTED_COLLECTED_AT,
      computedAt: COMPUTED_AT,
      inheritedThrough: "2026-10-13",
      retrospective: true,
      resetCapital: false,
    });
    expect(f.s.get<Record<string, unknown>>(`${REVISION_ROOT}/revision.json`)).toMatchObject(
      kospiShadowRevision(view)!,
    );
    expectOnlyRevisionWrites(f);
    expectOriginalUnchanged(f);
  });
  it("reuses an identical completed revision without appending or rewriting immutable objects", async () => {
    const f = await fixture(),
      first = await bootstrap(f),
      before = f.s.bytes();
    f.s.resetWrites();
    const second = await bootstrap(f);
    expect(second.reused).toBe(true);
    expect(second.view).toEqual(first.view);
    expect(f.s.bytes()).toEqual(before);
    expect(f.s.writes.every((write) => write.kind === "latest")).toBe(true);
    expectOnlyRevisionWrites(f);
    expectOriginalUnchanged(f);
  });
  it.each([
    "expectedPredecessorHash",
    "expectedOriginalTargetHash",
    "expectedCorrectedSourceHash",
  ] as const)("rejects a wrong approved %s before any writes", async (field) => {
    const f = await fixture(),
      approval = {
        ...f.approval,
        [field]: await hashSeriesValue({ fixture: "not-the-approved-value", field }),
      },
      before = f.s.bytes();
    await expect(bootstrap(f, approval)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it.each([
    "expectedPredecessorHash",
    "expectedOriginalTargetHash",
    "expectedCorrectedSourceHash",
  ] as const)("rejects malformed approved %s before any writes", async (field) => {
    const f = await fixture();
    await expect(
      bootstrap(f, { ...f.approval, [field]: "sha256:not-a-real-hash" }),
    ).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expectOriginalUnchanged(f);
  });
  it.each([
    ["wrong target date", { date: "2026-10-15" }],
    ["wrong predecessor", { previousSessionDate: "2026-10-12" }],
    ["unconfirmed close", { confirmedClose: false }],
    ["different config hash", { configHash: `sha256:${"2".repeat(64)}` }],
    ["different source hash", { sourceHash: `sha256:${"3".repeat(64)}` }],
    ["source before the retrospective cutoff", { sourceCollectedAt: "2026-10-14T22:59:59Z" }],
    ["source after computation", { sourceCollectedAt: "2026-10-15T00:11:00Z" }],
    ["invalid source timestamp", { sourceCollectedAt: "not-a-timestamp" }],
  ] satisfies Array<[string, Partial<KospiShadowSession>]>)(
    "rejects %s before any writes",
    async (_label, patch) => {
      const f = await fixture(),
        before = f.s.bytes();
      await expect(
        initializeKospiShadowRevision(
          f.s.io,
          UID,
          { ...f.corrected, ...patch },
          CONFIG,
          f.approval,
        ),
      ).rejects.toThrow();
      expect(f.s.writes).toEqual([]);
      expect(f.s.bytes()).toEqual(before);
    },
  );
  it("binds supplied config to frozen hash", async () => {
    const f = await fixture();
    await expect(
      initializeKospiShadowRevision(
        f.s.io,
        UID,
        f.corrected,
        { ...CONFIG, version: 2 },
        f.approval,
      ),
    ).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expectOriginalUnchanged(f);
  });
  it.each(["2026-10-14T23:59:59Z", "not-a-timestamp"])(
    "rejects invalid computation %s before writes",
    async (computedAt) => {
      const f = await fixture();
      await expect(bootstrap(f, { ...f.approval, computedAt })).rejects.toThrow();
      expect(f.s.writes).toEqual([]);
      expectOriginalUnchanged(f);
    },
  );
  it.each(["2026-10-02", "2026-10-07", "2026-10-13"])(
    "refuses incomplete prefix missing %s",
    async (date) => {
      const f = await fixture();
      f.s.data.delete(shadowObjectPath(UID, `sessions/${date}.json`));
      const before = f.s.bytes();
      await expect(bootstrap(f)).rejects.toThrow();
      expect(f.s.writes).toEqual([]);
      expect(f.s.bytes()).toEqual(before);
    },
  );
  it("rejects broken predecessor links", async () => {
    const f = await fixture(),
      path = shadowObjectPath(UID, "sessions/2026-10-12.json"),
      broken = f.s.get<KospiShadowSnapshot>(path);
    broken.source.previousSessionDate = "2026-10-07";
    f.s.data.set(path, JSON.stringify(broken));
    const before = f.s.bytes();
    await expect(bootstrap(f)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it.each(["latest", "history"] as const)("rejects parent projection tamper %s", async (field) => {
    const f = await fixture(),
      path = shadowObjectPath(UID, "latest.json"),
      broken = f.s.get<KospiShadowView>(path);
    if (field === "latest") broken.latest.state.cashKrw += 1;
    else broken.history[0]!.navKrw += 1;
    f.s.data.set(path, JSON.stringify(broken));
    const before = f.s.bytes();
    await expect(bootstrap(f)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it("refuses bootstrap after original advances", async () => {
    const f = await fixture();
    await persistKospiShadow(f.s.io, UID, await nextSession(f), CONFIG);
    f.s.resetWrites();
    const before = f.s.bytes();
    await expect(bootstrap(f)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it("refuses newer original journal behind stale projection", async () => {
    const f = await fixture(),
      next = await nextSession(f);
    f.s.data.set(
      shadowObjectPath(UID, `sessions/${next.date}.json`),
      JSON.stringify(stepKospiShadow(next, f.original.latest.state)),
    );
    const before = f.s.bytes();
    await expect(bootstrap(f)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it.each([
    "revision.json",
    "registry.json",
    "sessions/2026-10-02.json",
    "sessions/2026-10-14.json",
  ])("rejects immutable collision %s before any write", async (suffix) => {
    const clean = await fixture();
    await bootstrap(clean);
    const path = `${REVISION_ROOT}/${suffix}`,
      conflicting = clean.s.get<Record<string, unknown>>(path);
    if (suffix === "revision.json") conflicting["resetCapital"] = true;
    else if (suffix === "registry.json") conflicting["initializedDate"] = "2026-10-06";
    else (conflicting as unknown as KospiShadowSnapshot).state.cashKrw += 1;
    const f = await fixture(),
      collisionBytes = JSON.stringify(conflicting);
    f.s.data.set(path, collisionBytes);
    await expect(bootstrap(f)).rejects.toThrow();
    expect(f.s.data.get(path)).toBe(collisionBytes);
    expect(f.s.writes).toEqual([]);
    expectOriginalUnchanged(f);
  });
  it.each(["before", "after"] as const)(
    "recovers idempotently from failure %s every bootstrap write",
    async (phase) => {
      const clean = await fixture(),
        expected = await bootstrap(clean),
        expectedBytes = clean.s.bytes(),
        count = clean.s.writes.length;
      expect(count).toBeGreaterThan(PREFIX_DATES.length);
      for (let index = 0; index < count; index++) {
        const f = await fixture();
        f.s.failAt(index, phase);
        await expect(bootstrap(f)).rejects.toThrow("injected write failure");
        expectOnlyRevisionWrites(f);
        expectOriginalUnchanged(f);
        f.s.resetWrites();
        const recovered = await bootstrap(f);
        expect(recovered.view).toEqual(expected.view);
        expect(f.s.bytes()).toEqual(expectedBytes);
        expectOnlyRevisionWrites(f);
        expectOriginalUnchanged(f);
      }
    },
    15_000,
  );
  it("cannot use adapter for fresh initialization", async () => {
    const f = await fixture(),
      before = f.s.bytes();
    await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it("requires bootstrap recovery after initial latest write fails", async () => {
    const clean = await fixture();
    await bootstrap(clean);
    const index = clean.s.writes.findIndex(
      (write) => write.kind === "latest" && write.path === `${REVISION_ROOT}/latest.json`,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const f = await fixture();
    f.s.failAt(index, "before");
    await expect(bootstrap(f)).rejects.toThrow("injected write failure");
    expect(f.s.data.has(`${REVISION_ROOT}/latest.json`)).toBe(false);
    f.s.resetWrites();
    await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    await bootstrap(f);
    await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).resolves.toBeDefined();
    expectOriginalUnchanged(f);
  });
  it("advances through unchanged writer preserving lineage and original", async () => {
    const f = await fixture(),
      initial = await bootstrap(f),
      lineage = kospiShadowRevision(initial.view),
      adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION),
      next = await nextSession(f),
      expected = stepKospiShadow(next, initial.view.latest.state);
    f.s.resetWrites();
    const advanced = await persistKospiShadow(adapter, UID, next, CONFIG);
    expect(advanced.reused).toBe(false);
    expect(advanced.view.latest).toEqual(expected);
    expect(advanced.view.registry.initializedDate).toBe(PREFIX_DATES[0]);
    expect(advanced.view.latest.state.initializedDate).toBe(PREFIX_DATES[0]);
    expect(kospiShadowRevision(advanced.view)).toEqual(lineage);
    expect(advanced.view.history).toEqual([...initial.view.history, expected.daily]);
    expect(advanced.view.latest.state.pendingEntries.map((c) => c.symbol)).toEqual([NEW]);
    expect(advanced.view.latest.state.pendingEntries.some((c) => c.symbol === OLD)).toBe(false);
    expect(f.s.data.has(`${REVISION_ROOT}/sessions/2026-10-15.json`)).toBe(true);
    expect(f.s.data.has(shadowObjectPath(UID, "sessions/2026-10-15.json"))).toBe(false);
    expect(await adapter.latestSessionDate(`${ROOT}/sessions`)).toBe("2026-10-15");
    expectOnlyRevisionWrites(f);
    expectOriginalUnchanged(f);
  });
  it("returns an already advanced complete revision without rewind", async () => {
    const f = await fixture();
    await bootstrap(f);
    const adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    const advanced = await persistKospiShadow(adapter, UID, await nextSession(f), CONFIG);
    f.s.resetWrites();
    const bytes = f.s.bytes();
    const result = await bootstrap(f);
    expect(result.view).toEqual(advanced.view);
    expect(result.reused).toBe(true);
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(bytes);
  });
  it("will not rewind advanced revision after latest loss", async () => {
    const f = await fixture();
    await bootstrap(f);
    const adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    await persistKospiShadow(adapter, UID, await nextSession(f), CONFIG);
    f.s.data.delete(`${REVISION_ROOT}/latest.json`);
    f.s.resetWrites();
    const before = f.s.bytes();
    await expect(bootstrap(f)).rejects.toThrow();
    await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
    expectOriginalUnchanged(f);
  });
  it("blocks registry and inherited-prefix writes", async () => {
    const f = await fixture();
    await bootstrap(f);
    const adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    f.s.resetWrites();
    const before = f.s.bytes();
    for (const suffix of ["registry.json", "sessions/2026-10-13.json"]) {
      const path = shadowObjectPath(UID, suffix);
      await expect(Promise.resolve().then(() => adapter.putImmutable(path, {}))).rejects.toThrow();
      await expect(Promise.resolve().then(() => adapter.putLatest(path, {}))).rejects.toThrow();
    }
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it.each(["", "../escape", "nested/revision", "a\\b", "%2e%2e%2fescape"])(
    "rejects unsafe revision ID %j",
    async (revisionId) => {
      const f = await fixture(),
        before = f.s.bytes();
      await expect(bootstrap(f, { ...f.approval, revisionId })).rejects.toThrow();
      await expect(openKospiShadowRevisionStore(f.s.io, UID, revisionId)).rejects.toThrow();
      expect(f.s.writes).toEqual([]);
      expect(f.s.bytes()).toEqual(before);
    },
  );
  it("rejects unsafe owners before writes", async () => {
    const f = await fixture();
    await expect(
      initializeKospiShadowRevision(f.s.io, "../owner", f.corrected, CONFIG, f.approval),
    ).rejects.toThrow();
    await expect(openKospiShadowRevisionStore(f.s.io, "../owner", REVISION)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expectOriginalUnchanged(f);
  });
  it("rejects traversal, physical bypass and other owner paths", async () => {
    const f = await fixture();
    await bootstrap(f);
    const adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    f.s.resetWrites();
    const before = f.s.bytes();
    for (const path of [
      `${ROOT}/../latest.json`,
      `${ROOT}/sessions/../../latest.json`,
      `${ROOT}/sessions/%2e%2e/latest.json`,
      `${REVISION_ROOT}/latest.json`,
      shadowObjectPath(OTHER_UID, "latest.json"),
    ]) {
      await expect(Promise.resolve().then(() => adapter.read(path))).rejects.toThrow();
      await expect(Promise.resolve().then(() => adapter.putLatest(path, {}))).rejects.toThrow();
      await expect(Promise.resolve().then(() => adapter.putImmutable(path, {}))).rejects.toThrow();
    }
    for (const namespace of [
      `${ROOT}/sessions/../sessions`,
      `${REVISION_ROOT}/sessions`,
      `${OTHER_UID}/${KOSPI_SHADOW_NAMESPACE}/sessions`,
    ])
      await expect(
        Promise.resolve().then(() => adapter.latestSessionDate(namespace)),
      ).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
  });
  it("returns null only for absent metadata and rejects malformed descriptors", async () => {
    const f = await fixture();
    expect(kospiShadowRevision(f.original)).toBeNull();
    const { view } = await bootstrap(f),
      lineage = kospiShadowRevision(view);
    expect(lineage).not.toBeNull();
    for (const patch of [
      { resetCapital: true },
      { retrospective: false },
      { revisionId: "../escape" },
      { expectedPredecessorHash: "not-a-hash" },
    ]) {
      const malformed = structuredClone(view);
      (malformed.registry as unknown as { revision: unknown }).revision = { ...lineage, ...patch };
      expect(() => kospiShadowRevision(malformed)).toThrow();
    }
  });
  it.each(["2026-10-02", "2026-10-13"])(
    "refuses open after inherited snapshot %s changed",
    async (date) => {
      const f = await fixture();
      await bootstrap(f);
      const path = `${REVISION_ROOT}/sessions/${date}.json`,
        changed = f.s.get<KospiShadowSnapshot>(path);
      changed.state.cashKrw += 1;
      f.s.data.set(path, JSON.stringify(changed));
      f.s.resetWrites();
      const before = f.s.bytes();
      await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
      expect(f.s.writes).toEqual([]);
      expect(f.s.bytes()).toEqual(before);
      expectOriginalUnchanged(f);
    },
  );
  it("refuses open with missing inherited snapshot", async () => {
    const f = await fixture();
    await bootstrap(f);
    f.s.data.delete(`${REVISION_ROOT}/sessions/2026-10-07.json`);
    f.s.resetWrites();
    const before = f.s.bytes();
    await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
    expectOriginalUnchanged(f);
  });
  it.each(["history", "recentTrades", "tradeHistoryTruncated"] as const)(
    "refuses open with altered projected %s",
    async (field) => {
      const f = await fixture();
      await bootstrap(f);
      const path = `${REVISION_ROOT}/latest.json`,
        changed = f.s.get<KospiShadowView>(path);
      if (field === "history") changed.history[0]!.navKrw += 1;
      else if (field === "recentTrades") {
        expect(changed.recentTrades.length).toBeGreaterThan(0);
        changed.recentTrades = [];
      } else changed.tradeHistoryTruncated = !changed.tradeHistoryTruncated;
      f.s.data.set(path, JSON.stringify(changed));
      f.s.resetWrites();
      const before = f.s.bytes();
      await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
      expect(f.s.writes).toEqual([]);
      expect(f.s.bytes()).toEqual(before);
      expectOriginalUnchanged(f);
    },
  );
  it("does not change computation timestamp on retry", async () => {
    const f = await fixture();
    await bootstrap(f);
    f.s.resetWrites();
    const before = f.s.bytes();
    await expect(
      bootstrap(f, { ...f.approval, computedAt: "2026-10-15T00:20:00Z" }),
    ).rejects.toThrow();
    expect(f.s.bytes()).toEqual(before);
    expectOriginalUnchanged(f);
  });
  it.each([null, false, {}])("does not downgrade invalid present metadata %j", async (value) => {
    const f = await fixture(),
      { view } = await bootstrap(f),
      malformed = structuredClone(view);
    (malformed.registry as unknown as { revision: unknown }).revision = value;
    expect(() => kospiShadowRevision(malformed)).toThrow();
  });
  it("recovers a future immutable append after projection upload failure without duplicating trades", async () => {
    const f = await fixture();
    const initial = await bootstrap(f);
    const adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    const next = await nextSession(f);
    f.s.failAt(1, "before");
    await expect(persistKospiShadow(adapter, UID, next, CONFIG)).rejects.toThrow(
      "injected write failure",
    );
    expect(f.s.data.has(`${REVISION_ROOT}/sessions/2026-10-15.json`)).toBe(true);
    expect(f.s.get<KospiShadowView>(`${REVISION_ROOT}/latest.json`)).toEqual(initial.view);
    f.s.resetWrites();
    const reopened = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    const repaired = await persistKospiShadow(reopened, UID, next, CONFIG);
    expect(repaired.reused).toBe(true);
    expect(repaired.view.latest).toEqual(stepKospiShadow(next, initial.view.latest.state));
    expect(repaired.view.history.map((day) => day.date)).toEqual([
      ...initial.view.history.map((day) => day.date),
      next.date,
    ]);
    expect(repaired.view.recentTrades).toEqual([
      ...initial.view.recentTrades,
      ...repaired.view.latest.trades,
    ]);
    expect(f.s.writes).toEqual([{ kind: "latest", path: `${REVISION_ROOT}/latest.json` }]);
    expectOriginalUnchanged(f);
  });
  it("refuses reopening with multiple unprojected future journal appends", async () => {
    const f = await fixture();
    const initial = await bootstrap(f);
    const next = await nextSession(f);
    const pending = stepKospiShadow(next, initial.view.latest.state);
    f.s.data.set(`${REVISION_ROOT}/sessions/2026-10-15.json`, JSON.stringify(pending));
    const second = session("2026-10-16", "2026-10-15", f.configHash);
    f.s.data.set(
      `${REVISION_ROOT}/sessions/2026-10-16.json`,
      JSON.stringify(stepKospiShadow(second, pending.state)),
    );
    f.s.resetWrites();
    await expect(openKospiShadowRevisionStore(f.s.io, UID, REVISION)).rejects.toThrow();
    expect(f.s.writes).toEqual([]);
  });
  it("cannot skip a pending immutable append with a later date claiming the stale predecessor", async () => {
    const f = await fixture();
    await bootstrap(f);
    const adapter = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    f.s.failAt(1, "before");
    await expect(persistKospiShadow(adapter, UID, await nextSession(f), CONFIG)).rejects.toThrow(
      "injected write failure",
    );
    f.s.resetWrites();
    const reopened = await openKospiShadowRevisionStore(f.s.io, UID, REVISION);
    const before = f.s.bytes();
    const skipped = session("2026-10-16", "2026-10-14", f.configHash);
    await expect(persistKospiShadow(reopened, UID, skipped, CONFIG)).rejects.toThrow(
      "pending authoritative revision snapshot",
    );
    expect(f.s.writes).toEqual([]);
    expect(f.s.bytes()).toEqual(before);
    expect(f.s.data.has(`${REVISION_ROOT}/sessions/2026-10-15.json`)).toBe(true);
  });
});
