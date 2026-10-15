import { beforeEach, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readKrSourceVintageApproval } from "./krSourceVintageApproval.server";
import {
  KR_SOURCE_VINTAGE_REVIEW_ID as ID,
  KR_SOURCE_VINTAGE_POLICY as POLICY,
  type KrSourceVintagePrivateApproval,
} from "./ledger/krSourceVintage";
import { hashSeriesValue } from "./ledger/modelSeries";
const uid = "11111111-1111-4111-8111-111111111111";
const rows: Record<string, unknown>[] = [];
let fail = false,
  reads = 0;
const contains = (a: unknown, b: unknown): boolean =>
  b !== null && typeof b === "object"
    ? a !== null &&
      typeof a === "object" &&
      Object.entries(b).every(([k, v]) => contains((a as Record<string, unknown>)[k], v))
    : a === b;
const client = {
  from: (table: string) => {
    expect(table).toBe("shadow_replay_audit");
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
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
      then: (resolve: (r: unknown) => unknown) => {
        reads++;
        return Promise.resolve(
          resolve({
            data: rows.filter((r) => filters.every((f) => f(r))),
            error: fail ? { message: "private error" } : null,
          }),
        );
      },
    };
    return q;
  },
} as unknown as SupabaseClient;
async function fixture(): Promise<KrSourceVintagePrivateApproval> {
  const receipt = {
    version: "kr-source-vintage-review-v1" as const,
    reviewId: ID,
    reviews: ["2026-10-12", "2026-10-13"].map((date) => ({
      id: ID,
      symbol: "SYNTHETIC",
      date,
      notBefore: "2026-10-14",
      archivedHash: `sha256:${"a".repeat(64)}` as const,
      incomingHash: `sha256:${"b".repeat(64)}` as const,
      evidenceUrl: "https://dart.fss.or.kr/synthetic-fixture",
    })),
  };
  return {
    receipt,
    registry: {
      version: "kr-source-vintage-approval-v1",
      reviewId: ID,
      status: "APPROVED",
      policy: POLICY,
      receiptHash: await hashSeriesValue(receipt),
    },
  };
}
function insert(key: string, value: unknown, userId = uid) {
  rows.push({
    user_id: userId,
    market: "KR",
    strategy_version: ID,
    details: { [key]: structuredClone(value) },
  });
}
beforeEach(() => {
  rows.length = 0;
  fail = false;
  reads = 0;
});
it("does not self-approve missing configuration or another owner's receipt", async () => {
  expect(await readKrSourceVintageApproval(client, uid)).toBeNull();
  const f = await fixture();
  insert("krSourceVintageApproval", f.registry, "22222222-2222-4222-8222-222222222222");
  insert("krSourceVintageReview", f.receipt, "22222222-2222-4222-8222-222222222222");
  expect(await readKrSourceVintageApproval(client, uid)).toBeNull();
});
it("requires independent approval registry and exact canonical private body", async () => {
  const f = await fixture();
  insert("krSourceVintageApproval", f.registry);
  insert("krSourceVintageReview", f.receipt);
  const before = JSON.stringify(rows);
  expect(await readKrSourceVintageApproval(client, uid)).toEqual(f);
  expect(JSON.stringify(rows)).toBe(before);
});
it("rejects an unapproved or incomplete two-record setup", async () => {
  const f = await fixture();
  insert("krSourceVintageReview", f.receipt);
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Incomplete");
  insert("krSourceVintageApproval", { ...f.registry, status: "PENDING" });
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Unapproved");
});
it("rejects changed body even with its own recomputed hash", async () => {
  const f = await fixture();
  insert("krSourceVintageApproval", f.registry);
  f.receipt.reviews[0]!.incomingHash = `sha256:${"c".repeat(64)}`;
  insert("krSourceVintageReview", {
    ...f.receipt,
    selfDeclaredHash: await hashSeriesValue(f.receipt),
  });
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Unapproved");
});
it("never selects latest conflicting approval or receipt", async () => {
  const f = await fixture();
  insert("krSourceVintageApproval", f.registry);
  insert("krSourceVintageReview", f.receipt);
  insert("krSourceVintageApproval", { ...f.registry, receiptHash: `sha256:${"c".repeat(64)}` });
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Conflicting");
});
it("rejects broadening, duplicate observations and untrusted lookup failures", async () => {
  const f = await fixture();
  f.receipt.reviews.push(f.receipt.reviews[0]!);
  f.registry.receiptHash = await hashSeriesValue(f.receipt);
  insert("krSourceVintageApproval", f.registry);
  insert("krSourceVintageReview", f.receipt);
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Unapproved");
  fail = true;
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("lookup failed");
  await expect(readKrSourceVintageApproval(client, "invalid")).rejects.toThrow(
    "Verified private review owner",
  );
});
