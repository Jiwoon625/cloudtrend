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
  type ExecutionAmendment,
  EXECUTION_AMENDMENT_VERSION,
  validateExecutionAmendment,
  assertExecutionBinding,
  assertRuntimeApproval,
  assertPreCutoverPolicy,
  assertNoPreCutoverKrTrades,
  assertParityEvidence,
  PARITY_EVIDENCE_PATH,
  originalApprovalRowsHash,
  verifyGitBoundary,
  AMENDED_ACTIVATION_FILES,
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
function amended(): ExecutionAmendment {
  return {
    version: EXECUTION_AMENDMENT_VERSION,
    status: "APPROVED",
    activationRef: ACTIVATION_REF,
    asOf: TARGET_DATE,
    expectedMainSha: "e".repeat(40),
    originalActivationSha: "b".repeat(40),
    expectedCleanupSha: "c".repeat(40),
    expectedExecutionSha: "d".repeat(40),
    originalApprovalHash: H("1"),
    originalApprovalRowsHash: H("2"),
    expectedKospiRuntimeHash: H("3"),
    expectedOctoberRuntimeHash: H("5"),
    expectedIntegratedRuntimeHash: H("6"),
    parityEvidenceHash: H("7"),
  };
}
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW: ACTIVATION_WORKFLOW,
  GITHUB_REF: ACTIVATION_REF,
  GITHUB_REPOSITORY: "Jiwoon625/cloudtrend",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "d".repeat(40),
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
        assertActivationEnvironment(
          { ...environment, GITHUB_EVENT_NAME: event },
          approved(),
          amended(),
        ),
      ).toThrow(),
  );
  it("binds repository/ref/workflow/SHA and permits read-only retry inspection", () => {
    expect(() => assertActivationEnvironment(environment, approved(), amended())).not.toThrow();
    expect(() =>
      assertActivationEnvironment(
        { ...environment, GITHUB_RUN_ATTEMPT: "2" },
        approved(),
        amended(),
      ),
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
        assertActivationEnvironment({ ...environment, [key]: value }, approved(), amended()),
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

describe("explicit execution and guard amendment", () => {
  it("admits exact reviewed current runtimes without rewriting historical approvals", () => {
    const original = approved(),
      amendment = amended();
    const before = structuredClone(original);
    const runtime = {
      octoberRuntimeCodeHash: amendment.expectedOctoberRuntimeHash,
      integratedRuntimeCodeHash: amendment.expectedIntegratedRuntimeHash,
    };
    expect(runtime.octoberRuntimeCodeHash).not.toBe(original.expectedOctoberRuntimeHash);
    expect(() =>
      assertRuntimeApproval(
        runtime,
        { kospiRuntimeCodeHash: amendment.expectedKospiRuntimeHash },
        amendment,
      ),
    ).not.toThrow();
    expect(original).toEqual(before);
    expect(() =>
      assertRuntimeApproval(runtime, { kospiRuntimeCodeHash: H("9") }, amendment),
    ).toThrow();
    expect(() =>
      assertRuntimeApproval(
        { ...runtime, octoberRuntimeCodeHash: original.expectedOctoberRuntimeHash },
        { kospiRuntimeCodeHash: amendment.expectedKospiRuntimeHash },
        amendment,
      ),
    ).toThrow();
    expect(() =>
      assertRuntimeApproval(
        { ...runtime, integratedRuntimeCodeHash: original.expectedIntegratedRuntimeHash },
        { kospiRuntimeCodeHash: amendment.expectedKospiRuntimeHash },
        amendment,
      ),
    ).toThrow();
    expect(() =>
      validateExecutionAmendment({ ...amendment, expectedKospiRuntimeHash: "" }),
    ).toThrow();
  });
  it("enforces the reviewed empty KR prefix without asserting ETF positions are empty", () => {
    const sessions = KR_BOOKS.flatMap((series_id) =>
      ["2026-10-12", PREDECESSOR_DATE].map((session_date) => ({
        series_id,
        session_date,
        state_hash: H("1"),
        payload: {
          result: { trades: series_id.endsWith(":ETF_V02") ? [{ synthetic: true }] : [] },
        },
      })),
    ) as unknown as Parameters<typeof assertNoPreCutoverKrTrades>[0]["sessions"];
    const baseline = structuredClone(sessions);
    expect(() => assertNoPreCutoverKrTrades({ sessions })).not.toThrow();
    expect(sessions).toEqual(baseline);
    const kr = sessions.find(
      (row) => row.series_id.endsWith(":KR_KOSPI") && row.session_date === PREDECESSOR_DATE,
    )!;
    (kr.payload.result as unknown as { trades: unknown[] }).trades.push({ synthetic: true });
    expect(() => assertNoPreCutoverKrTrades({ sessions })).toThrow(
      "KR_PRE_CUTOVER_TRADES_REQUIRE_REVIEW",
    );
    expect(() =>
      assertNoPreCutoverKrTrades({
        sessions: baseline.filter(
          (row) => !(row.series_id.endsWith(":KR_KOSPI") && row.session_date === PREDECESSOR_DATE),
        ),
      }),
    ).toThrow();
    expect(() =>
      assertNoPreCutoverKrTrades({
        sessions: [...baseline, baseline.find((row) => row.series_id.endsWith(":KR_KOSPI"))!],
      }),
    ).toThrow();
    const malformed = structuredClone(baseline);
    const invalid = malformed.find((row) => row.series_id.endsWith(":KR_KOSPI"))!;
    (invalid.payload as unknown as { result: unknown }).result = { trades: null };
    expect(() => assertNoPreCutoverKrTrades({ sessions: malformed })).toThrow(
      "KR_PRE_CUTOVER_TRADES_REQUIRE_REVIEW",
    );
  });
  it("requires the reviewed prospective policy cutover strictly after the approved target date", () => {
    expect(() => assertPreCutoverPolicy()).not.toThrow();
    expect(() =>
      assertPreCutoverPolicy({
        version: "holding-price-exit-k4-e4-v1",
        effectiveDate: TARGET_DATE,
      }),
    ).toThrow();
    expect(() =>
      assertPreCutoverPolicy({ version: "other", effectiveDate: "2026-10-15" }),
    ).toThrow();
  });
  it("binds exact reviewed committed parity-test bytes and runs that test in activation CI", async () => {
    const fs = await import("node:fs/promises"),
      os = await import("node:os"),
      path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-parity-evidence-"));
    try {
      await fs.mkdir(path.join(root, "tests"));
      const bytes = "synthetic old-versus-current target14 parity evidence\n";
      await fs.writeFile(path.join(root, PARITY_EVIDENCE_PATH), bytes);
      const amendment = { ...amended(), parityEvidenceHash: `sha256:${sha256(bytes)}` };
      await expect(assertParityEvidence(amendment, root)).resolves.toBeUndefined();
      await fs.writeFile(path.join(root, PARITY_EVIDENCE_PATH), bytes + "changed");
      await expect(assertParityEvidence(amendment, root)).rejects.toThrow();
      const workflow = await fs.readFile(".github/workflows/shadow-private-activation.yml", "utf8");
      expect(workflow).toContain(`tests/shadow-private-activation.test.ts ${PARITY_EVIDENCE_PATH}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("requires an exact bounded amendment separate from immutable original approval", async () => {
    const original = approved();
    const amendment = { ...amended(), originalApprovalHash: await hashSeriesValue(original) };
    expect(validateExecutionAmendment(amendment)).toEqual(amendment);
    await expect(assertExecutionBinding(original, amendment)).resolves.toBeUndefined();
    await expect(
      assertExecutionBinding(original, { ...amendment, expectedMainSha: original.expectedMainSha }),
    ).rejects.toThrow();
    await expect(
      assertExecutionBinding({ ...original, expectedCorrectedSourceHash: H("9") }, amendment),
    ).rejects.toThrow();
    expect(() => validateExecutionAmendment({ ...amendment, sourceOverride: [] })).toThrow();
    expect(() =>
      validateExecutionAmendment({
        ...amendment,
        expectedExecutionSha: amendment.originalActivationSha,
      }),
    ).toThrow();
    expect(() => assertActivationEnvironment(environment, original)).toThrow();
    expect(() =>
      assertActivationEnvironment(
        { ...environment, GITHUB_SHA: original.expectedActivationSha },
        original,
        amendment,
      ),
    ).toThrow();
  });
  it("pins both original approval row bodies independent of database order", async () => {
    const registry = {
      details: { krSourceVintageApproval: { value: 1 }, shadowActivation: approved() },
      signal_date: TARGET_DATE,
      status: "RECORDED",
      replay_mode: "RETROSPECTIVE",
    };
    const receipt = {
      ...registry,
      details: { krSourceVintageReview: { value: 2 }, shadowActivation: approved() },
    };
    const before = await originalApprovalRowsHash([registry, receipt]);
    expect(await originalApprovalRowsHash([receipt, registry])).toBe(before);
    expect(
      await originalApprovalRowsHash([
        registry,
        { ...receipt, details: { ...receipt.details, krSourceVintageReview: { value: 3 } } },
      ]),
    ).not.toBe(before);
  });
});

describe("real production launcher subprocess", () => {
  it("uses the tested exact Node entrypoint and labels the native KOSPI-only check truthfully", async () => {
    const fs = await import("node:fs/promises");
    const workflow = await fs.readFile(".github/workflows/shadow-private-activation.yml", "utf8");
    expect(workflow).toMatch(/run: node scripts\/run-approved-shadow-activation\.mjs\s*$/);
    expect(workflow).toContain("node scripts/run-approved-shadow-activation.mjs --verify-runtime");
    expect(workflow).toContain("native KOSPI closure");
    expect(workflow).not.toContain("npx vite-node");
  });
  it("keeps the production activation-script byte pin exact", async () => {
    const fs = await import("node:fs/promises"),
      { createHash } = await import("node:crypto");
    const text = await fs.readFile("scripts/run-approved-shadow-activation.mjs", "utf8");
    const match = text.match(/const PINNED_ACTIVATION_SCRIPT_SHA256 =\s*"([a-f0-9]{64})";/);
    expect(match).not.toBeNull();
    expect(
      createHash("sha256")
        .update(await fs.readFile("scripts/activate-approved-shadow.ts"))
        .digest("hex"),
    ).toBe(match?.[1]);
  });
  async function launcher(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
    const { spawnSync } = await import("node:child_process");
    return spawnSync(process.execPath, ["scripts/run-approved-shadow-activation.mjs", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env["PATH"], ...env },
    });
  }
  async function copyPublicFixture(root: string) {
    const fs = await import("node:fs/promises"),
      path = await import("node:path");
    for (const directory of ["src", "scripts"])
      await fs.cp(directory, path.join(root, directory), { recursive: true });
    for (const file of ["package.json", "tsconfig.json"])
      await fs.copyFile(file, path.join(root, file));
    await fs.symlink(await fs.realpath("node_modules"), path.join(root, "node_modules"));
  }
  it("stops at the native public boundary before verifier or project imports without authentic binding", async () => {
    const result = await launcher(process.cwd());
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"stage":"PUBLIC_BOUNDARY_START"');
    expect(result.stdout).not.toContain('"stage":"KOSPI_NATIVE_VERIFIED"');
    expect(result.stderr).toContain('"status":"STOPPED"');
    expect(result.stderr).toContain('"stage":"LAUNCHER"');
    expect(result.stdout).not.toContain('"stage":"PREFLIGHT_START"');
    expect(result.stdout).not.toContain('"stage":"CLI_COMPLETE"');
  }, 30_000);
  it("checks the actual KOSPI publication closure natively without claiming all three runtime checks", async () => {
    const result = await launcher(process.cwd(), ["--verify-runtime"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"stage":"KOSPI_NATIVE_VERIFIED"');
    expect(result.stdout).not.toContain('"stage":"RUNTIME_VERIFIED"');
    expect(result.stdout).not.toContain('"stage":"PREFLIGHT_START"');
  }, 30_000);
  it("rejects actual runtime/config mutations before either sentinel evaluates in both modes", async () => {
    const fs = await import("node:fs/promises"),
      os = await import("node:os"),
      path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-native-sentinel-"));
    try {
      await copyPublicFixture(root);
      const sentinel = path.join(root, "EVALUATED");
      for (const file of [
        "src/lib/kospiShadowSeries.ts",
        "scripts/kospi-shadow-runtime.config.ts",
      ]) {
        const target = path.join(root, file),
          original = await fs.readFile(target, "utf8");
        await fs.writeFile(
          target,
          `import { writeFileSync as injectedWrite } from 'node:fs'; injectedWrite(${JSON.stringify(sentinel)}, 'must not execute');\n${original}`,
        );
        for (const args of [[], ["--verify-runtime"]]) {
          const result = await launcher(root, args, {
            SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-secret",
          });
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('"status":"STOPPED"');
          expect(result.stdout).not.toContain('"stage":"KOSPI_NATIVE_VERIFIED"');
          expect(result.stdout).not.toContain('"stage":"PREFLIGHT_START"');
          await expect(fs.stat(sentinel)).rejects.toThrow();
        }
        await fs.writeFile(target, original);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
  it("pins all core files and the activation module before evaluation, then awaits only structured success", async () => {
    const fs = await import("node:fs/promises"),
      os = await import("node:os"),
      path = await import("node:path"),
      { execFileSync } = await import("node:child_process"),
      { createHash } = await import("node:crypto");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-native-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      await copyPublicFixture(root);
      const originalLauncher = await fs.readFile(
        path.join(root, "scripts/run-approved-shadow-activation.mjs"),
        "utf8",
      );
      await fs.rm(path.join(root, "scripts/activate-approved-shadow.ts"));
      await fs.rm(path.join(root, "scripts/run-approved-shadow-activation.mjs"));
      await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
      git("init", "-b", "main");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Synthetic Test");
      git("add", ".");
      git("commit", "-m", "reviewed synthetic main");
      const main = git("rev-parse", "HEAD");
      git("remote", "add", "origin", root);
      git("checkout", "-b", "activation");
      const synthetic = `export async function runApprovedShadowActivationCli() { await new Promise(resolve => setTimeout(resolve, 100)); console.log('SYNTHETIC_AWAIT_FINISHED'); return {status:'VERIFIED',date:'2026-10-14',krBooks:5,kospiRetrospective:true,originalsPreserved:true,capitalReset:false,sourceCollection:false}; }`;
      const writeBoundLauncher = async (body: string) => {
        await fs.writeFile(path.join(root, "scripts/activate-approved-shadow.ts"), body);
        const hash = createHash("sha256").update(body).digest("hex");
        // Explicit test-only public pins. The production placeholder stays fail-closed until real review.
        await fs.writeFile(
          path.join(root, "scripts/run-approved-shadow-activation.mjs"),
          originalLauncher
            .replace(
              /const PINNED_REVIEWED_MAIN_SHA =\s*"[^"]+";/,
              `const PINNED_REVIEWED_MAIN_SHA = "${main}";`,
            )
            .replace(
              /const PINNED_ACTIVATION_SCRIPT_SHA256 =\s*"[^"]+";/,
              `const PINNED_ACTIVATION_SCRIPT_SHA256 = "${hash}";`,
            ),
        );
      };
      await writeBoundLauncher(synthetic);
      for (const file of [
        ".github/workflows/shadow-private-activation.yml",
        "tests/shadow-private-activation.test.ts",
      ]) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), "synthetic\n");
      }
      git("add", ".");
      git("commit", "-m", "reviewed synthetic activation");
      const execution = git("rev-parse", "HEAD");
      const event = {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "Jiwoon625/cloudtrend",
        GITHUB_REF: ACTIVATION_REF,
        GITHUB_SHA: execution,
      };
      const success = await launcher(root, [], event);
      expect(success.status, success.stderr).toBe(0);
      expect(success.stdout).toContain('"stage":"PUBLIC_BOUNDARY_VERIFIED"');
      expect(success.stdout.indexOf("SYNTHETIC_AWAIT_FINISHED")).toBeGreaterThanOrEqual(0);
      expect(success.stdout.indexOf('"stage":"CLI_COMPLETE"')).toBeGreaterThan(
        success.stdout.indexOf("SYNTHETIC_AWAIT_FINISHED"),
      );
      const sentinel = path.join(root, "EVALUATED");
      // This extra activation import is deliberately outside the KOSPI closure. The public tree fence must reject it.
      await fs.writeFile(
        path.join(root, "src/lib/activation-extra.ts"),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'must not execute');`,
      );
      await writeBoundLauncher(`import '../src/lib/activation-extra';\n${synthetic}`);
      git("add", ".");
      git("commit", "-m", "unreviewed extra app module");
      const extra = await launcher(root, [], { ...event, GITHUB_SHA: git("rev-parse", "HEAD") });
      expect(extra.status).toBe(1);
      expect(extra.stdout).not.toContain('"stage":"PUBLIC_BOUNDARY_VERIFIED"');
      await expect(fs.stat(sentinel)).rejects.toThrow();
      git("reset", "--hard", execution);
      // Even an allowlisted activation filename must match the separately pinned exact bytes.
      await fs.writeFile(
        path.join(root, "scripts/activate-approved-shadow.ts"),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'must not execute');\n${synthetic}`,
      );
      git("add", ".");
      git("commit", "-m", "wrong activation bytes");
      const changedScript = await launcher(root, [], {
        ...event,
        GITHUB_SHA: git("rev-parse", "HEAD"),
      });
      expect(changedScript.status).toBe(1);
      await expect(fs.stat(sentinel)).rejects.toThrow();
      git("reset", "--hard", execution);
      await fs.writeFile(path.join(root, ".git/activation-target.ts"), synthetic);
      await fs.rm(path.join(root, "scripts/activate-approved-shadow.ts"));
      await fs.symlink(
        "../.git/activation-target.ts",
        path.join(root, "scripts/activate-approved-shadow.ts"),
      );
      git("add", ".");
      git("commit", "-m", "symlink with matching followed bytes");
      const symlink = await launcher(root, [], { ...event, GITHUB_SHA: git("rev-parse", "HEAD") });
      expect(symlink.status).toBe(1);
      expect(symlink.stdout).not.toContain('"stage":"PUBLIC_BOUNDARY_VERIFIED"');
      expect(symlink.stdout).not.toContain("SYNTHETIC_AWAIT_FINISHED");
      git("reset", "--hard", execution);
      await writeBoundLauncher(
        `export async function runApprovedShadowActivationCli() { return undefined; }`,
      );
      git("add", ".");
      git("commit", "-m", "reviewed synthetic no-op");
      const noop = await launcher(root, [], { ...event, GITHUB_SHA: git("rev-parse", "HEAD") });
      expect(noop.status).toBe(1);
      expect(noop.stderr).toContain('"status":"STOPPED"');
      expect(noop.stdout).not.toContain('"stage":"CLI_COMPLETE"');
      git("reset", "--hard", execution);
      git("branch", "-f", "main", execution);
      const mainMoved = await launcher(root, [], event);
      expect(mainMoved.status).toBe(1);
      expect(mainMoved.stdout).not.toContain('"stage":"PUBLIC_BOUNDARY_VERIFIED"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
  it("passes no inherited credentials or loader options to native verification and rejects a no-op verifier", async () => {
    const fs = await import("node:fs/promises"),
      os = await import("node:os"),
      path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-native-env-"));
    try {
      await fs.mkdir(path.join(root, "scripts"));
      await fs.copyFile(
        "scripts/run-approved-shadow-activation.mjs",
        path.join(root, "scripts/run-approved-shadow-activation.mjs"),
      );
      await fs.writeFile(
        path.join(root, "scripts/verify-kospi-shadow-runtime.ts"),
        `if (Object.keys(process.env).some(key => key !== 'PATH')) throw new Error('unexpected environment'); console.log(JSON.stringify({stage:'KOSPI_RUNTIME_VERIFIED'}));`,
      );
      const clean = await launcher(root, ["--verify-runtime"], {
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-secret",
        GITHUB_TOKEN: "synthetic-not-a-token",
        NODE_OPTIONS: "--no-warnings",
      });
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('"stage":"KOSPI_NATIVE_VERIFIED"');
      await fs.writeFile(
        path.join(root, "scripts/verify-kospi-shadow-runtime.ts"),
        "// Deliberately no-op synthetic verifier\n",
      );
      const noop = await launcher(root, ["--verify-runtime"]);
      expect(noop.status).toBe(1);
      expect(noop.stdout).not.toContain('"stage":"KOSPI_NATIVE_VERIFIED"');
      await fs.rm(path.join(root, "scripts/verify-kospi-shadow-runtime.ts"));
      const missing = await launcher(root, ["--verify-runtime"]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('"status":"STOPPED"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("actual amendment Git lineage guard", () => {
  it("accepts reviewed new-main guard overlay and rejects core differences, wrong main/SHA/cleanup, dirty tree, and advanced main", async () => {
    const fs = await import("node:fs/promises"),
      os = await import("node:os"),
      path = await import("node:path"),
      { execFileSync } = await import("node:child_process");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-lineage-test-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const originalEnv = process.env["GITHUB_SHA"];
    try {
      git("init", "-b", "main");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Synthetic Test");
      await fs.writeFile(path.join(root, "README"), "synthetic\n");
      git("add", ".");
      git("commit", "-m", "main");
      const main = git("rev-parse", "HEAD");
      git("remote", "add", "origin", root);
      git("checkout", "-b", "activation");
      for (const file of AMENDED_ACTIVATION_FILES.slice(0, 3)) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), "synthetic original\n");
      }
      git("add", ".");
      git("commit", "-m", "original");
      const original = git("rev-parse", "HEAD");
      const disabledWorkflow =
        "name: Approved private Shadow activation\n# One-time push activation disabled after the first invocation was found not to execute.\non:\n  workflow_dispatch:\npermissions:\n  contents: read\nconcurrency:\n  group: approved-private-shadow-activation-20261014\n  cancel-in-progress: false\njobs:\n  activate:\n    if: github.repository == 'Jiwoon625/cloudtrend' && github.ref == 'refs/heads/fix/shadow-private-activation-20261015' && github.event_name == 'push' && github.event.forced == false && github.event.deleted == false\n    runs-on: ubuntu-latest\n    timeout-minutes: 45\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.sha }}\n          fetch-depth: 0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - run: npm ci\n      - name: Verify bounded activation and reviewed runtime\n        run: |\n          node --input-type=module <<'NODE'\n          import ts from 'typescript';\n          const root = process.cwd();\n          const loaded = ts.readConfigFile('tsconfig.json', ts.sys.readFile);\n          const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);\n          const files = ['scripts/activate-approved-shadow.ts', 'tests/shadow-private-activation.test.ts'];\n          const program = ts.createProgram(files, parsed.options);\n          const diagnostics = ts.getPreEmitDiagnostics(program);\n          if (diagnostics.length) {\n            console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: p => p, getNewLine: () => '\\n' }));\n            process.exit(1);\n          }\n          NODE\n          npx vitest run --config vitest.shadow.config.ts tests/shadow-private-activation.test.ts\n          npx vite-node --config scripts/kospi-shadow-runtime.config.ts scripts/verify-shadow-runtime-manifests.ts\n      - name: Apply exact private approval once and verify\n        env:\n          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}\n          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}\n          SUPABASE_USER_ID: ${{ secrets.SUPABASE_USER_ID }}\n        run: npx vite-node --config scripts/kospi-shadow-runtime.config.ts scripts/activate-approved-shadow.ts\n";
      await fs.writeFile(
        path.join(root, ".github/workflows/shadow-private-activation.yml"),
        disabledWorkflow,
      );
      git("add", ".");
      git("commit", "-m", "cleanup");
      const cleanup = git("rev-parse", "HEAD");
      git("checkout", "main");
      await fs.writeFile(path.join(root, "publication-guard.ts"), "reviewed guard upgrade\n");
      git("add", ".");
      git("commit", "-m", "reviewed generic guard");
      const reviewedMain = git("rev-parse", "HEAD");
      git("checkout", "activation");
      git("checkout", reviewedMain, "--", "publication-guard.ts");
      for (const file of AMENDED_ACTIVATION_FILES)
        await fs.writeFile(path.join(root, file), "synthetic amended\n");
      git("add", ".");
      git("commit", "-m", "amended");
      const execution = git("rev-parse", "HEAD");
      const approval = { ...approved(), expectedMainSha: main, expectedActivationSha: original };
      const amendment = {
        ...amended(),
        expectedMainSha: reviewedMain,
        originalActivationSha: original,
        expectedCleanupSha: cleanup,
        expectedExecutionSha: execution,
      };
      process.env["GITHUB_SHA"] = execution;
      expect(() => verifyGitBoundary(approval, amendment, root)).not.toThrow();
      expect(() =>
        verifyGitBoundary(approval, { ...amendment, expectedMainSha: main }, root),
      ).toThrow();
      git("checkout", "-b", "bad-core", cleanup);
      git("checkout", reviewedMain, "--", "publication-guard.ts");
      for (const file of AMENDED_ACTIVATION_FILES)
        await fs.writeFile(path.join(root, file), "synthetic amended\n");
      await fs.writeFile(path.join(root, "README"), "unapproved core change\n");
      git("add", ".");
      git("commit", "-m", "unapproved core");
      const badCore = git("rev-parse", "HEAD");
      process.env["GITHUB_SHA"] = badCore;
      expect(() =>
        verifyGitBoundary(approval, { ...amendment, expectedExecutionSha: badCore }, root),
      ).toThrow("ACTIVATION_DIFF");
      git("checkout", "activation");
      process.env["GITHUB_SHA"] = original;
      expect(() => verifyGitBoundary(approval, amendment, root)).toThrow();
      process.env["GITHUB_SHA"] = execution;
      await fs.writeFile(path.join(root, "README"), "dirty");
      expect(() => verifyGitBoundary(approval, amendment, root)).toThrow();
      git("checkout", "--", "README");
      git("branch", "-f", "main", cleanup);
      expect(() => verifyGitBoundary(approval, amendment, root)).toThrow();
      git("branch", "-f", "main", reviewedMain);
      git("checkout", "-b", "bad-cleanup", original);
      await fs.writeFile(
        path.join(root, ".github/workflows/shadow-private-activation.yml"),
        disabledWorkflow + "# altered\n",
      );
      git("add", ".");
      git("commit", "-m", "changed-cleanup");
      const badCleanup = git("rev-parse", "HEAD");
      for (const file of AMENDED_ACTIVATION_FILES)
        await fs.writeFile(path.join(root, file), "synthetic amended\n");
      git("add", ".");
      git("commit", "-m", "bad-amended");
      const badExecution = git("rev-parse", "HEAD");
      process.env["GITHUB_SHA"] = badExecution;
      expect(() =>
        verifyGitBoundary(
          approval,
          { ...amendment, expectedCleanupSha: badCleanup, expectedExecutionSha: badExecution },
          root,
        ),
      ).toThrow("CLEANUP_WORKFLOW_CHANGED");
    } finally {
      if (originalEnv === undefined) delete process.env["GITHUB_SHA"];
      else process.env["GITHUB_SHA"] = originalEnv;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
