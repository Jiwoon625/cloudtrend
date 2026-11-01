import { expect, it } from "vitest";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  inspectCompletion,
  reconcile,
  type Market,
  type ReconcilePort,
  type Snapshot,
} from "./core";
const H = `sha256:${"a".repeat(64)}`;
const now = "2026-11-04T01:00:00Z";
function fixture(dates = ["2026-10-30", "2026-11-02", "2026-11-03"]) {
  const state: Snapshot = {
    heads: { O1: "2026-10-29", S07: "2026-10-29" },
    models: {},
    evidence: {},
    fingerprint: H,
  };
  const writes: string[] = [];
  for (const d of dates)
    for (const m of ["KR", "US"]) {
      state.models[`${m}:${d}`] = { complete: true, sourceHash: H };
      state.evidence[`${m}:${d}`] = {
        status: "STORED",
        hash: H,
        sourceHash: H,
        decisionAt: "2026-11-03T23:10:00Z",
      };
    }
  const port: ReconcilePort = {
    dates,
    due: () => ["KR", "US"],
    async inspect() {
      const { fingerprint: _, ...body } = state;
      return structuredClone({ ...body, fingerprint: await hashSeriesValue(body) });
    },
    async restore(m, d, h) {
      expect(h).toBe(H);
      state.evidence[`${m}:${d}`].status = "STORED";
      writes.push(`restore:${m}:${d}`);
    },
    async replay(through) {
      let recorded = 0;
      for (const kind of ["O1", "S07"] as const)
        for (const date of dates)
          if (date <= through && date > (state.heads[kind] ?? "")) {
            state.heads[kind] = date;
            writes.push(`${kind}:${date}`);
            recorded++;
          }
      return { recorded, waiting: null };
    },
  };
  return { state, writes, port };
}
it("reconciles three real calendar sessions spanning a weekend then reuses all completed days", async () => {
  const { port, writes } = fixture();
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "COMPLETE",
    recorded: 6,
  });
  expect(writes).toEqual([
    "O1:2026-10-30",
    "O1:2026-11-02",
    "O1:2026-11-03",
    "S07:2026-10-30",
    "S07:2026-11-02",
    "S07:2026-11-03",
  ]);
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "COMPLETE",
    recorded: 0,
  });
  expect(writes).toHaveLength(6);
});
it("dry run never writes even a recoverable outbox", async () => {
  const { state, port, writes } = fixture();
  state.evidence["KR:2026-11-02"].status = "OUTBOX";
  expect(await reconcile(port, { now, apply: false })).toMatchObject({
    status: "READY",
    recoverableInputs: 1,
  });
  expect(writes).toEqual([]);
});
it("finds middle input missing independently of already advanced market and integrated heads", async () => {
  const { state, port, writes } = fixture();
  state.heads = { O1: "2026-11-03", S07: "2026-11-03" };
  state.evidence["KR:2026-11-02"] = {
    status: "MISSING",
    hash: null,
    sourceHash: null,
    decisionAt: null,
  };
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "REPAIR_REQUIRED",
    findings: [{ date: "2026-11-02", market: "KR", reason: "MISSING_PREPARED_EVIDENCE" }],
  });
  expect(writes).toEqual([]);
});
it("restores exact historical outbox even when both integrated heads are ahead", async () => {
  const { state, port, writes } = fixture();
  state.heads = { O1: "2026-11-03", S07: "2026-11-03" };
  state.evidence["KR:2026-11-02"].status = "OUTBOX";
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "COMPLETE",
    restoredInputs: 1,
    recorded: 0,
  });
  expect(writes).toEqual(["restore:KR:2026-11-02"]);
});
it("waits for delayed US and only applies the preceding globally complete prefix", async () => {
  const { state, port, writes } = fixture();
  state.models["US:2026-11-02"].complete = false;
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "WAITING",
    recorded: 2,
    readyThrough: "2026-10-30",
  });
  expect(writes).toEqual(["O1:2026-10-30", "S07:2026-10-30"]);
  state.models["US:2026-11-02"].complete = true;
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "COMPLETE",
    recorded: 4,
  });
});
it("holds prepared but unpublished source instead of treating stage presence as finality", async () => {
  const { state, port, writes } = fixture();
  state.models["KR:2026-10-30"].complete = false;
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "WAITING",
    recorded: 0,
  });
  expect(writes).toEqual([]);
});
it("does not restore or publish before evidence decision time", async () => {
  const { state, port, writes } = fixture();
  state.evidence["KR:2026-10-30"].status = "OUTBOX";
  expect(await reconcile(port, { now: "2026-11-02T00:00:00Z", apply: true })).toMatchObject({
    status: "WAITING",
    restoredInputs: 0,
    recorded: 0,
  });
  expect(writes).toEqual([]);
});
it("one-market holiday uses the verified due-market union", async () => {
  const { state, port, writes } = fixture(["2026-11-25", "2026-11-26", "2026-11-27"]);
  port.due = (d) => (d === "2026-11-26" ? ["KR"] : ["KR", "US"]);
  delete state.models["US:2026-11-26"];
  delete state.evidence["US:2026-11-26"];
  expect(await reconcile(port, { now: "2026-11-30T01:00:00Z", apply: true })).toMatchObject({
    status: "COMPLETE",
    recorded: 6,
  });
  expect(writes).toHaveLength(6);
});
it("partial integrated append failure is not retried blindly; next invocation resumes exact prefix", async () => {
  const { state, port, writes } = fixture();
  const replay = port.replay;
  port.replay = async () => {
    state.heads.O1 = "2026-11-03";
    writes.push("committed O1 prefix");
    throw Error("uncertain result");
  };
  await expect(reconcile(port, { now, apply: true })).rejects.toThrow("uncertain");
  port.replay = replay;
  expect(await reconcile(port, { now, apply: true })).toMatchObject({
    status: "COMPLETE",
    recorded: 3,
  });
  expect(writes).toHaveLength(4);
});
it("rejects changed source even when both versions individually hash", async () => {
  const { state, port, writes } = fixture();
  state.evidence["KR:2026-11-02"].sourceHash = `sha256:${"b".repeat(64)}`;
  await expect(reconcile(port, { now, apply: true })).rejects.toThrow("source conflict");
  expect(writes).toEqual([]);
});
it("aborts on a concurrent snapshot change before replay", async () => {
  const { port, writes } = fixture();
  const inspect = port.inspect;
  let calls = 0;
  port.inspect = async () => {
    const s = await inspect();
    if (++calls > 1) s.fingerprint = H;
    return s;
  };
  await expect(reconcile(port, { now, apply: true })).rejects.toThrow("Concurrent");
  expect(writes).toEqual([]);
});
it.each(["2026-02-30", "2026-11-01T00:00:00Z", "not-a-date"])(
  "rejects malformed session %s",
  async (d) => {
    const { port } = fixture([d]);
    await expect(reconcile(port, { now, apply: false })).rejects.toThrow("calendar");
  },
);
it("rejects truncated coverage and duplicate/unordered sessions", async () => {
  const { state, port } = fixture();
  delete state.models["US:2026-11-02"];
  expect(() => inspectCompletion(port, state, now)).toThrow("coverage");
  port.dates.reverse();
  expect(() => inspectCompletion(port, state, now)).toThrow("calendar");
});
it("restoration failure does not trigger second write or later replay", async () => {
  const { state, port, writes } = fixture();
  state.evidence["KR:2026-11-02"].status = "OUTBOX";
  port.restore = async (_m: Market, _d: string) => {
    writes.push("attempt");
    throw Error("storage failure");
  };
  await expect(reconcile(port, { now, apply: true })).rejects.toThrow("storage failure");
  expect(writes).toEqual(["attempt"]);
});
