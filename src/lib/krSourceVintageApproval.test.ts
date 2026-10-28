import { beforeEach, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readKrSourceVintageApproval } from "./krSourceVintageApproval.server";
import {
  KR_SOURCE_VINTAGE_REVIEW_ID as ID,
  KR_SOURCE_VINTAGE_POLICY as POLICY,
  KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID as NEXT_ID,
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApprovalV1,
  type KrSourceVintagePrivateApprovalV2,
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
async function fixture(): Promise<KrSourceVintagePrivateApprovalV1> {
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
    strategy_version: (value as { reviewId: string }).reviewId,
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

async function successorFixture(): Promise<KrSourceVintagePrivateApprovalV2> {
  const predecessor = await fixture();
  const receipt = {
    version: "kr-source-vintage-review-v2" as const,
    reviewId: NEXT_ID,
    parentReceiptHash: predecessor.registry.receiptHash,
    reviews: [
      ...structuredClone(predecessor.receipt.reviews),
      ...["2026-10-14", "2026-10-15"].map((date) => ({
        ...predecessor.receipt.reviews[0]!,
        id: NEXT_ID,
        symbol: "SECOND_SYNTHETIC",
        date,
        notBefore: "2026-10-16",
      })),
    ],
  };
  return {
    predecessor,
    receipt,
    registry: {
      version: "kr-source-vintage-approval-v2",
      reviewId: NEXT_ID,
      status: "APPROVED",
      policy: POLICY,
      parentRegistryHash: await hashSeriesValue(predecessor.registry),
      receiptHash: await hashSeriesValue(receipt),
    },
  };
}
function insertApproval(f: KrSourceVintagePrivateApprovalV1 | KrSourceVintagePrivateApprovalV2) {
  insert("krSourceVintageApproval", f.registry);
  insert("krSourceVintageReview", f.receipt);
}
it("verifies an append-only successor and selects authority by its explicit activation date", async () => {
  const f = await successorFixture();
  insertApproval(f.predecessor);
  insertApproval(f);
  const before = JSON.stringify(rows);
  expect(await readKrSourceVintageApproval(client, uid, "2026-10-15")).toEqual(f.predecessor);
  expect(await readKrSourceVintageApproval(client, uid, "2026-10-16")).toEqual(f);
  expect(await readKrSourceVintageApproval(client, uid)).toEqual(f);
  expect((await verifyKrSourceVintagePrivateApproval(f)).authorizedRegistryHashes).toEqual([
    await hashSeriesValue(f.predecessor.registry),
    await hashSeriesValue(f.registry),
  ]);
  expect(JSON.stringify(rows)).toBe(before);
  await expect(readKrSourceVintageApproval(client, uid, "invalid")).rejects.toThrow(
    "publication date",
  );
});
it("does not accept a successor without a separately stored predecessor authority", async () => {
  const f = await successorFixture();
  insertApproval(f);
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Incomplete");
  rows.length = 0;
  insertApproval(f.predecessor);
  insert("krSourceVintageReview", f.receipt);
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Incomplete");
});
it.each(["registry", "receipt"] as const)(
  "rejects conflicting successor %s records rather than selecting latest",
  async (key) => {
    const f = await successorFixture();
    insertApproval(f.predecessor);
    insertApproval(f);
    insert(key === "registry" ? "krSourceVintageApproval" : "krSourceVintageReview", {
      ...f[key],
      unknownField: true,
    });
    await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Conflicting");
  },
);
it.each([
  "parentRegistryHash",
  "parentReceiptHash",
  "removed",
  "altered",
  "renamed",
  "reordered",
] as const)("rejects an unproven predecessor transition: %s", async (kind) => {
  const f = await successorFixture();
  if (kind === "parentRegistryHash") f.registry.parentRegistryHash = `sha256:${"c".repeat(64)}`;
  if (kind === "parentReceiptHash") f.receipt.parentReceiptHash = `sha256:${"c".repeat(64)}`;
  if (kind === "removed") f.receipt.reviews.splice(0, 1);
  if (kind === "altered") f.receipt.reviews[0]!.incomingHash = `sha256:${"c".repeat(64)}`;
  if (kind === "renamed") f.receipt.reviews[0]!.id = NEXT_ID;
  if (kind === "reordered")
    [f.receipt.reviews[0], f.receipt.reviews[1]] = [f.receipt.reviews[1]!, f.receipt.reviews[0]!];
  f.registry.receiptHash = await hashSeriesValue(f.receipt);
  insertApproval(f.predecessor);
  insertApproval(f);
  await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("predecessor");
});
it.each(["duplicate", "symbol", "date", "oldSymbol", "unknownKey"] as const)(
  "limits the successor to one finite exact-pair cohort: %s",
  async (kind) => {
    const f = await successorFixture();
    if (kind === "duplicate") f.receipt.reviews.push(f.receipt.reviews[2]!);
    if (kind === "symbol") f.receipt.reviews[3]!.symbol = "UNREVIEWED_COHORT";
    if (kind === "date") f.receipt.reviews[3]!.notBefore = "2026-10-19";
    if (kind === "oldSymbol")
      for (const review of f.receipt.reviews.slice(2)) review.symbol = "SYNTHETIC";
    if (kind === "unknownKey") Object.assign(f.receipt.reviews[2]!, { wildcard: true });
    f.registry.receiptHash = await hashSeriesValue(f.receipt);
    await expect(verifyKrSourceVintagePrivateApproval(f)).rejects.toThrow();
  },
);
