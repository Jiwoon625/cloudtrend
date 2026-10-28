/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { containsTargetSymbol } from "./prepare";
import { verifyObjectGeneration, appendPreparation, validatePreparationPlan } from "./transport";
import { verifyPreparationPayload } from "./verify";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { createReadOnlyTransport } from "../kr-vintage-preflight/transport";
const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  H = "sha256:" + "a".repeat(64);
describe("preparation-only boundaries", () => {
  it.each([
    { state: { positions: [{ symbol: "999999" }] } },
    { state: { pendingExits: { "999999": { date: "2026-10-23" } } } },
    { receipts: [{ record: { fills: [{ symbol: "999999" }] } }] },
    { markets: { K: { holdingWindows: [{ symbol: "999999", exitDate: "2026-10-20" }] } } },
    { state: { positions: { "999999": { quantity: "1" } } } },
  ])("finds nested and key-only exposure", (value) =>
    expect(containsTargetSymbol(value, "999999")).toBe(true),
  );
  it("does not treat an unheld quote map key as economic exposure", () =>
    expect(containsTargetSymbol({ quotes: { "999999": { price: 10 } } }, "999999")).toBe(false));
  const pin = {
    id: "id",
    version: "generation",
    eTag: "opaque-multipart-token-3",
    size: 10,
    updatedAt: "2026-10-28T10:00:00Z",
  };
  const info = {
    id: "id",
    version: "generation",
    etag: '"opaque-multipart-token-3"',
    size: 10,
    last_modified: "2026-10-28T10:00:00.000Z",
  };
  it("treats ETag as opaque generation identity, not MD5", () =>
    expect(() => verifyObjectGeneration(info, pin)).not.toThrow());
  it.each(["id", "version", "etag", "size", "last_modified"])(
    "rejects changed object %s generation",
    (key) => expect(() => verifyObjectGeneration({ ...info, [key]: "changed" }, pin)).toThrow(),
  );
  it("keeps the DB-alias timestamp guard and rejects a backend-header substitution", () => {
    const databasePin = { ...pin, updatedAt: "2026-10-28T10:00:00.481345Z" };
    expect(() =>
      verifyObjectGeneration({ ...info, last_modified: databasePin.updatedAt }, databasePin),
    ).not.toThrow();
    expect(() =>
      verifyObjectGeneration({ ...info, last_modified: "2026-10-28T10:00:01.000Z" }, databasePin),
    ).toThrow();
  });
  it("logs only code-selected read phases, not caught errors or private values", () => {
    const entry = fs.readFileSync("scripts/kr-adjusted-recovery/entry.ts", "utf8");
    const transport = fs.readFileSync("scripts/kr-adjusted-recovery/transport.ts", "utf8");
    expect(entry).toContain("phase: failurePhase");
    expect(entry).not.toContain("error.message");
    expect(entry).not.toContain("console.error");
    const calls = [...transport.matchAll(/options\.onPhase\?\.\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBe(18);
    expect(calls.every((value) => /^"[A-Z_]+"$/.test(value!))).toBe(true);
    expect(calls).toContain('"CAPSULE_READ"');
    expect(calls).toContain('"LEGACY_INFO_VALIDATION"');
    expect(calls).toContain('"ARCHIVE_PREFIX_VALIDATION"');
  });
  it("rejects unreviewed/self-hashed or conflicting plan owner/hash before any fetch", async () => {
    await expect(
      validatePreparationPlan(
        { user_id: owner, source_revision: "1", source_id: "wrong", source_hash: H, payload: {} },
        owner,
        H,
        H,
      ),
    ).rejects.toThrow();
  });
  it("rejects malformed/private result or an approval-shaped payload", async () => {
    await expect(
      verifyPreparationPayload(
        {
          version: "kr-adjusted-recovery-preparation-v1",
          kind: "RECOVERY_PREPARATION_ONLY",
          status: "APPROVED",
          operationalApproval: true,
        },
        H,
        H,
      ),
    ).rejects.toThrow();
  });
  it("rejects preparation input before any write on uncertain/missing authority", async () => {
    const fetcher = vi.fn(async () => new Response("[]", { status: 200 }));
    const payload = {
      version: "kr-adjusted-recovery-preparation-v1",
      kind: "RECOVERY_PREPARATION_ONLY",
      status: "REVIEW_REQUIRED",
      operationalApproval: false,
      planHash: H,
      capsuleHash: H,
    };
    await expect(
      appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload,
        expectedPlanHash: H,
        expectedCapsuleHash: H,
        fetcher: fetcher as any,
      }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.every((c) => (c as any)[1].method === "GET")).toBe(true);
  });
  it("fails conflicting existing receipt and does not insert", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify([{ source_hash: H, payload: { other: true } }]), {
          status: 200,
        }),
    );
    await expect(
      appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload: {
          version: "kr-adjusted-recovery-preparation-v1",
          kind: "RECOVERY_PREPARATION_ONLY",
          status: "REVIEW_REQUIRED",
          operationalApproval: false,
          planHash: H,
          capsuleHash: H,
        },
        expectedPlanHash: H,
        expectedCapsuleHash: H,
        fetcher: fetcher as any,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reuses exact previously appended preparation without duplicate INSERT", async () => {
    const payload = {
      version: "kr-adjusted-recovery-preparation-v1",
      kind: "RECOVERY_PREPARATION_ONLY",
      status: "REVIEW_REQUIRED",
      operationalApproval: false,
      planHash: H,
      capsuleHash: H,
    };
    const hash = await hashSeriesValue(payload),
      fetcher = vi.fn(
        async () => new Response(JSON.stringify([{ source_hash: hash, payload }]), { status: 200 }),
      );
    expect(
      await appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload,
        expectedPlanHash: H,
        expectedCapsuleHash: H,
        fetcher: fetcher as any,
      }),
    ).toEqual({ reused: true, hash });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("GET transport cannot be converted into a writer or redirect escape", async () => {
    const p = "/rest/v1/ledger_model_sessions?synthetic=1",
      fetcher = vi.fn();
    const read = createReadOnlyTransport(
      "https://synthetic.supabase.co",
      "synthetic",
      new Set([p]),
      fetcher,
    );
    await expect(read(p, 100, "POST" as any)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("workflow is main/manual only, no artifacts, step-scoped secrets and unconditional cleanup", () => {
    const source = fs.readFileSync(
      ".github/workflows/kr-adjusted-recovery-preparation.yml",
      "utf8",
    );
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toContain("upload-artifact");
    expect(source).not.toContain("schedule:");
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain("if: always()");
    const compute = source.split("- name: Prepare counterfactual")[1]!.split("- name: Append")[0]!;
    expect(compute).not.toContain("SUPABASE");
  });
});
