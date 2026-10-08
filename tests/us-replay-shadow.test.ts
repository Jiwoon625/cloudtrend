import { describe, expect, it } from "vitest";
import type { OctoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import {
  recordOctoberPublication,
  type OctoberRun,
  type PreparedOctoberPublication,
} from "../src/lib/ledger/octoberShadowPipeline";
import {
  ADOPTED_SERIES_VERSION,
  freezeAdoptedSeries,
  hashSeriesValue,
  VERIFIED_INITIAL_FX,
  type FrozenModelSeries,
  type AdoptedSeriesKind,
  type SeriesHash,
} from "../src/lib/ledger/modelSeries";
import type { ModelJournalRun } from "../src/lib/ledger/modelJournal";
import { ADOPTED_SHADOW_FROZEN_CODE_HASH } from "../src/lib/ledger/octoberShadowRuntime";
import manifest from "../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import { parseUsProspectiveCsv, runUsProspectiveAnalysis } from "../src/lib/engine/usProspective";
import { shadowReplayClock } from "../src/lib/shadowReplay.server";
import { commitUsShadowReplay, planUsShadowReplay } from "../scripts/us-shadow-replay-plan";
import { bytesHash, type VerifiedUsReplaySession } from "../scripts/us-replay-source";
import { sourceCsv } from "./us-replay-fixtures";
async function setup() {
  const registry = new Map<string, FrozenModelSeries>();
  const sessions = new Map<string, ModelJournalRun>();
  const prepared = new Map<string, PreparedOctoberPublication>();
  const writes: string[] = [];
  const store: OctoberShadowStore = {
    async readKrInput() {
      throw new Error("No KR");
    },
    async putKrInput() {
      throw new Error("No KR");
    },
    async readPrepared(m, d) {
      return prepared.get(`${m}:${d}`) ?? null;
    },
    async prepare(p) {
      const old = prepared.get(`${p.market}:${p.date}`);
      if (old) {
        expect(p).toEqual(old);
        return old;
      }
      writes.push("prepare");
      prepared.set(`${p.market}:${p.date}`, structuredClone(p));
      return p;
    },
    async readSeries(b) {
      return registry.get(b) ?? null;
    },
    async insertSeries(s) {
      registry.set(s.bookId, s);
    },
    async readLatest<T extends ModelJournalRun>(b: string) {
      return (
        ([...sessions.values()]
          .filter((s) => s.bookId === b)
          .sort((a, b) => b.receipt.date.localeCompare(a.receipt.date))[0] as T | undefined) ?? null
      );
    },
    async readSession<T extends ModelJournalRun>(b: string, d: string) {
      return (sessions.get(`${b}:${d}`) as T | undefined) ?? null;
    },
    async append(s, r, p) {
      expect((await store.readLatest(s.bookId))?.stateHash ?? null).toBe(p?.stateHash ?? null);
      writes.push("append");
      sessions.set(`${s.bookId}:${r.receipt.date}`, structuredClone(r));
      return { reused: false, stateHash: r.stateHash };
    },
  };
  for (const kind of ["US_A0", "US_A2", "US_B3"] as AdoptedSeriesKind[])
    await store.insertSeries(
      await freezeAdoptedSeries({
        kind,
        frozenAt: "2026-10-03T00:00:00Z",
        codeHash: ADOPTED_SHADOW_FROZEN_CODE_HASH,
        sourceHash: `sha256:${"b".repeat(64)}`,
        initialFx: VERIFIED_INITIAL_FX,
      }),
    );
  const base = runUsProspectiveAnalysis(parseUsProspectiveCsv(sourceCsv("2026-10-05")));
  const clock = shadowReplayClock("US", base.date, "2026-10-08T00:00:00Z");
  await recordOctoberPublication(store, {
    market: "US",
    analysis: base,
    sourceHash: await hashSeriesValue({ test: "base" }),
    codeHash: ADOPTED_SHADOW_FROZEN_CODE_HASH,
    runtimeCodeHash: manifest.codeHash as SeriesHash,
    availableAt: clock.modelAvailableAt,
    decisionAt: clock.modelDecisionAt,
    confirmedRegularClose: true,
    failedSymbols: 0,
    previousSessionDate: "2026-10-02",
    marketCalendarOk: true,
  });
  writes.length = 0;
  const dated = ["2026-10-06", "2026-10-07"].map(
    (date, i) =>
      ({
        rows: parseUsProspectiveCsv(sourceCsv(date)),
        source: {
          date,
          previousSessionDate: i ? "2026-10-06" : "2026-10-05",
          dataHash: bytesHash(sourceCsv(date)),
          sourceCapturedAt: `${date}T21:00:00Z`,
        },
      }) as VerifiedUsReplaySession,
  );
  return { store, registry, sessions, prepared, writes, base, dated };
}
describe("complete-batch US Shadow recovery preflight", () => {
  it("calculates six frozen sessions without any real persistence, then commits idempotently", async () => {
    const f = await setup();
    const prefix = structuredClone([...f.sessions]);
    const input = {
      store: f.store,
      baseDate: "2026-10-05",
      previousRankState: f.base.state,
      sessions: f.dated,
      calculatedAt: "2026-10-08T02:00:00Z",
    };
    const plan = await planUsShadowReplay(input);
    expect(f.writes).toEqual([]);
    expect([...f.sessions]).toEqual(prefix);
    expect(plan.prepared).toHaveLength(2);
    expect(plan.prepared.every((p) => p.entries.length === 3)).toBe(true);
    await commitUsShadowReplay(f.store, plan);
    expect(f.sessions.size).toBe(9);
    for (const [k, v] of prefix) expect(f.sessions.get(k)).toEqual(v);
    const after = structuredClone([...f.sessions]);
    const writes = [...f.writes];
    const replayed = await planUsShadowReplay(input);
    expect(replayed).toEqual(plan);
    await commitUsShadowReplay(f.store, replayed);
    expect([...f.sessions]).toEqual(after);
    expect(f.writes).toEqual(writes);
  });
  it("rejects a malformed final day without persisting the valid first day", async () => {
    const f = await setup();
    f.dated[1]!.rows.push(f.dated[1]!.rows[0]!);
    await expect(
      planUsShadowReplay({
        store: f.store,
        baseDate: "2026-10-05",
        previousRankState: f.base.state,
        sessions: f.dated,
        calculatedAt: "2026-10-08T02:00:00Z",
      }),
    ).rejects.toThrow("unique symbols");
    expect(f.writes).toEqual([]);
    expect(f.sessions.size).toBe(3);
  });
  it("forbids state bootstrap and unreviewed registry identity", async () => {
    const f = await setup();
    const input = {
      store: f.store,
      baseDate: "2026-10-05",
      previousRankState: {},
      sessions: f.dated,
      calculatedAt: "2026-10-08T02:00:00Z",
    };
    await expect(planUsShadowReplay(input)).rejects.toThrow("bootstrap");
    const bookId = `${ADOPTED_SERIES_VERSION}:US_B3`;
    f.registry.set(bookId, { ...f.registry.get(bookId)!, codeHash: `sha256:${"f".repeat(64)}` });
    await expect(planUsShadowReplay({ ...input, previousRankState: f.base.state })).rejects.toThrow(
      "registry code hash",
    );
    expect(f.writes).toEqual([]);
  });
});
