import { beforeEach, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appendIntegratedAllocationPublication,
  readIntegratedAllocationBook,
  integratedAllocationRuntimeAdmission,
} from "../src/lib/integratedAllocationStore.server";
import {
  integratedRegistry,
  type IntegratedDailyPublication,
} from "../src/lib/integratedAllocationPublication";
import { INTEGRATED_ALLOCATION_FROZEN_CODE_HASH as F } from "../src/lib/integratedAllocationRuntimeAdmission";
import { integratedCompatibilityScenario } from "./fixtures/integrated-runtime-compatibility-scenario";
const uid = "11111111-1111-4111-8111-111111111111";
const audits: Record<string, unknown>[] = [];
let saved: IntegratedDailyPublication | null = null,
  rpcCalls = 0,
  failAudit = false;
let registry = await integratedRegistry("O1", F);
let first: IntegratedDailyPublication;
await integratedCompatibilityScenario((p) => {
  if (p.registry.policy.kind === "O1" && p.receipt.date === "2026-10-12") first = p;
});
const contains = (a: unknown, b: unknown): boolean =>
  b !== null && typeof b === "object"
    ? a !== null &&
      typeof a === "object" &&
      Object.entries(b).every(([k, v]) => contains((a as Record<string, unknown>)[k], v))
    : a === b;
const client = {
  from: (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const rows = () =>
      table === "shadow_replay_audit"
        ? audits
        : table === "ledger_model_series"
          ? [{ user_id: uid, series_id: registry.bookId, payload: registry }]
          : saved
            ? [
                {
                  user_id: uid,
                  series_id: saved.bookId,
                  session_date: saved.receipt.date,
                  payload: saved,
                },
              ]
            : [];
    const result = () => rows().filter((r) => filters.every((f) => f(r)));
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters.push((r) => r[k] === v);
        return q;
      },
      contains: (k: string, v: unknown) => {
        filters.push((r) => contains(r[k], v));
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(resolve({ data: result(), error: null })),
      insert: async (row: Record<string, unknown>) => {
        expect(table).toBe("shadow_replay_audit");
        if (!failAudit) audits.push(structuredClone(row));
        return { error: failAudit ? { message: "fixture outage" } : null };
      },
    };
    return q;
  },
  rpc: async (_name: string, args: { p_run: IntegratedDailyPublication }) => {
    rpcCalls++;
    expect(
      audits.some((row) =>
        contains(row["details"], {
          integratedRuntimeAttempt: {
            subjectHash: args.p_run.stateHash,
            runtimeCodeHash: integratedAllocationRuntimeAdmission.runtimeCodeHash,
            frozenCodeHash: F,
          },
        }),
      ),
    ).toBe(true);
    const reused = saved?.stateHash === args.p_run.stateHash;
    saved = structuredClone(args.p_run);
    return { data: { stateHash: saved.stateHash, reused }, error: null };
  },
} as unknown as SupabaseClient;
beforeEach(async () => {
  audits.length = 0;
  saved = null;
  rpcCalls = 0;
  failAudit = false;
  registry = await integratedRegistry("O1", F);
});
it("reads the original frozen registry without rewriting it", async () => {
  const old = JSON.stringify(registry);
  const book = await readIntegratedAllocationBook(client, uid, "O1");
  expect(book.status).toBe("INITIALIZED_WAITING");
  expect(book.ledger?.contract.codeHash).toBe(F);
  expect(JSON.stringify(registry)).toBe(old);
  expect(rpcCalls).toBe(0);
  expect(audits).toHaveLength(0);
});
it("persists verified runtime intent before unchanged economic publication and reuses exact retry", async () => {
  expect(integratedAllocationRuntimeAdmission.runtimeCodeHash).not.toBe(F);
  const old = JSON.stringify(first);
  const result = await appendIntegratedAllocationPublication(client, uid, first, null);
  expect(result.reused).toBe(false);
  expect(JSON.stringify(saved)).toBe(old);
  expect(JSON.stringify(first)).toBe(old);
  const retry = await appendIntegratedAllocationPublication(client, uid, first, null);
  expect(retry.reused).toBe(true);
  expect(audits).toHaveLength(1);
});
it("refuses an economic append when runtime provenance could not be saved", async () => {
  failAudit = true;
  await expect(appendIntegratedAllocationPublication(client, uid, first, null)).rejects.toThrow(
    "provenance write could not be verified",
  );
  expect(rpcCalls).toBe(0);
  expect(saved).toBeNull();
});
it("rejects a substituted frozen identity before audit or economic mutation", async () => {
  const wrong = structuredClone(first);
  wrong.registry.codeHash = `sha256:${"f".repeat(64)}`;
  await expect(appendIntegratedAllocationPublication(client, uid, wrong, null)).rejects.toThrow(
    "admission contract",
  );
  expect(rpcCalls).toBe(0);
  expect(audits).toHaveLength(0);
});
