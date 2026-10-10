import type { UsProspectivePreviousState } from "../src/lib/engine/usProspective";
import { runUsProspectiveAnalysis } from "../src/lib/engine/usProspective";
import {
  ADOPTED_SERIES_VERSION,
  hashSeriesValue,
  canonicalSeriesJson,
  type SeriesHash,
} from "../src/lib/ledger/modelSeries";
import type { ModelJournalRun } from "../src/lib/ledger/modelJournal";
import type { OctoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import {
  assertStoredOctoberRun,
  recordOctoberPublication,
  type OctoberRun,
  type PreparedOctoberPublication,
  type UsModelPublication,
} from "../src/lib/ledger/octoberShadowPipeline";
import {
  adoptedShadowFrozenCodeHash,
  assertAdoptedShadowRuntime,
} from "../src/lib/ledger/octoberShadowRuntime";
import manifest from "../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import { shadowReplayClock } from "../src/lib/shadowReplay.server";
import type { VerifiedUsReplaySession } from "./us-replay-source";

export const US_REPLAY_BOOK_IDS = ["US_A0", "US_A2", "US_B3"].map(
  (kind) => `${ADOPTED_SERIES_VERSION}:${kind}`,
);
/** Run the unchanged publication and model engines against a read-through, in-memory store.
 * No database, Storage or audit write is possible during this entire-batch preflight. */
export async function planUsShadowReplay(input: {
  store: OctoberShadowStore;
  baseDate: string;
  previousRankState: UsProspectivePreviousState;
  sessions: Array<{
    rows: VerifiedUsReplaySession["rows"];
    source: Pick<
      VerifiedUsReplaySession["source"],
      "date" | "previousSessionDate" | "dataHash" | "sourceCapturedAt"
    >;
  }>;
  calculatedAt: string;
}) {
  const { store } = input;
  if (
    input.previousRankState.lastDate !== input.baseDate ||
    !Object.keys(input.previousRankState.coreRanks ?? {}).length
  )
    throw new Error("Recovery requires the exact predecessor rank state; bootstrap is forbidden");
  const throughDate = input.sessions.at(-1)?.source.date;
  if (!throughDate) throw new Error("Empty US recovery batch");
  const virtualLatest = new Map<string, ModelJournalRun>();
  const virtualSessions = new Map<string, ModelJournalRun>();
  const virtualPrepared = new Map<string, PreparedOctoberPublication>();
  const codeHash = adoptedShadowFrozenCodeHash(manifest.codeHash);
  for (const bookId of US_REPLAY_BOOK_IDS) {
    const series = await store.readSeries(bookId);
    if (!series) throw new Error(`US Shadow registry is missing: ${bookId}`);
    assertAdoptedShadowRuntime(manifest.codeHash, series.codeHash);
    const base = await store.readSession<OctoberRun>(bookId, input.baseDate);
    const latest = await store.readLatest<OctoberRun>(bookId);
    if (
      !base ||
      !latest ||
      latest.receipt.date < input.baseDate ||
      latest.receipt.date > throughDate
    )
      throw new Error(`US recovery does not extend the protected Shadow prefix: ${bookId}`);
    await assertStoredOctoberRun(series, base);
    virtualLatest.set(bookId, base);
    virtualSessions.set(`${bookId}:${input.baseDate}`, base);
  }
  const virtual: OctoberShadowStore = {
    ...store,
    readLatest: async <T extends ModelJournalRun>(bookId: string) =>
      (virtualLatest.get(bookId) as T | undefined) ?? null,
    readSession: async <T extends ModelJournalRun>(bookId: string, date: string) =>
      (virtualSessions.get(`${bookId}:${date}`) as T | undefined) ??
      (await store.readSession<T>(bookId, date)),
    readPrepared: async (market, date) =>
      virtualPrepared.get(`${market}:${date}`) ?? (await store.readPrepared(market, date)),
    prepare: async (prepared) => {
      virtualPrepared.set(`${prepared.market}:${prepared.date}`, structuredClone(prepared));
      return prepared;
    },
    append: async (series, run, previous) => {
      if ((virtualLatest.get(series.bookId)?.stateHash ?? null) !== (previous?.stateHash ?? null))
        throw new Error("US dry-run predecessor changed");
      virtualLatest.set(series.bookId, structuredClone(run));
      virtualSessions.set(`${series.bookId}:${run.receipt.date}`, structuredClone(run));
      return { reused: false, stateHash: run.stateHash };
    },
    insertSeries: async () => {
      throw new Error("Recovery cannot initialize or change frozen contracts");
    },
    putKrInput: async () => {
      throw new Error("US recovery cannot write KR inputs");
    },
  };
  let rank = input.previousRankState;
  const publications: UsModelPublication[] = [];
  const planned: PreparedOctoberPublication[] = [];
  for (const session of input.sessions) {
    const clock = shadowReplayClock("US", session.source.date, input.calculatedAt);
    if (Date.parse(input.calculatedAt) < Date.parse(clock.modelDecisionAt))
      throw new Error("US replay before regular-close decision time is forbidden");
    const analysis = runUsProspectiveAnalysis(session.rows, rank);
    const sourceHash = await hashSeriesValue({
      version: "us-shadow-dated-input-v1",
      date: analysis.date,
      rows: [...session.rows].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    });
    const publication: UsModelPublication = {
      market: "US",
      analysis,
      sourceHash,
      codeHash,
      runtimeCodeHash: manifest.codeHash as SeriesHash,
      availableAt: clock.modelAvailableAt,
      decisionAt: clock.modelDecisionAt,
      confirmedRegularClose: true,
      failedSymbols: 0,
      previousSessionDate: session.source.previousSessionDate,
      marketCalendarOk: true,
    };
    // The engine checks holdings. Recovery additionally requires current prices for
    // pending orders so a quarantined target cannot be silently rolled or filled stale.
    for (const bookId of US_REPLAY_BOOK_IDS) {
      const previous = virtualLatest.get(bookId) as OctoberRun & {
        result: {
          state: {
            pendingTargets?: Record<string, unknown>;
            pendingExits?: Record<string, unknown>;
          };
        };
      };
      const state = previous.result.state;
      for (const symbol of new Set([
        ...Object.keys(state.pendingTargets ?? {}),
        ...Object.keys(state.pendingExits ?? {}),
      ])) {
        const row = session.rows.find((r) => r.symbol === symbol);
        if (!row || !(Number(row.open) > 0) || !(Number(row.close) > 0))
          throw new Error(`Pending US Shadow security lacks current prices: ${symbol}`);
      }
    }
    await recordOctoberPublication(virtual, publication);
    const prepared = await virtual.readPrepared("US", analysis.date);
    if (!prepared) throw new Error("US dry-run did not prepare a complete publication");
    // A reused saved run does not call append; advance virtual latest explicitly.
    for (const entry of prepared.entries) {
      virtualLatest.set(entry.series.bookId, entry.run);
      virtualSessions.set(`${entry.series.bookId}:${analysis.date}`, entry.run);
    }
    publications.push(publication);
    planned.push(prepared);
    rank = analysis.state;
  }
  return {
    publications,
    prepared: planned,
    analyses: publications.map((p) => p.analysis),
    runtimeCodeHash: manifest.codeHash,
  };
}

export async function commitUsShadowReplay(
  store: OctoberShadowStore,
  plan: Awaited<ReturnType<typeof planUsShadowReplay>>,
) {
  const results = [];
  for (const [index, publication] of plan.publications.entries()) {
    const saved = await store.prepare(plan.prepared[index]!);
    if (canonicalSeriesJson(saved) !== canonicalSeriesJson(plan.prepared[index]))
      throw new Error("Prepared US recovery changed after preflight");
    results.push(await recordOctoberPublication(store, publication));
  }
  return results;
}
