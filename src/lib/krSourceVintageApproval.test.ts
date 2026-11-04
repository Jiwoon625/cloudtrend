import { beforeEach, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readKrSourceVintageApproval } from "./krSourceVintageApproval.server";
import {
  KR_SOURCE_VINTAGE_REVIEW_ID as ID,
  KR_SOURCE_VINTAGE_POLICY as POLICY,
  KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID as NEXT_ID,
  KR_SOURCE_VINTAGE_THIRD_REVIEW_ID as THIRD_ID,
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApprovalV1,
  type KrSourceVintagePrivateApprovalV2,
  type KrSourceVintagePrivateApprovalV3,
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
function insertApproval(f: KrSourceVintagePrivateApproval) {
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

async function thirdFixture(): Promise<KrSourceVintagePrivateApprovalV3> {
  const predecessor = await successorFixture();
  const receipt = {
    version: "kr-source-vintage-review-v3" as const,
    reviewId: THIRD_ID,
    parentReceiptHash: predecessor.registry.receiptHash,
    reviews: [
      ...structuredClone(predecessor.receipt.reviews),
      ...["2026-10-19", "2026-10-20"].map((date) => ({
        ...predecessor.receipt.reviews[0]!,
        id: THIRD_ID,
        symbol: "THIRD_SYNTHETIC",
        date,
        notBefore: "2026-10-21",
        evidenceUrl: "https://kind.krx.co.kr/external/2026/08/07/000001/20260807000001/70129.htm",
      })),
    ],
  };
  return {
    predecessor,
    receipt,
    registry: {
      version: "kr-source-vintage-approval-v3",
      reviewId: THIRD_ID,
      status: "APPROVED",
      policy: POLICY,
      parentRegistryHash: await hashSeriesValue(predecessor.registry),
      receiptHash: await hashSeriesValue(receipt),
    },
  };
}
function insertThird(f: KrSourceVintagePrivateApprovalV3) {
  insertApproval(f.predecessor.predecessor);
  insertApproval(f.predecessor);
  insertApproval(f);
}
it("adds a third exact-pair cohort without rewriting either prior authority or activation boundary", async () => {
  const f = await thirdFixture();
  insertThird(f);
  const before = JSON.stringify(rows);
  expect(await readKrSourceVintageApproval(client, uid, "2026-10-15")).toEqual(
    f.predecessor.predecessor,
  );
  expect(await readKrSourceVintageApproval(client, uid, "2026-10-16")).toEqual(f.predecessor);
  expect(await readKrSourceVintageApproval(client, uid, "2026-10-20")).toEqual(f.predecessor);
  expect(await readKrSourceVintageApproval(client, uid, "2026-10-21")).toEqual(f);
  expect(await readKrSourceVintageApproval(client, uid)).toEqual(f);
  expect((await verifyKrSourceVintagePrivateApproval(f)).authorizedRegistryHashes).toEqual([
    await hashSeriesValue(f.predecessor.predecessor.registry),
    await hashSeriesValue(f.predecessor.registry),
    await hashSeriesValue(f.registry),
  ]);
  expect(JSON.stringify(rows)).toBe(before);
});
it.each(["missingV1", "missingV2", "missingRegistry", "missingReceipt", "wrongOwner"] as const)(
  "requires the full separately stored third-cohort authority: %s",
  async (kind) => {
    const f = await thirdFixture();
    insertThird(f);
    if (kind === "missingV1") rows.splice(0, 2);
    if (kind === "missingV2") rows.splice(2, 2);
    if (kind === "missingRegistry") rows.splice(4, 1);
    if (kind === "missingReceipt") rows.splice(5, 1);
    if (kind === "wrongOwner") rows[4]!["user_id"] = "22222222-2222-4222-8222-222222222222";
    await expect(readKrSourceVintageApproval(client, uid)).rejects.toThrow("Incomplete");
  },
);
it.each(["registry", "receipt"] as const)(
  "rejects conflicting third %s rather than choosing latest",
  async (key) => {
    const f = await thirdFixture();
    insertThird(f);
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
  "reordered",
  "oldSymbol",
  "duplicate",
  "mixedSymbol",
  "mixedDate",
  "earlyDate",
  "empty",
  "unknownKey",
  "tooMany",
] as const)("rejects third-cohort scope expansion or rewritten parent: %s", async (kind) => {
  const f = await thirdFixture(),
    n = f.predecessor.receipt.reviews.length;
  if (kind === "parentRegistryHash") f.registry.parentRegistryHash = `sha256:${"c".repeat(64)}`;
  if (kind === "parentReceiptHash") f.receipt.parentReceiptHash = `sha256:${"c".repeat(64)}`;
  if (kind === "removed") f.receipt.reviews.splice(0, 1);
  if (kind === "altered") f.receipt.reviews[0]!.incomingHash = `sha256:${"c".repeat(64)}`;
  if (kind === "reordered")
    [f.receipt.reviews[0], f.receipt.reviews[1]] = [f.receipt.reviews[1]!, f.receipt.reviews[0]!];
  if (kind === "oldSymbol")
    for (const r of f.receipt.reviews.slice(n)) r.symbol = f.predecessor.receipt.reviews[0]!.symbol;
  if (kind === "duplicate") f.receipt.reviews.push(f.receipt.reviews[n]!);
  if (kind === "mixedSymbol") f.receipt.reviews[n]!.symbol = "OTHER";
  if (kind === "mixedDate") f.receipt.reviews[n]!.notBefore = "2026-10-22";
  if (kind === "earlyDate") for (const r of f.receipt.reviews.slice(n)) r.notBefore = "2026-10-16";
  if (kind === "empty") f.receipt.reviews.splice(n);
  if (kind === "unknownKey") Object.assign(f.receipt.reviews[n]!, { wildcard: true });
  if (kind === "tooMany")
    for (let i = 0; i < 257; i++) f.receipt.reviews.push({ ...f.receipt.reviews[n]! });
  f.registry.receiptHash = await hashSeriesValue(f.receipt);
  await expect(verifyKrSourceVintagePrivateApproval(f)).rejects.toThrow();
});
it.each([
  "http://kind.krx.co.kr/external/2026/08/07/000001/20260807000001/70129.htm",
  "https://kind.krx.co.kr.attacker.invalid/external/2026/08/07/000001/20260807000001/70129.htm",
  "https://kind.krx.co.kr@attacker.invalid/external/2026/08/07/000001/20260807000001/70129.htm",
  "https://kind.krx.co.kr/external/2026/08/07/000001/20260807000001/70129.htm?redirect=other",
  "https://kind.krx.co.kr/",
])("rejects unsupported third-cohort evidence URL %s", async (url) => {
  const f = await thirdFixture();
  f.receipt.reviews.at(-1)!.evidenceUrl = url;
  f.registry.receiptHash = await hashSeriesValue(f.receipt);
  await expect(verifyKrSourceVintagePrivateApproval(f)).rejects.toThrow();
});
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

it.each([
  "id",
  "symbol",
  "date",
  "notBefore",
  "archivedHash",
  "incomingHash",
  "evidenceUrl",
] as const)("rejects non-string third-cohort review field %s", async (field) => {
  for (const malformed of [null, 123456, true, {}, "singleton-array"]) {
    const f = await thirdFixture();
    for (const review of f.receipt.reviews.slice(f.predecessor.receipt.reviews.length)) {
      Object.assign(review, {
        [field]: malformed === "singleton-array" ? [review[field]] : malformed,
      });
    }
    f.registry.receiptHash = await hashSeriesValue(f.receipt);
    await expect(verifyKrSourceVintagePrivateApproval(f)).rejects.toThrow();
  }
});

it.each(["v1", "v2"] as const)(
  "does not extend KIND evidence permission to retained %s",
  async (version) => {
    const f = await thirdFixture();
    const v2 = f.predecessor;
    const v1 = v2.predecessor;
    const kindUrl = f.receipt.reviews.at(-1)!.evidenceUrl;
    if (version === "v1") {
      v1.receipt.reviews[0]!.evidenceUrl = kindUrl;
      v1.registry.receiptHash = await hashSeriesValue(v1.receipt);
      v2.registry.parentRegistryHash = await hashSeriesValue(v1.registry);
      v2.receipt.parentReceiptHash = v1.registry.receiptHash;
      v2.receipt.reviews.splice(
        0,
        v1.receipt.reviews.length,
        ...structuredClone(v1.receipt.reviews),
      );
    } else {
      v2.receipt.reviews[v1.receipt.reviews.length]!.evidenceUrl = kindUrl;
    }
    v2.registry.receiptHash = await hashSeriesValue(v2.receipt);
    f.registry.parentRegistryHash = await hashSeriesValue(v2.registry);
    f.receipt.parentReceiptHash = v2.registry.receiptHash;
    f.receipt.reviews.splice(0, v2.receipt.reviews.length, ...structuredClone(v2.receipt.reviews));
    f.registry.receiptHash = await hashSeriesValue(f.receipt);
    await expect(verifyKrSourceVintagePrivateApproval(f)).rejects.toThrow(
      "Invalid private KR source vintage review",
    );
  },
);

it.each(["v1", "v2"] as const)("blocks a third cohort reusing the %s symbol", async (version) => {
  const f = await thirdFixture();
  const parent = f.predecessor;
  const symbol =
    version === "v1"
      ? parent.predecessor.receipt.reviews[0]!.symbol
      : parent.receipt.reviews.at(-1)!.symbol;
  for (const review of f.receipt.reviews.slice(parent.receipt.reviews.length))
    review.symbol = symbol;
  f.registry.receiptHash = await hashSeriesValue(f.receipt);
  await expect(verifyKrSourceVintagePrivateApproval(f)).rejects.toThrow(
    "third cohort scope changed",
  );
});
