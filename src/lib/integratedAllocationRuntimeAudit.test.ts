import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordIntegratedRuntimeAttempt } from "./integratedAllocationRuntimeAudit.server";
import {
  INTEGRATED_ALLOCATION_FROZEN_CODE_HASH as F,
  reviewedIntegratedRuntime,
} from "./integratedAllocationRuntimeAdmission";
const uid = "11111111-1111-4111-8111-111111111111";
const rows: Array<Record<string, unknown>> = [];
let writes = 0,
  fail = false,
  uncertain = false,
  failRead = false;
const contains = (a: unknown, b: unknown): boolean =>
  b !== null && typeof b === "object"
    ? a !== null &&
      typeof a === "object" &&
      Object.entries(b).every(([k, v]) => contains((a as Record<string, unknown>)[k], v))
    : a === b;
const client = {
  from: (table: string) => {
    expect(table).toBe("shadow_replay_audit");
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const query = {
      select: () => query,
      eq: (k: string, v: unknown) => {
        filters.push((r) => r[k] === v);
        return query;
      },
      contains: (k: string, v: unknown) => {
        filters.push((r) => contains(r[k], v));
        return query;
      },
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve(
          resolve({
            data: rows.filter((r) => filters.every((f) => f(r))),
            error: failRead ? { message: "private upstream body" } : null,
          }),
        ),
      insert: async (row: Record<string, unknown>) => {
        writes++;
        if (!fail) rows.push(structuredClone(row));
        return { error: fail || uncertain ? { message: "private upstream body" } : null };
      },
    };
    return query;
  },
} as unknown as SupabaseClient;
const input = () => ({
  admission: reviewedIntegratedRuntime(F, F),
  kind: "EVIDENCE_PREPARED" as const,
  date: "2026-10-14",
  market: "KR" as const,
  subjectHash: F,
  sourceHash: F,
});
beforeEach(() => {
  rows.length = 0;
  writes = 0;
  fail = false;
  uncertain = false;
  failRead = false;
});
describe("append-only actual runtime provenance", () => {
  it("records exact executable and frozen identities without changing economic input", async () => {
    const value = input(),
      original = JSON.stringify(value);
    expect(await recordIntegratedRuntimeAttempt(client, uid, value)).toEqual({ reused: false });
    expect(JSON.stringify(value)).toBe(original);
    expect(rows[0]).toMatchObject({
      status: "WAITING_INPUT",
      details: {
        integratedRuntimeAttempt: {
          version: "integrated-allocation-runtime-attempt-v1",
          runtimeCodeHash: F,
          frozenCodeHash: F,
          kind: "EVIDENCE_PREPARED",
          subjectHash: F,
        },
      },
    });
    expect(rows[0]!["details"]).not.toHaveProperty("payload");
    expect(await recordIntegratedRuntimeAttempt(client, uid, value)).toEqual({ reused: true });
    expect(writes).toBe(1);
  });
  it("verifies an uncertain committed response before retrying", async () => {
    uncertain = true;
    await recordIntegratedRuntimeAttempt(client, uid, input());
    await recordIntegratedRuntimeAttempt(client, uid, input());
    expect(writes).toBe(1);
  });
  it("fails closed when intent cannot be verified and never leaks upstream errors", async () => {
    fail = true;
    await expect(recordIntegratedRuntimeAttempt(client, uid, input())).rejects.toThrow(
      "write could not be verified",
    );
    failRead = true;
    await expect(recordIntegratedRuntimeAttempt(client, uid, input())).rejects.toThrow(
      "provenance read failed",
    );
    expect(writes).toBe(1);
  });
  it("rejects forged review, wrong owner/date, and unknown executable before write", async () => {
    await expect(recordIntegratedRuntimeAttempt(client, "invalid", input())).rejects.toThrow(
      "Invalid",
    );
    await expect(
      recordIntegratedRuntimeAttempt(client, uid, { ...input(), date: "2026-02-30" }),
    ).rejects.toThrow("Invalid");
    await expect(
      recordIntegratedRuntimeAttempt(client, uid, {
        ...input(),
        admission: { ...input().admission, reviewId: "forged-review" },
      }),
    ).rejects.toThrow("Invalid");
    await expect(
      recordIntegratedRuntimeAttempt(client, uid, {
        ...input(),
        admission: { ...input().admission, runtimeCodeHash: `sha256:${"a".repeat(64)}` },
      }),
    ).rejects.toThrow("Unreviewed");
    expect(writes).toBe(0);
  });
  it("does not reuse a conflicting record or treat an attempt as economic success", async () => {
    await recordIntegratedRuntimeAttempt(client, uid, input());
    const details = rows[0]!["details"] as { integratedRuntimeAttempt: { reviewId: string } };
    details.integratedRuntimeAttempt.reviewId = "forged-review";
    await expect(recordIntegratedRuntimeAttempt(client, uid, input())).rejects.toThrow("conflict");
    expect(writes).toBe(1);
    expect(rows[0]!["status"]).not.toBe("RECORDED");
  });
});
