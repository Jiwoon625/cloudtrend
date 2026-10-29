/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  encodeRecoveryEvidence,
  decodeRecoveryEvidence,
  preparationSourceId,
} from "./evidence-storage";
import { operationReader } from "./operation-transport";
const digest = (v: Uint8Array) => "sha256:" + createHash("sha256").update(v).digest("hex");
const receipt = (kind = "PREPARATION") => ({
  version:
    kind === "PREPARATION"
      ? "kr-adjusted-recovery-preparation-v1"
      : "kr-adjusted-recovery-full-plan-v1",
  operationalApproval: false,
  planHash: "sha256:" + "a".repeat(64),
  status: "REVIEW_REQUIRED",
  synthetic: [{ value: 1.5, text: "검증용" }],
  kospi: { result: { plan: null, status: "BLOCKED_ADJUSTED_PREDECESSOR_MISMATCH" } },
});
describe("bounded lossless recovery evidence storage", () => {
  it.each(["PREPARATION", "FULL_PLAN"] as const)(
    "keeps %s logical and storage digest domains distinct",
    async (kind) => {
      const p = receipt(kind),
        a = await encodeRecoveryEvidence(p, kind),
        b = await encodeRecoveryEvidence(p, kind);
      expect(a).toEqual(b);
      expect(a.storageHash).not.toBe(a.receiptHash);
      expect(a.storageHash).toBe(await hashSeriesValue(a.payload));
      expect(a.receiptHash).toBe(await hashSeriesValue(p));
      expect(await decodeRecoveryEvidence(a.payload, a.storageHash, a.receiptHash, kind)).toEqual(
        p,
      );
      expect(await decodeRecoveryEvidence(p, a.receiptHash, a.receiptHash, kind)).toEqual(p);
    },
  );
  it("roundtrips a representative 11.62MB structured private candidate without JSONB expansion", async () => {
    const p: any = receipt();
    p.rows = Array.from({ length: 42000 }, (_, i) => ({
      id: i,
      symbol: "SYNTHETIC-" + i,
      date: "2026-10-23",
      open: i + 0.5,
      close: i + 1.5,
      quantity: String(i),
      policy: "SYNTHETIC_NO_APPROVAL",
      fields: { a: null, b: false, c: [i, i + 1] },
      description: "repeated structured evidence, not live data",
    }));
    p.padding = "";
    const target = 11621106,
      n = Buffer.byteLength(canonicalSeriesJson(p));
    expect(n).toBeLessThan(target);
    p.padding = "x".repeat(target - n);
    const a = await encodeRecoveryEvidence(p, "PREPARATION");
    expect(a.uncompressedBytes).toBe(target);
    expect(a.storedBytes).toBeLessThan(2 * 1024 * 1024);
    expect(
      await decodeRecoveryEvidence(a.payload, a.storageHash, a.receiptHash, "PREPARATION"),
    ).toEqual(p);
  }, 30000);
  it.each([
    "outer",
    "inner",
    "base64",
    "compressedHash",
    "length",
    "oversize",
    "kind",
    "extra",
    "canonical",
    "bomb",
  ])("rejects %s corruption or mismatched authority", async (mode) => {
    const a = await encodeRecoveryEvidence(receipt(), "PREPARATION"),
      p: any = structuredClone(a.payload);
    let storageHash = a.storageHash,
      inner = a.receiptHash;
    if (mode === "outer") storageHash = "sha256:" + "a".repeat(64);
    else if (mode === "inner") inner = "sha256:" + "a".repeat(64);
    else if (mode === "base64") p.payload = "!!!!";
    else if (mode === "compressedHash") p.compressedHash = "sha256:" + "a".repeat(64);
    else if (mode === "length") p.uncompressedBytes++;
    else if (mode === "oversize") p.uncompressedBytes = 24 * 1024 * 1024 + 1;
    else if (mode === "kind") p.evidenceKind = "FULL_PLAN";
    else if (mode === "extra") p.unapprovedField = true;
    else {
      const raw = Buffer.from(
        mode === "bomb" ? "x".repeat(4096) : JSON.stringify(receipt(), null, 2),
      );
      const bytes = gzipSync(raw);
      p.payload = bytes.toString("base64");
      p.compressedBytes = bytes.length;
      p.compressedHash = digest(bytes);
      p.receiptHash = digest(raw);
      inner = p.receiptHash;
      p.uncompressedBytes = mode === "bomb" ? 1 : raw.length;
    }
    if (mode !== "outer") storageHash = await hashSeriesValue(p);
    await expect(decodeRecoveryEvidence(p, storageHash, inner, "PREPARATION")).rejects.toThrow();
  });
  it("keys distinct candidates of one immutable read plan without latest or legacy fallback", () => {
    const p = "sha256:" + "a".repeat(64),
      a = "sha256:" + "b".repeat(64),
      b = "sha256:" + "c".repeat(64);
    expect(preparationSourceId(p, a)).not.toBe(preparationSourceId(p, b));
    expect(preparationSourceId(p, a)).toBe(
      "kr-adjusted-recovery-preparation:" + p.slice(7) + ":" + a.slice(7),
    );
    expect(() => preparationSourceId("latest", a)).toThrow();
    expect(() => preparationSourceId(p, "self-approved")).toThrow();
  });
  it("hydrates only approved evidence namespaces and exposes digest identities honestly", async () => {
    const p = receipt(),
      a = await encodeRecoveryEvidence(p, "PREPARATION"),
      identity = "sha256:" + "a".repeat(64),
      owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const calls: any[] = [];
    const r = operationReader({
      origin: "https://synthetic.supabase.co",
      key: "synthetic",
      owner,
      fetcher: async (url: any, init: any) => {
        calls.push(init.method);
        expect(new URL(url).searchParams.get("source_id")).toBe(
          "eq." + preparationSourceId(identity, a.receiptHash),
        );
        return new Response(
          JSON.stringify([
            {
              user_id: owner,
              source_id:
                "kr-adjusted-recovery-preparation:" +
                identity.slice(7) +
                ":" +
                a.receiptHash.slice(7),
              source_revision: "1",
              source_hash: a.storageHash,
              payload: a.payload,
              recorded_at: "2026-10-28T13:00:00Z",
            },
          ]),
        );
      },
    });
    const hydrated = await r.archive("kr-adjusted-recovery-preparation:", identity, a.receiptHash);
    expect(hydrated.payload).toEqual(p);
    expect(hydrated.storageHash).toBe(a.storageHash);
    expect(hydrated.receiptHash).toBe(a.receiptHash);
    expect(hydrated).not.toHaveProperty("source_hash");
    expect(calls).toEqual(["GET"]);
    await expect(
      r.archive("kr-adjusted-recovery-operation-input:", identity, a.receiptHash),
    ).rejects.toThrow();
  });
});
