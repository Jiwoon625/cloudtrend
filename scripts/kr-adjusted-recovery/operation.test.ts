/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { verifyActualLedger, buildExecutionProvenance } from "./operation-schema";
import { operationReader, assertModelInventory } from "./operation-transport";
import { assertRecoveryWorkflow, prepareLegacyValidationStore } from "./operation-apply";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  H = `sha256:${"a".repeat(64)}`;
async function actual() {
  const row = {
    user_id: owner,
    revision: 7,
    updated_at: "2026-10-01T00:00:00Z",
    payload: { cash: 100, positions: [] },
  };
  return {
    row,
    pin: {
      table: "portfolio_ledgers" as const,
      user_id: owner,
      revision: 7,
      updated_at: new Date(row.updated_at).toISOString(),
      payloadHash: await hashSeriesValue(row.payload),
      rowHash: await hashSeriesValue({
        ...row,
        updated_at: new Date(row.updated_at).toISOString(),
      }),
      keys: ["cash", "positions"],
    },
  };
}
describe("actual ledger hash-only invariant", () => {
  it("normalizes UTC timestamp and verifies complete row", async () => {
    const { row, pin } = await actual();
    await verifyActualLedger(row, pin);
  });
  it.each(["value", "extra", "revision", "time", "owner"])(
    "rejects changed %s despite unchanged other fields",
    async (mode) => {
      const { row, pin } = await actual();
      const x: any = structuredClone(row);
      if (mode === "value") x.payload.cash++;
      if (mode === "extra") x.payload.hidden = 1;
      if (mode === "revision") x.revision++;
      if (mode === "time") x.updated_at = "2026-10-02T00:00:00Z";
      if (mode === "owner") x.user_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await expect(verifyActualLedger(x, pin)).rejects.toThrow();
    },
  );
});
it("fixed read transport rejects other tables and owner escapes, uses GET with no redirect", async () => {
  const fetcher = vi.fn(async () => new Response("[]"));
  const r = operationReader({
    origin: "https://synthetic.supabase.co",
    key: "synthetic",
    owner,
    fetcher: fetcher as any,
  });
  await r.rows("portfolio_ledgers", "user_id,payload");
  expect((fetcher.mock.calls[0] as any)[1]).toMatchObject({ method: "GET", redirect: "error" });
  expect(String((fetcher.mock.calls[0] as any)[0])).toContain("user_id=eq.");
  await expect(r.rows("auth.users", "*", {})).rejects.toThrow();
  await expect(r.rows("portfolio_ledgers", "*", { user_id: "eq.foreign" })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("model inventory rejects omitted originals and foreign extra sessions", async () => {
  const payload = { bookId: "synthetic", stateHash: H };
  const manifest: any = {
    modelInventory: [
      {
        seriesId: "synthetic",
        date: "2026-10-23",
        stateHash: H,
        payloadHash: await hashSeriesValue(payload),
      },
    ],
  };
  let rows: any[] = [];
  const o = {
    origin: "https://synthetic.supabase.co",
    key: "synthetic",
    owner,
    fetcher: (async () => new Response(JSON.stringify(rows))) as any,
  };
  await expect(assertModelInventory(o, manifest)).rejects.toThrow();
  rows = [{ series_id: "synthetic", session_date: "2026-10-23", state_hash: H, payload }];
  await assertModelInventory(o, manifest);
  rows.push({ ...rows[0], session_date: "2026-10-28" });
  await expect(assertModelInventory(o, manifest)).rejects.toThrow();
});
it("execution provenance enumerates exact dated state identities and actual/model clock label", async () => {
  const p: any = {
    preparationHash: H,
    operationManifestHash: H,
    models: {
      retrospectiveAuthorityCandidateHash: H,
      retrospectiveAuthorityCandidate: { receipt: { captureFinishedAt: "synthetic" } },
      newAdoptedSessions: [{ bookId: "b", receipt: { date: "2026-10-26" }, stateHash: H }],
      newIntegratedSessions: [{ bookId: "a", receipt: { date: "2026-10-27" }, stateHash: H }],
      retainedIntegrated26: [{ kind: "O1", stateHash: H }],
    },
  };
  const result = await buildExecutionProvenance(p);
  expect(result.newModelStates.map((x) => x.bookId)).toEqual(["a", "b"]);
  expect(result.clockSemantics).toBe("RETROSPECTIVE_MODEL_CLOCK_WITH_EVENT_TYPED_ACTUAL_EVIDENCE");
  expect(result.historicalAvailabilityClaim).toBe(false);
});
it("APPLY admits only the named main/manual serialized workflow", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW: "KR adjusted recovery reviewed PLAN APPLY",
    RECOVERY_CONCURRENCY_GROUP: "kospi-prospective-shadow",
    GITHUB_SHA: "a".repeat(40),
  };
  assertRecoveryWorkflow(env);
  for (const key of Object.keys(env))
    expect(() => assertRecoveryWorkflow({ ...env, [key]: "wrong" })).toThrow();
});
it("workflow exposes only opaque hashes; same legacy group, no raw artifacts, cleanup and split credentials", () => {
  const text = fs.readFileSync(".github/workflows/kr-adjusted-recovery-operation.yml", "utf8");
  expect(text).toContain("group: kospi-prospective-shadow");
  expect(text).toContain("persist-credentials: false");
  expect(text).toContain("if: always()");
  expect(text).not.toContain("upload-artifact");
  const pure = text.slice(
    text.indexOf("- name: Calculate full ordered plan"),
    text.indexOf("- name: Append private plan"),
  );
  expect(pure).not.toContain("secrets.");
  expect(text).not.toMatch(/inputs\.(symbol|owner|source_id|price|payload)/);
});

it("legacy validation listing follows virtual26/27 without writing live23 and detects an unseen future", async () => {
  const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    root = `${owner}/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1`,
    values = new Map<string, unknown>([
      [root + "/sessions/2026-10-23.json", { date: "2026-10-23" }],
    ]);
  const writes = vi.fn(async () => {
    throw new Error("LIVE_WRITE_FORBIDDEN");
  });
  const live: any = {
    read: async (p: string) => values.get(p) ?? null,
    latestSessionDate: async () =>
      [...values.keys()]
        .map((p) => p.slice(-15, -5))
        .sort()
        .at(-1) ?? null,
    putImmutable: writes,
    putLatest: writes,
  };
  const prep = {
    kospi: { capturedObjects: [{ path: root + "/sessions/2026-10-23.json" }] },
    scope: { dates: ["2026-10-26", "2026-10-27"] },
  };
  const dry = await prepareLegacyValidationStore(live, owner, prep);
  expect(await dry.latestSessionDate(root + "/sessions")).toBe("2026-10-23");
  await dry.putImmutable(root + "/sessions/2026-10-26.json", { date: "2026-10-26" });
  expect(await dry.latestSessionDate(root + "/sessions")).toBe("2026-10-26");
  await dry.putImmutable(root + "/sessions/2026-10-27.json", { date: "2026-10-27" });
  expect(await dry.latestSessionDate(root + "/sessions")).toBe("2026-10-27");
  expect(await live.latestSessionDate()).toBe("2026-10-23");
  expect(writes).not.toHaveBeenCalled();
  values.set(root + "/sessions/2026-10-28.json", {});
  await expect(dry.latestSessionDate(root + "/sessions")).rejects.toThrow();
});
