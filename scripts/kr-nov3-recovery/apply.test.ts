/* eslint-disable @typescript-eslint/no-explicit-any -- genuine engine synthetic fixtures */
import { beforeAll, expect, it, vi } from "vitest";
import { nov3Fixture } from "./fixture";
import { prepareKrNov3Recovery, type KrNov3Plan } from "./core";
import { applyKrNov3Recovery, krNov3ApprovalCandidate, type KrNov3ApplyInput } from "./apply";
import { boundedKrNov3Store, stageKrNov3Authority } from "./transport";
import { reproduceKrNov3Plan, saveKrPrivate } from "./entry";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  clone,
  plainStore,
  sessionKey,
  type MemoryData,
} from "../kr-adjusted-recovery/recovery-model-plan-fixture";
let plan: KrNov3Plan, baseline: MemoryData;
beforeAll(async () => {
  const f = await nov3Fixture();
  baseline = f.data;
  plan = await prepareKrNov3Recovery(f.capture);
}, 30_000);
async function setup() {
  const data = clone(baseline),
    store = plainStore(data),
    approval = await krNov3ApprovalCandidate(plan);
  const writes = {
    archives: vi.spyOn(store, "putKrInput"),
    prepared: vi.spyOn(store, "prepare"),
    append: vi.spyOn(store, "append"),
    registry: vi.spyOn(store, "insertSeries"),
    provenance: vi.fn(async () => {}),
  };
  const input: KrNov3ApplyInput = {
    phase: "VALIDATE",
    plan,
    approval,
    owner: plan.preparation.owner,
    authoritativePlanHash: await hashSeriesValue(plan),
    authoritativeApprovalHash: await hashSeriesValue(approval),
    admittedCodeCommit: plan.preparation.codeCommit,
    admittedRuntimeHashes: plan.preparation.runtimeHashes,
    store,
    readAuthority: vi.fn(async () => clone(plan.vintageAuthorityCandidate)),
    assertFresh: vi.fn(async () => {}),
    assertExclusiveWriter: vi.fn(async () => {}),
    putProvenance: writes.provenance,
  };
  return { input, data, store, writes };
}
function zero(w: Awaited<ReturnType<typeof setup>>["writes"]) {
  for (const fn of Object.values(w)) expect(fn).not.toHaveBeenCalled();
}
it("VALIDATE has zero writes including provenance, authority, archive and prepared artifacts", async () => {
  const { input, data, writes } = await setup();
  expect(await applyKrNov3Recovery(input)).toMatchObject({
    status: "VALIDATED",
    noOperationalWrites: true,
  });
  zero(writes);
  expect(data).toEqual(baseline);
});
it("appends exactly five MODEL runs through bounded writer, preserves entire prefix and retries idempotently", async () => {
  const { input, data, store, writes } = await setup();
  input.phase = "APPLY";
  input.store = boundedKrNov3Store(store, plan);
  expect(await applyKrNov3Recovery(input)).toMatchObject({
    status: "APPLIED",
    expectedNewModelSessions: 5,
  });
  expect(writes.append).toHaveBeenCalledTimes(5);
  expect(writes.registry).not.toHaveBeenCalled();
  expect(data.sessions.size).toBe(baseline.sessions.size + 5);
  for (const [k, v] of baseline.sessions) expect(data.sessions.get(k)).toEqual(v);
  await applyKrNov3Recovery(input);
  expect(writes.append).toHaveBeenCalledTimes(5);
});
it.each(["plan", "approval", "owner", "runtime", "authority", "freshness", "exclusive"])(
  "rejects %s before any write",
  async (kind) => {
    const { input, writes } = await setup();
    input.phase = "APPLY";
    if (kind === "plan") input.authoritativePlanHash = ("sha256:" + "b".repeat(64)) as any;
    if (kind === "approval") input.authoritativeApprovalHash = ("sha256:" + "b".repeat(64)) as any;
    if (kind === "owner") input.owner = "foreign";
    if (kind === "runtime")
      input.admittedRuntimeHashes = {
        ...input.admittedRuntimeHashes,
        october: ("sha256:" + "b".repeat(64)) as any,
      };
    if (kind === "authority") input.readAuthority = async () => null;
    if (kind === "freshness")
      input.assertFresh = async () => {
        throw Error("drift");
      };
    if (kind === "exclusive")
      input.assertExclusiveWriter = async () => {
        throw Error("busy");
      };
    await expect(applyKrNov3Recovery(input)).rejects.toThrow();
    zero(writes);
  },
);
it.each(["predecessor", "target", "prepared", "newer"])(
  "admits every book and fails closed on %s conflict",
  async (kind) => {
    const { input, data, writes } = await setup();
    input.phase = "APPLY";
    const e = plan.preparedPublications[0]!.entries.at(-1)!;
    if (kind === "predecessor")
      data.sessions.set(sessionKey(e.series.bookId, "2026-11-02"), {
        ...clone(plan.predecessors.at(-1)!.run),
        stateHash: "changed",
      } as any);
    if (kind === "target")
      data.sessions.set(sessionKey(e.series.bookId, "2026-11-03"), {
        ...clone(e.run),
        stateHash: "changed",
      } as any);
    if (kind === "prepared")
      data.prepared.set("KR:2026-11-03", {
        ...clone(plan.preparedPublications[0]!),
        inputHash: "changed",
      } as any);
    if (kind === "newer")
      data.sessions.set(sessionKey(e.series.bookId, "2026-11-04"), {
        ...clone(e.run),
        receipt: { ...e.run.receipt, date: "2026-11-04" },
      } as any);
    await expect(applyKrNov3Recovery(input)).rejects.toThrow();
    zero(writes);
  },
);
it("a committed append with lost response is read once, never blindly retried", async () => {
  const { input, store, writes } = await setup();
  input.phase = "APPLY";
  const original = store.append;
  store.append = async (...args) => {
    const result = await original(...args);
    if (args[0].policy.kind === "KR_MIXED") throw Error("response lost");
    return result;
  };
  expect(await applyKrNov3Recovery(input)).toMatchObject({ status: "APPLIED" });
  expect(writes.append).toHaveBeenCalledTimes(5);
});
it("an uncommitted uncertain append stops and preserves the partial state for explicit resume", async () => {
  const { input, store, data } = await setup();
  input.phase = "APPLY";
  const original = store.append;
  let calls = 0;
  store.append = async (...args) => {
    calls++;
    if (calls === 2) throw Error("network");
    return original(...args);
  };
  await expect(applyKrNov3Recovery(input)).rejects.toThrow("network");
  expect(calls).toBe(2);
  expect(data.sessions.size).toBe(baseline.sessions.size + 1);
  store.append = original;
  expect(await applyKrNov3Recovery(input)).toMatchObject({ status: "APPLIED" });
});
it("bounded store rejects registry, changed payload, other date and book writes", async () => {
  const { store, writes } = await setup(),
    b = boundedKrNov3Store(store, plan),
    e = plan.preparedPublications[0]!.entries[0]!;
  await expect(b.insertSeries()).rejects.toThrow();
  await expect(b.readSession("ACTUAL", "2026-11-03")).rejects.toThrow();
  await expect(b.readSession(e.series.bookId, "2026-11-04")).rejects.toThrow();
  await expect(
    b.append(e.series, { ...e.run, stateHash: "changed" } as any, plan.predecessors[0]!.run),
  ).rejects.toThrow();
  zero(writes);
});

it("rejects malformed partial authority hash before inserting the missing registry", async () => {
  const { input } = await setup();
  const row = {
    user_id: input.owner,
    market: "KR",
    strategy_version: "reviewed-kr-vintage-v3",
    signal_date: "2026-11-03",
    replay_mode: "RETROSPECTIVE",
    model_available_at: null,
    model_decision_at: null,
    execution_at: null,
    source_hash: "sha256:" + "0".repeat(64),
    details: { krSourceVintageReview: plan.vintageAuthorityCandidate.receipt },
  };
  const client = { from: vi.fn() } as any;
  const o = {
    origin: "https://example.supabase.co",
    key: "test",
    owner: input.owner,
    fetcher: vi.fn(async () => new Response(JSON.stringify([row]))),
  };
  await expect(
    stageKrNov3Authority(
      o,
      client,
      plan,
      input.approval,
      input.authoritativePlanHash,
      input.authoritativeApprovalHash,
      async () => {},
    ),
  ).rejects.toThrow();
  expect(client.from).not.toHaveBeenCalled();
});
it("reproduces the exact stored-capture plan without changing its actual clock", async () => {
  const f = await nov3Fixture(),
    p = await prepareKrNov3Recovery(f.capture);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-nov3-reproduction-"));
  try {
    saveKrPrivate(path.join(dir, "capture.json"), f.capture);
    saveKrPrivate(path.join(dir, "plan.json"), p);
    saveKrPrivate(path.join(dir, "pins.json"), {
      version: "kr-nov3-reproduction-pins-v1",
      owner: f.capture.owner,
      codeCommit: f.capture.codeCommit,
      captureHash: await hashSeriesValue(f.capture),
      planHash: await hashSeriesValue(p),
    });
    expect(await reproduceKrNov3Plan(dir)).toMatchObject({
      status: "REPRODUCED",
      planHash: await hashSeriesValue(p),
    });
    fs.rmSync(path.join(dir, "proof.json"));
    const altered = { ...p, expectedNewModelSessions: 6 };
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(altered));
    await expect(reproduceKrNov3Plan(dir)).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
