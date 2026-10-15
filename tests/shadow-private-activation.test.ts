import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createShadowRevisionFixture,
  SHADOW_TEST_UID,
  SHADOW_TEST_REVISION_ROOT,
  SHADOW_TEST_COMPUTED_AT,
} from "./fixtures/kospiShadowRevision";
import {
  ACTIVATION_REF,
  ACTIVATION_WORKFLOW,
  TARGET_DATE,
  PREDECESSOR_DATE,
  KR_BOOKS,
  assertActivationEnvironment,
  validateActivationApproval,
  assertPinnedSources,
  boundedReplayClient,
  correctionApprovalPath,
  prepareCorrectionApproval,
  privateShadowStore,
  sourcePins,
  stagingStore,
  assertModelPins,
  type ActivationApproval,
} from "../scripts/activate-approved-shadow";
import { sha256, stableJson } from "../scripts/analysis-run-store";
import { hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { shadowObjectPath } from "../src/lib/kospiShadowStore";
import type { SourceRecord } from "../scripts/source-registry-store";
const H = (c: string) => `sha256:${c.repeat(64)}`;
const uid = SHADOW_TEST_UID;
function approved(): ActivationApproval {
  return {
    version: "shadow-private-activation-v1",
    status: "APPROVED",
    activationRef: ACTIVATION_REF,
    expectedMainSha: "a".repeat(40),
    expectedActivationSha: "b".repeat(40),
    asOf: TARGET_DATE,
    predecessorDate: PREDECESSOR_DATE,
    expectedOctoberRuntimeHash: H("a"),
    expectedIntegratedRuntimeHash: H("b"),
    diagnosticPredecessorHash: H("c"),
    diagnosticOriginalTargetHash: H("d"),
    expectedCorrectedSourceHash: H("e"),
    sources: [
      {
        id: "00000000-0000-0000-0000-000000000002",
        storage_bucket: "cloudtrend-data",
        storage_path: `${uid}/source/screening/00000000-0000-0000-0000-000000000002/synthetic.csv`,
        file_hash: H("1"),
        data_hash: H("2"),
        schema_hash: H("3"),
        min_date: "2026-10-12",
        max_date: TARGET_DATE,
        activated_at: "2026-10-15T00:00:00.000000Z",
        created_at: "2026-10-15T00:00:00.000000Z",
        timing_evidence: [
          {
            id: "00000000-0000-0000-0000-000000000002",
            min_date: "2026-10-12",
            max_date: TARGET_DATE,
            activated_at: "2026-10-15T00:00:00.000000Z",
            created_at: "2026-10-15T00:00:00.000000Z",
          },
        ],
      },
    ],
    modelSessions: KR_BOOKS.map((series_id) => ({
      series_id,
      session_date: PREDECESSOR_DATE,
      state_hash: H("4"),
    })),
  };
}
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW: ACTIVATION_WORKFLOW,
  GITHUB_REF: ACTIVATION_REF,
  GITHUB_REPOSITORY: "Jiwoon625/cloudtrend",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "b".repeat(40),
};
function source(): SourceRecord {
  return {
    ...approved().sources[0],
    user_id: uid,
    status: "active",
    source_type: "screening",
  } as SourceRecord;
}
describe("bounded private activation approval", () => {
  it("accepts exact independent private anchor schema", () =>
    expect(validateActivationApproval(approved())).toEqual(approved()));
  it.each(["workflow_dispatch", "pull_request", "issue_comment", "workflow_run"])(
    "never impersonates %s",
    (event) =>
      expect(() =>
        assertActivationEnvironment({ ...environment, GITHUB_EVENT_NAME: event }, approved()),
      ).toThrow(),
  );
  it("binds repository/ref/workflow/SHA and permits read-only retry inspection", () => {
    expect(() => assertActivationEnvironment(environment, approved())).not.toThrow();
    expect(() =>
      assertActivationEnvironment({ ...environment, GITHUB_RUN_ATTEMPT: "2" }, approved()),
    ).not.toThrow();
    for (const [key, value] of Object.entries({
      GITHUB_ACTIONS: "false",
      GITHUB_REPOSITORY: "someone/fork",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW: "KOSPI prospective Shadow",
      GITHUB_SHA: "c".repeat(40),
      GITHUB_RUN_ATTEMPT: "0",
    }))
      expect(() =>
        assertActivationEnvironment({ ...environment, [key]: value }, approved()),
      ).toThrow();
  });
  it("rejects expanded date, duplicate source, private approval extra key and mixed baseline", () => {
    expect(() => validateActivationApproval({ ...approved(), asOf: "2026-10-15" })).toThrow();
    expect(() =>
      validateActivationApproval({
        ...approved(),
        sources: [approved().sources[0], approved().sources[0]],
      }),
    ).toThrow();
    expect(() => validateActivationApproval({ ...approved(), force: true })).toThrow();
    expect(() =>
      validateActivationApproval({
        ...approved(),
        modelSessions: [
          ...approved().modelSessions,
          { ...approved().modelSessions[0], session_date: TARGET_DATE },
        ],
      }),
    ).toThrow();
  });
  it("requires every source pin, owner, type, state and exact storage path", () => {
    expect(sourcePins([source()])).toEqual(approved().sources);
    expect(() => assertPinnedSources([source()], approved(), uid)).not.toThrow();
    for (const patch of [
      { status: "archived" },
      { user_id: "00000000-0000-0000-0000-000000000003" },
      { data_hash: H("f") },
      { storage_path: `${uid}/kr.json` },
      { source_type: "backtest" },
    ])
      expect(() =>
        assertPinnedSources([{ ...source(), ...patch } as SourceRecord], approved(), uid),
      ).toThrow();
    expect(() => assertPinnedSources([], approved(), uid)).toThrow();
  });
});
describe("read-only KOSPI staging and independent hash algorithms", () => {
  it("derives canonical snapshot hashes only after independent diagnostic anchors", async () => {
    const f = await createShadowRevisionFixture();
    for (const key of [...f.data.keys()])
      if (key.startsWith(SHADOW_TEST_REVISION_ROOT)) f.data.delete(key);
    const before = f.bytes();
    const a = approved();
    a.diagnosticPredecessorHash = `sha256:${sha256(stableJson(f.predecessor))}`;
    a.diagnosticOriginalTargetHash = `sha256:${sha256(stableJson(f.original.latest))}`;
    a.expectedCorrectedSourceHash = f.corrected.sourceHash;
    const prepared = await prepareCorrectionApproval(
      f.store,
      uid,
      a,
      f.corrected,
      f.original.registry.config,
      SHADOW_TEST_COMPUTED_AT,
    );
    expect(f.bytes()).toBe(before);
    expect(prepared.staged.staged.size).toBeGreaterThan(0);
    expect(prepared.approval.expectedPredecessorHash).toBe(await hashSeriesValue(f.predecessor));
    expect(prepared.approval.expectedOriginalTargetHash).toBe(
      await hashSeriesValue(f.original.latest),
    );
    expect(Object.keys(prepared.approval)).toHaveLength(6);
    expect(prepared.approval).not.toHaveProperty("computedAt");
    const ordering = { a: 1, B: 2 };
    expect(await hashSeriesValue(ordering)).not.toBe(`sha256:${sha256(stableJson(ordering))}`);
  });
  it("rejects changed original, mismatched corrected source and invalid registry without writes", async () => {
    const f = await createShadowRevisionFixture();
    const before = f.bytes();
    const a = approved();
    a.diagnosticPredecessorHash = `sha256:${sha256(stableJson(f.predecessor))}`;
    a.diagnosticOriginalTargetHash = `sha256:${sha256(stableJson(f.original.latest))}`;
    a.expectedCorrectedSourceHash = f.corrected.sourceHash;
    await expect(
      prepareCorrectionApproval(
        f.store,
        uid,
        { ...a, diagnosticPredecessorHash: H("f") },
        f.corrected,
        f.original.registry.config,
        SHADOW_TEST_COMPUTED_AT,
      ),
    ).rejects.toThrow("DIAGNOSTIC_ANCHOR_CHANGED");
    await expect(
      prepareCorrectionApproval(
        f.store,
        uid,
        { ...a, expectedCorrectedSourceHash: H("f") },
        f.corrected,
        f.original.registry.config,
        SHADOW_TEST_COMPUTED_AT,
      ),
    ).rejects.toThrow("CORRECTED_SOURCE_CHANGED");
    expect(f.bytes()).toBe(before);
  });
  it("completed staging reuses its frozen computation time without mutations", async () => {
    const f = await createShadowRevisionFixture();
    const before = f.bytes();
    const a = approved();
    a.diagnosticPredecessorHash = `sha256:${sha256(stableJson(f.predecessor))}`;
    a.diagnosticOriginalTargetHash = `sha256:${sha256(stableJson(f.original.latest))}`;
    a.expectedCorrectedSourceHash = f.corrected.sourceHash;
    const prepared = await prepareCorrectionApproval(
      f.store,
      uid,
      a,
      f.corrected,
      f.original.registry.config,
      "2026-10-15T01:10:00Z",
    );
    expect(prepared.computedAt).toBe(SHADOW_TEST_COMPUTED_AT);
    expect(prepared.staged.staged.size).toBe(0);
    expect(f.bytes()).toBe(before);
  });
  it("read-through staged writes never reach the external writer", async () => {
    const read = vi.fn(async () => null),
      latestSessionDate = vi.fn(async () => null);
    const { store, staged } = stagingStore({ read, latestSessionDate });
    await store.putImmutable("p/sessions/2026-10-14.json", { n: 1 });
    expect(await store.read("p/sessions/2026-10-14.json")).toEqual({ n: 1 });
    expect(staged.size).toBe(1);
    expect(await store.latestSessionDate("p/sessions")).toBe(TARGET_DATE);
    await expect(store.putImmutable("p/sessions/2026-10-14.json", { n: 2 })).rejects.toThrow(
      "STAGED_COLLISION",
    );
  });
});
describe("write boundaries", () => {
  it("blocks all original writes and arbitrary correction names before accessing storage", async () => {
    const from = vi.fn();
    const store = privateShadowStore({ storage: { from } } as unknown as SupabaseClient, uid);
    await expect(
      store.putImmutable(shadowObjectPath(uid, "sessions/2026-10-14.json"), {}),
    ).rejects.toThrow("STORAGE_WRITE_SCOPE");
    await expect(store.putLatest(shadowObjectPath(uid, "latest.json"), {})).rejects.toThrow(
      "STORAGE_LATEST_SCOPE",
    );
    await expect(store.putImmutable(`${uid}/shadow/arbitrary.json`, {})).rejects.toThrow(
      "STORAGE_WRITE_SCOPE",
    );
    expect(from).not.toHaveBeenCalled();
    expect(correctionApprovalPath(uid)).toContain(
      "/correction-approvals/october14-retrospective-v1.json",
    );
  });
  it("permits only exact KR model date continuation and blocks integrated/US/reset RPC", () => {
    const rpc = vi.fn();
    const client = boundedReplayClient({ rpc } as unknown as SupabaseClient, uid);
    const args = {
      p_user_id: uid,
      p_series: { bookId: KR_BOOKS[0] },
      p_run: { bookId: KR_BOOKS[0], receipt: { date: TARGET_DATE } },
      p_previous_date: PREDECESSOR_DATE,
      p_previous_hash: H("4"),
    };
    client.rpc("ledger_append_model_session", args);
    expect(rpc).toHaveBeenCalledTimes(1);
    for (const patch of [
      { p_previous_date: null },
      { p_user_id: "other" },
      { p_series: { bookId: "integrated-allocation-shadow-2026-10-12-v1:O1" } },
      { p_run: { bookId: KR_BOOKS[0], receipt: { date: "2026-10-15" } } },
    ])
      expect(() => client.rpc("ledger_append_model_session", { ...args, ...patch })).toThrow();
    expect(() => client.rpc("ledger_append_own_october_model_session", args)).toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("allows bounded input artifact but rejects other dates and market", () => {
    const rpc = vi.fn();
    const client = boundedReplayClient({ rpc } as unknown as SupabaseClient, uid);
    const args = {
      p_user_id: uid,
      p_series: { bookId: KR_BOOKS[0] },
      p_run: {
        bookId: KR_BOOKS[0],
        publicationArtifact: {
          kind: "PREPARED_PUBLICATION",
          payload: { date: TARGET_DATE, market: "KR" },
        },
      },
      p_previous_date: null,
      p_previous_hash: null,
    };
    client.rpc("ledger_append_model_session", args);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(() =>
      client.rpc("ledger_append_model_session", {
        ...args,
        p_run: {
          ...args.p_run,
          publicationArtifact: {
            kind: "PREPARED_PUBLICATION",
            payload: { date: TARGET_DATE, market: "US" },
          },
        },
      }),
    ).toThrow();
  });
  it("blocks arbitrary audit/approval inserts and all direct table mutations", () => {
    const insert = vi.fn();
    const from = vi.fn(() => ({ insert, update: vi.fn(), delete: vi.fn(), upsert: vi.fn() }));
    const client = boundedReplayClient({ from } as unknown as SupabaseClient, uid);
    expect(() => client.from("ledger_model_series").insert({})).toThrow();
    expect(() => client.from("shadow_replay_audit").update({})).toThrow();
    const row = {
      user_id: uid,
      market: "KR",
      signal_date: TARGET_DATE,
      strategy_version: "adopted-shadow-2026-10-12-v1",
      details: {},
    };
    client.from("shadow_replay_audit").insert(row);
    expect(insert).toHaveBeenCalledTimes(1);
    for (const details of [
      { shadowActivation: {} },
      { krSourceVintageApproval: {} },
      { krSourceVintageReview: {} },
    ])
      expect(() => client.from("shadow_replay_audit").insert({ ...row, details })).toThrow();
  });
  it("blocks changed protected model hashes and missing heads", async () => {
    await expect(
      assertModelPins({ registries: [], sessions: [] }, approved(), false),
    ).rejects.toThrow("MODEL_COUNT_CHANGED");
  });
});

import {
  stagedReplayClient,
  assertReplayResult,
  normalizedTimestamp,
} from "../scripts/activate-approved-shadow";
import { replayKrShadow, sliceKrDatasetForReplay } from "../src/lib/shadowReplay.server";
import { freezeRestartSeries, ADOPTED_SERIES_KINDS } from "../src/lib/ledger/modelSeries";
import { ADOPTED_SHADOW_FROZEN_CODE_HASH } from "../src/lib/ledger/octoberShadowRuntime";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
function emptyReadonlyClient() {
  const forbidden = vi.fn(() => {
    throw new Error("EXTERNAL_WRITE");
  });
  const from = () => {
    let single = false;
    const query = {
      select: () => query,
      eq: () => query,
      contains: () => query,
      order: () => query,
      limit: () => query,
      range: () => query,
      maybeSingle: () => {
        single = true;
        return query;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(resolve({ data: single ? null : [], count: 0, error: null })),
      insert: forbidden,
      update: forbidden,
      delete: forbidden,
    };
    return query;
  };
  return {
    client: {
      from,
      rpc: forbidden,
      storage: {
        from: () => ({
          download: async () => ({
            data: null,
            error: { statusCode: "404", message: "Object not found" },
          }),
          upload: forbidden,
        }),
      },
    } as unknown as SupabaseClient,
    forbidden,
  };
}
async function syntheticKrSeed() {
  const external = emptyReadonlyClient(),
    seed = stagedReplayClient(external.client, uid);
  for (const kind of ADOPTED_SERIES_KINDS.filter((kind) => !kind.startsWith("US_"))) {
    const series = await freezeRestartSeries({
      kind,
      frozenAt: "2026-10-09T00:00:00Z",
      codeHash: ADOPTED_SHADOW_FROZEN_CODE_HASH,
      sourceHash: H("b"),
    });
    const rows = seed.tables.get("ledger_model_series") ?? [];
    rows.push({ user_id: uid, series_id: series.bookId, payload: series });
    seed.tables.set("ledger_model_series", rows);
  }
  const dates: string[] = [];
  for (let at = Date.parse("2026-10-02T00:00:00Z"); dates.length < 130; at -= 86400000) {
    const d = new Date(at);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.unshift(d.toISOString().slice(0, 10));
  }
  dates.push("2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14");
  const instruments = [
    { symbol: "000001", market: "KOSPI", type: "STOCK" },
    { symbol: "000002", market: "KOSDAQ", type: "STOCK" },
    { symbol: "069500", market: "ETF", type: "ETF" },
    { symbol: "KOSPI", market: "INDEX", type: "INDEX" },
  ];
  const dataset = parseManualMarketData(
    JSON.stringify(
      dates.flatMap((date) =>
        instruments.map((i) => ({
          ...i,
          name: `Synthetic ${i.symbol}`,
          date,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 100000,
          tradingValue: 10000000,
          marketCap: 100000000000,
          foreignNetBuyValue: 0,
          institutionNetBuyValue: 0,
          etfUnderlyingIndexClose: 100,
          etfMarketCap: 100000000000,
          etfTradingValue: 10000000,
          priceSource: "TOSS_ADJUSTED_CANDLE",
          marketCapSource: "KRX_ETF",
          tradingValueSource: "KRX_ETF",
        })),
      ),
    ),
  ).dataset;
  const prior = await replayKrShadow({
    client: seed.client,
    userId: uid,
    dataset: sliceKrDatasetForReplay(dataset, PREDECESSOR_DATE),
    config: DEFAULT_SCORING_CONFIG,
    sources: [],
    calculatedAt: "2026-10-15T00:10:00Z",
    mode: "service",
  });
  expect(prior.deferred).toBeNull();
  expect(prior.processed).toHaveLength(2);
  return { ...external, seed, dataset };
}
describe("production replay contract preflight", () => {
  it("normalizes SQL/API timestamp spellings without losing millisecond distinction", () => {
    expect(normalizedTimestamp("2026-10-14 15:03:09.077298+00")).toBe(
      normalizedTimestamp("2026-10-14T15:03:09.077298+00:00"),
    );
    expect(normalizedTimestamp("2026-10-14T15:03:09.078Z")).not.toBe(
      normalizedTimestamp("2026-10-14T15:03:09.077Z"),
    );
  });
  it("uses actual five-book replay, archive RPCs and provenance, without external mutation", async () => {
    const f = await syntheticKrSeed();
    const baseline = JSON.stringify([...f.seed.tables]);
    const preview = stagedReplayClient(f.seed.client, uid);
    const result = await replayKrShadow({
      client: boundedReplayClient(preview.client, uid),
      userId: uid,
      dataset: f.dataset,
      config: DEFAULT_SCORING_CONFIG,
      sources: [],
      calculatedAt: "2026-10-15T00:10:00Z",
      mode: "service",
    });
    expect(result.deferred).toBeNull();
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.records).toHaveLength(5);
    expect(preview.tables.get("ledger_model_sessions")).toHaveLength(5);
    expect(preview.tables.get("ledger_provenance_archive")?.length).toBeGreaterThan(0);
    expect(JSON.stringify([...f.seed.tables])).toBe(baseline);
    expect(f.forbidden).not.toHaveBeenCalled();
    // Missing integrated heads are a failed activation gate, not a successful partial claim.
    expect(() => assertReplayResult(result)).toThrow("KR_RESUME_INCOMPLETE");
  });
  it("discovers target evidence collision in staged replay before any live marker/write", async () => {
    const f = await syntheticKrSeed();
    const payload = { unexpected: true };
    const path = `${uid}/staging/integrated-allocation-inputs/v1/KR/${TARGET_DATE}.json`;
    f.seed.objects.set(
      path,
      new Blob([JSON.stringify({ hash: await hashSeriesValue(payload), payload })]),
    );
    const preview = stagedReplayClient(f.seed.client, uid);
    const result = await replayKrShadow({
      client: boundedReplayClient(preview.client, uid),
      userId: uid,
      dataset: f.dataset,
      config: DEFAULT_SCORING_CONFIG,
      sources: [],
      calculatedAt: "2026-10-15T00:10:00Z",
      mode: "service",
    });
    expect(result.deferred).not.toBeNull();
    expect(preview.tables.get("ledger_model_sessions") ?? []).toHaveLength(0);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(() => assertReplayResult(result)).toThrow();
  });
});

describe("staged read/write parity regressions", () => {
  it("projects staged additions exactly as PostgREST selects columns", async () => {
    const external = emptyReadonlyClient(),
      stage = stagedReplayClient(external.client, uid);
    stage.tables.set("ledger_model_sessions", [
      {
        user_id: uid,
        series_id: "test",
        session_date: TARGET_DATE,
        state_hash: H("a"),
        payload: { value: 1 },
      },
    ]);
    const result = await stage.client
      .from("ledger_model_sessions")
      .select("series_id,session_date,state_hash,payload", { count: "exact" })
      .eq("user_id", uid);
    expect(result.data).toEqual([
      { series_id: "test", session_date: TARGET_DATE, state_hash: H("a"), payload: { value: 1 } },
    ]);
    expect(result.count).toBe(1);
    expect(external.forbidden).not.toHaveBeenCalled();
  });
  it("detects immutable remote collisions instead of hiding remote bytes", async () => {
    const external = emptyReadonlyClient(),
      seed = stagedReplayClient(external.client, uid);
    seed.objects.set("existing", new Blob(['{"x":1}']));
    const stage = stagedReplayClient(seed.client, uid);
    await expect(
      stage.client.storage.from("cloudtrend-data").upload("existing", '{"x":2}', { upsert: false }),
    ).rejects.toThrow("STAGED_STORAGE_COLLISION");
    expect(stage.objects.size).toBe(0);
    expect(await seed.objects.get("existing")!.text()).toBe('{"x":1}');
    expect(external.forbidden).not.toHaveBeenCalled();
  });
  it("preserves sub-millisecond source ordering", () => {
    expect(normalizedTimestamp("2026-10-14 15:03:09.077298+00")).not.toBe(
      normalizedTimestamp("2026-10-14T15:03:09.077299+00:00"),
    );
    expect(normalizedTimestamp("2026-10-15T09:00:00+09:00")).toBe("2026-10-15T00:00:00.000000Z");
  });
  it("binds physical timestamp spellings and compacted logical timing", () => {
    const row = source();
    const sql = {
      ...row,
      activated_at: "2026-10-15 00:00:00+00",
      created_at: "2026-10-15 00:00:00+00",
    };
    expect(sourcePins([sql])).toEqual(sourcePins([row]));
    const altered = {
      ...row,
      validation_result: {
        screeningCompaction: {
          original_source_evidence: [
            {
              id: "synthetic-origin",
              min_date: "2026-10-12",
              max_date: TARGET_DATE,
              activated_at: "2026-10-15T01:00:00Z",
              created_at: "2026-10-15T01:00:00Z",
            },
          ],
        },
      },
    };
    expect(() => assertPinnedSources([altered], approved(), uid)).toThrow("SOURCE_SET_CHANGED");
    expect(() =>
      validateActivationApproval({ ...approved(), sources: sourcePins([row]) }),
    ).not.toThrow();
  });
  it("blocks future and malformed revision dates before any storage call", async () => {
    const from = vi.fn(),
      store = privateShadowStore({ storage: { from } } as unknown as SupabaseClient, uid);
    await expect(
      store.putImmutable(`${SHADOW_TEST_REVISION_ROOT}/sessions/2026-10-15.json`, {}),
    ).rejects.toThrow();
    await expect(
      store.putImmutable(`${SHADOW_TEST_REVISION_ROOT}/sessions/2026-02-31.json`, {}),
    ).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });
});
