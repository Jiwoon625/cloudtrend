/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic hostile transport inputs */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { validateGapMutation, assertWorkflow } from "./entry";
import { integratedAllocationRuntimeAdmission } from "../../src/lib/integratedAllocationStore.server";
import { INTEGRATED_RUNTIME_ATTEMPT_VERSION } from "../../src/lib/integratedAllocationRuntimeAudit.server";
import { INTEGRATED_ALLOCATION_OUTBOX_VERSION } from "../../src/lib/integratedAllocationRecovery.server";
import { INTEGRATED_ALLOCATION_VERSION } from "../../src/lib/integratedAllocationShadow";
import { regularOpenAt } from "../../src/lib/ledger/octoberShadowCalendar";
const owner = "11111111-1111-4111-8111-111111111111",
  origin = "https://example.supabase.co";
const hash = (n: string) => "sha256:" + n.repeat(64);
function fixture() {
  const krEvidence = {
    version: "integrated-kr-daily-evidence-v1",
    date: "2026-10-29",
    clock: {
      sourceHash: hash("a"),
      availableAt: "2026-10-30T08:00:00+09:00",
      decisionAt: "2026-10-30T08:10:00+09:00",
    },
  };
  const previous = { stateHash: hash("b") };
  const publications = ["O1", "S07"].map((kind) => ({
    bookId: INTEGRATED_ALLOCATION_VERSION + ":" + kind,
    registry: { bookId: INTEGRATED_ALLOCATION_VERSION + ":" + kind },
    stateHash: hash(kind === "O1" ? "c" : "d"),
    previousStateHash: previous.stateHash,
    receipt: { date: "2026-10-29", sourceHash: hash("e") },
  }));
  const plan = { krEvidence, publications };
  const capture = {
    capturedAt: "2026-11-01T10:00:00.000Z",
    baseline: {
      models: publications.map((p) => ({
        series_id: p.bookId,
        session_date: "2026-10-28",
        payload: previous,
      })),
    },
  };
  const evidenceHash = hash("f"),
    target = owner + "/staging/integrated-allocation-inputs/v1/KR/2026-10-29.json";
  const outbox = {
    version: INTEGRATED_ALLOCATION_OUTBOX_VERSION,
    market: "KR",
    date: "2026-10-29",
    hash: evidenceHash,
    payload: krEvidence,
  };
  return { o: { origin, key: "test-only", owner }, capture, plan, evidenceHash, target, outbox };
}
const json = (path: string, body: any, method = "POST", host = origin) =>
  new Request(host + path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const audit = (c: ReturnType<typeof fixture>) => ({
  user_id: owner,
  market: "KR",
  signal_date: "2026-10-29",
  strategy_version: INTEGRATED_ALLOCATION_VERSION,
  replay_mode: "RETROSPECTIVE",
  status: "WAITING_INPUT",
  source_captured_at: null,
  calculated_at: "2026-11-01T10:01:00.000Z",
  model_available_at: c.plan.krEvidence.clock.availableAt,
  model_decision_at: c.plan.krEvidence.clock.decisionAt,
  execution_at: regularOpenAt("KR", "2026-10-30"),
  source_hash: c.plan.krEvidence.clock.sourceHash,
  reason: "통합 배분 입력 저장 재시도 대기",
  details: { integratedAllocationOutbox: c.outbox },
});
const rpc = (c: ReturnType<typeof fixture>, i = 0) => ({
  p_user_id: owner,
  p_series: c.plan.publications[i].registry,
  p_run: c.plan.publications[i],
  p_previous_date: "2026-10-28",
  p_previous_hash: hash("b"),
});
describe("exact integrated gap mutation allowlist", () => {
  it.each([0, 1])("accepts only planned publication %i", async (i) => {
    const c = fixture();
    await expect(
      validateGapMutation(json("/rest/v1/rpc/ledger_append_model_session", rpc(c, i)), c),
    ).resolves.toBeUndefined();
  });
  it("accepts exact retrospective outbox", async () => {
    const c = fixture();
    await expect(
      validateGapMutation(json("/rest/v1/shadow_replay_audit", audit(c)), c),
    ).resolves.toBeUndefined();
  });
  it.each(["EVIDENCE_RESTORED", "PUBLICATION_ATTEMPT"])(
    "accepts exact actual-time %s intent",
    async (kind) => {
      const c = fixture(),
        p = c.plan.publications[0];
      const common = {
        version: INTEGRATED_RUNTIME_ATTEMPT_VERSION,
        ...integratedAllocationRuntimeAdmission,
      };
      const attempt =
        kind === "EVIDENCE_RESTORED"
          ? {
              ...common,
              kind,
              subjectHash: c.evidenceHash,
              sourceHash: c.plan.krEvidence.clock.sourceHash,
            }
          : {
              ...common,
              kind,
              subjectHash: p.stateHash,
              sourceHash: p.receipt.sourceHash,
              bookId: p.bookId,
              previousStateHash: p.previousStateHash,
            };
      const a = {
        ...audit(c),
        reason: "Runtime provenance intent only; economic publication outcome is not asserted",
        source_hash: attempt.sourceHash,
        model_available_at: null,
        model_decision_at: null,
        execution_at: null,
        details: { integratedRuntimeAttempt: attempt },
      };
      await expect(
        validateGapMutation(json("/rest/v1/shadow_replay_audit", a), c),
      ).resolves.toBeUndefined();
    },
  );
  it("accepts installed Supabase SDK exact Blob multipart upload larger than 2 MiB without network", async () => {
    const c = fixture();
    (c.plan.krEvidence as any).padding = "x".repeat(3 * 1024 * 1024);
    let calls = 0;
    const client = createClient(origin, "test-only", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          calls++;
          await validateGapMutation(new Request(input, init), c);
          return new Response(JSON.stringify({ Key: c.target, Id: "test" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    const result = await client.storage
      .from("cloudtrend-data")
      .upload(
        c.target,
        new Blob([JSON.stringify({ hash: c.evidenceHash, payload: c.plan.krEvidence })]),
        { upsert: false, contentType: "application/json", cacheControl: "0" },
      );
    expect(result.error).toBeNull();
    expect(calls).toBe(1);
  });
  it.each(["PATCH", "PUT", "DELETE"])("rejects %s", async (method) => {
    const c = fixture();
    await expect(
      validateGapMutation(json("/rest/v1/rpc/ledger_append_model_session", rpc(c), method), c),
    ).rejects.toThrow();
  });
  it("rejects foreign origin", async () => {
    const c = fixture();
    await expect(
      validateGapMutation(
        json(
          "/rest/v1/rpc/ledger_append_model_session",
          rpc(c),
          "POST",
          "https://other.supabase.co",
        ),
        c,
      ),
    ).rejects.toThrow();
  });
  it.each([
    "/rest/v1/analysis_source_files",
    "/rest/v1/portfolio_trades",
    "/rest/v1/rpc/ledger_append_own_october_model_session",
  ])("rejects unrelated target %s", async (path) => {
    const c = fixture();
    await expect(validateGapMutation(json(path, rpc(c)), c)).rejects.toThrow();
  });
  it.each(["p_user_id", "p_previous_date", "p_previous_hash"])(
    "rejects changed RPC %s",
    async (key) => {
      const c = fixture(),
        body: any = rpc(c);
      body[key] = "changed";
      await expect(
        validateGapMutation(json("/rest/v1/rpc/ledger_append_model_session", body), c),
      ).rejects.toThrow();
    },
  );
  it("rejects changed economic publication", async () => {
    const c = fixture(),
      body = structuredClone(rpc(c));
    body.p_run.receipt.date = "2026-10-30";
    await expect(
      validateGapMutation(json("/rest/v1/rpc/ledger_append_model_session", body), c),
    ).rejects.toThrow();
  });
  it.each([
    { user_id: "other" },
    { signal_date: "2026-10-30" },
    { replay_mode: "CONTEMPORANEOUS" },
    { calculated_at: "2026-10-30T00:00:00Z" },
    { source_captured_at: "2026-10-29T00:00:00Z" },
    { source_hash: hash("1") },
    { execution_at: null },
  ])("rejects altered audit intent %j", async (alteration) => {
    const c = fixture();
    await expect(
      validateGapMutation(json("/rest/v1/shadow_replay_audit", { ...audit(c), ...alteration }), c),
    ).rejects.toThrow();
  });
  it("rejects query parameters and extra audit fields", async () => {
    const c = fixture();
    await expect(
      validateGapMutation(json("/rest/v1/shadow_replay_audit?on_conflict=id", audit(c)), c),
    ).rejects.toThrow();
    await expect(
      validateGapMutation(
        json("/rest/v1/shadow_replay_audit", { ...audit(c), unreviewed: "value" }),
        c,
      ),
    ).rejects.toThrow();
  });
  it("rejects conflicting retained evidence", async () => {
    const c = fixture(),
      body = structuredClone(audit(c));
    body.details.integratedAllocationOutbox.hash = hash("0");
    await expect(
      validateGapMutation(json("/rest/v1/shadow_replay_audit", body), c),
    ).rejects.toThrow();
  });
  it.each(["upsert", "upsertCase", "date", "extra", "cache"])(
    "rejects altered multipart %s",
    async (change) => {
      const c = fixture(),
        form = new FormData();
      form.append("cacheControl", change === "cache" ? "3600" : "0");
      form.append(
        "",
        new Blob([JSON.stringify({ hash: c.evidenceHash, payload: c.plan.krEvidence })]),
      );
      if (change === "extra") form.append("metadata", "{}");
      const req = new Request(
        origin +
          "/storage/v1/object/cloudtrend-data/" +
          (change === "date" ? c.target.replace("10-29", "10-30") : c.target),
        {
          method: "POST",
          headers: {
            "x-upsert": change === "upsert" ? "true" : change === "upsertCase" ? "True" : "false",
          },
          body: form,
        },
      );
      await expect(validateGapMutation(req, c)).rejects.toThrow();
    },
  );
  it("rejects oversized exact JSON envelope", async () => {
    const c = fixture();
    (c.plan.krEvidence as any).padding = "x".repeat(8 * 1024 * 1024);
    await expect(
      validateGapMutation(
        json("/storage/v1/object/cloudtrend-data/" + c.target, {
          hash: c.evidenceHash,
          payload: c.plan.krEvidence,
        }),
        c,
      ),
    ).rejects.toThrow();
  });
});
describe("workflow admission", () => {
  const valid = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW: "Integrated allocation exact gap PLAN APPLY",
    RECOVERY_CONCURRENCY_GROUP: "kospi-prospective-shadow",
    GITHUB_SHA: "a".repeat(40),
    RECOVERY_MODE: "PLAN",
  };
  it.each(["INSPECT", "PLAN", "VALIDATE", "APPLY"])(
    "admits only main scheduled boundary %s",
    (RECOVERY_MODE) => expect(() => assertWorkflow({ ...valid, RECOVERY_MODE })).not.toThrow(),
  );
  it.each([
    { GITHUB_REF: "refs/heads/test" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { RECOVERY_CONCURRENCY_GROUP: "other" },
    { GITHUB_ACTIONS: "false" },
    { RECOVERY_MODE: "DELETE" },
  ])("rejects unsafe workflow %j", (bad) =>
    expect(() => assertWorkflow({ ...valid, ...bad })).toThrow(),
  );
});
