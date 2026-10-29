/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { appendOperationPlan } from "./operation-transport";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { FULL_PLAN, OPERATION_MANIFEST } from "./operation-schema";
import { encodeRecoveryEvidence } from "./evidence-storage";
import { appendPreparation, PREPARATION } from "./transport";
import { decodeRecoveryEvidence, preparationSourceId } from "./evidence-storage";
import { APPEND_PHASES, publicAppendObservation } from "./append-phases";
const gate = vi.hoisted(() => ({ check: vi.fn(async () => {}) }));
vi.mock("./freshness", () => ({ recheckPreparationPins: gate.check }));
// This suite isolates persistence only; genuine authority/model planning is covered by the 97-case engine suite.
vi.mock("./operation-schema", async (load) => ({
  ...(await load<typeof import("./operation-schema")>()),
  validateOperationManifest: vi.fn(async () => {}),
  verifyFullRecoveryPlan: vi.fn(async () => {}),
}));
const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  hash = "sha256:" + "a".repeat(64);
const payload = {
  version: "kr-adjusted-recovery-preparation-v1",
  kind: "RECOVERY_PREPARATION_ONLY",
  status: "REVIEW_REQUIRED",
  operationalApproval: false,
  historicalAvailabilityClaim: false,
  planHash: hash,
  capsuleHash: hash,
};
beforeEach(() => {
  gate.check.mockReset().mockResolvedValue(undefined);
});
describe("sole evidence append after independent fresh-pin gate", () => {
  it.each([false, true])(
    "does exactly one fixed POST, including lost response=%s",
    async (uncertain) => {
      let saved: any = null;
      const calls: any[] = [];
      const fetcher = async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        if (init.method === "POST") {
          expect(gate.check).toHaveBeenCalledTimes(1);
          saved = JSON.parse(init.body);
          if (uncertain) throw new Error("synthetic lost response after commit");
          return new Response(null, { status: 201 });
        }
        return new Response(JSON.stringify(saved ? [saved] : []), { status: 200 });
      };
      const result = await appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload,
        expectedPlanHash: hash,
        expectedCapsuleHash: hash,
        fetcher: fetcher as any,
      });
      expect(result.reused).toBe(false);
      expect(calls.map((c) => c.init.method)).toEqual(["GET", "POST", "GET"]);
      const write = calls[1];
      expect(write.url).toBe("https://synthetic.supabase.co/rest/v1/ledger_provenance_archive");
      expect(write.init.redirect).toBe("error");
      expect(write.init.headers.Prefer).toBe("return=minimal");
      expect(saved.user_id).toBe(owner);
      expect(saved.source_id).toBe(preparationSourceId(hash, result.hash));
      expect(saved.source_revision).toBe("1");
      expect(
        await decodeRecoveryEvidence(saved.payload, saved.source_hash, result.hash, "PREPARATION"),
      ).toEqual(payload);
      expect(saved.payload.operationalApproval).toBe(false);
    },
  );
  it("preserves a blocked receipt when a later candidate of the same plan is appended", async () => {
    const saved = new Map<string, any>(),
      calls: string[] = [];
    const fetcher = async (url: any, init: any) => {
      calls.push(init.method);
      if (init.method === "POST") {
        const row = JSON.parse(init.body);
        expect(saved.has(row.source_id)).toBe(false);
        saved.set(row.source_id, row);
        return new Response(null, { status: 201 });
      }
      const id = new URL(url).searchParams.get("source_id")!.slice(3);
      return new Response(JSON.stringify(saved.has(id) ? [saved.get(id)] : []));
    };
    const options = {
      origin: "https://synthetic.supabase.co",
      key: "synthetic",
      owner,
      expectedPlanHash: hash,
      expectedCapsuleHash: hash,
      fetcher: fetcher as any,
    };
    const first = await appendPreparation({ ...options, payload });
    const secondPayload = { ...payload, diagnosticIteration: "CHANGED_GENERIC_CODE_NOT_APPROVAL" };
    const second = await appendPreparation({ ...options, payload: secondPayload });
    expect(second.hash).not.toBe(first.hash);
    expect(saved.size).toBe(2);
    expect((await appendPreparation({ ...options, payload })).reused).toBe(true);
    expect(calls.filter((x) => x === "POST")).toHaveLength(2);
    expect(
      await decodeRecoveryEvidence(
        saved.get(preparationSourceId(hash, first.hash)).payload,
        first.storageHash,
        first.hash,
        "PREPARATION",
      ),
    ).toEqual(payload);
  });
  it("retains the original logical full-row cap before compression or any fetch", async () => {
    const large = { ...payload, padding: "x".repeat(24 * 1024 * 1024 - 600) };
    const fetcher = vi.fn(async () => new Response("[]"));
    await expect(
      appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload: large,
        expectedPlanHash: hash,
        expectedCapsuleHash: hash,
        fetcher: fetcher as any,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fresh-pin rejection performs no POST", async () => {
    gate.check.mockRejectedValue(new Error("changed authoritative state"));
    const fetcher = vi.fn(async () => new Response("[]", { status: 200 }));
    await expect(
      appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload,
        expectedPlanHash: hash,
        expectedCapsuleHash: hash,
        fetcher: fetcher as any,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as any)[1].method).toBe("GET");
  });
  it("uncertain failure without readback never retries the INSERT", async () => {
    const calls: string[] = [];
    const fetcher = async (_: any, init: any) => {
      calls.push(init.method);
      if (init.method === "POST") throw new Error("failed");
      return new Response("[]", { status: 200 });
    };
    await expect(
      appendPreparation({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        payload,
        expectedPlanHash: hash,
        expectedCapsuleHash: hash,
        fetcher: fetcher as any,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(["GET", "POST", "GET"]);
  });
  it.each([401, 403, 409, 413, 500])(
    "reports safe HTTP %s and performs only one POST before mandatory readback",
    async (status) => {
      const calls: string[] = [],
        phases: string[] = [],
        observations: any[] = [];
      const fetcher = async (_: any, init: any) => {
        calls.push(init.method);
        return init.method === "POST"
          ? new Response("PRIVATE ERROR BODY MUST NOT BE FORWARDED", { status })
          : new Response("[]");
      };
      await expect(
        appendPreparation({
          origin: "https://synthetic.supabase.co",
          key: "synthetic",
          owner,
          payload,
          expectedPlanHash: hash,
          expectedCapsuleHash: hash,
          fetcher,
          onPhase: (p) => phases.push(p),
          onObservation: (o) => observations.push(publicAppendObservation(o)),
        }),
      ).rejects.toThrow();
      expect(calls).toEqual(["GET", "POST", "GET"]);
      expect(phases.at(-1)).toBe("APPEND_READBACK_PRESENT");
      expect(phases.every((p) => APPEND_PHASES.includes(p as any))).toBe(true);
      expect(observations.at(-1).httpStatus).toBe(status);
      expect(JSON.stringify(observations)).not.toContain("PRIVATE");
      expect(observations[0].payloadBytes).toBeGreaterThan(0);
    },
  );
  it("sanitizes observations rather than forwarding arbitrary fields or non-finite values", () => {
    expect(
      publicAppendObservation({
        payloadBytes: NaN,
        httpStatus: 999,
        postResponse: "secret" as any,
        secret: "private",
      } as any),
    ).toEqual({});
  });
});

describe("lossless full-plan persistence boundary", () => {
  it.each(["success", "lost-after-commit", "timeout-no-commit"])(
    "one INSERT and exact readback: %s",
    async (outcome) => {
      const prepHash = await hashSeriesValue(payload),
        prep = await encodeRecoveryEvidence(payload, "PREPARATION");
      const manifest: any = {
        preparationReadPlanHash: hash,
        preparationHash: prepHash,
        capsuleHash: hash,
        modelInventory: [],
        currentSources: [],
        actualLedgers: [],
      };
      const manifestHash = await hashSeriesValue(manifest),
        plan = {
          version: "kr-adjusted-recovery-full-plan-v1",
          operationalApproval: false,
          manifestHash,
          synthetic: [1, 2, 3],
        };
      let saved: any = null;
      const calls: string[] = [];
      const fetcher = async (url: any, init: any) => {
        calls.push(init.method);
        if (init.method === "POST") {
          expect(String(url)).toBe(
            "https://synthetic.supabase.co/rest/v1/ledger_provenance_archive",
          );
          if (outcome === "timeout-no-commit") return new Response(null, { status: 500 });
          saved = JSON.parse(init.body);
          if (outcome === "lost-after-commit") throw new Error("synthetic uncertain response");
          return new Response(null, { status: 201 });
        }
        const sourceId = new URL(url).searchParams.get("source_id")?.slice(3);
        const row =
          sourceId === OPERATION_MANIFEST + manifestHash.slice(7)
            ? { source_hash: manifestHash, payload: manifest }
            : sourceId === preparationSourceId(hash, prepHash)
              ? {
                  user_id: owner,
                  source_id: sourceId,
                  source_revision: "1",
                  source_hash: prep.storageHash,
                  payload: prep.payload,
                }
              : sourceId === FULL_PLAN + manifestHash.slice(7)
                ? saved
                : null;
        return new Response(JSON.stringify(row ? [row] : []));
      };
      const options = {
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        manifestHash,
        manifest,
        preparation: payload,
        payload: plan,
        fetcher: fetcher as any,
      };
      if (outcome === "timeout-no-commit")
        await expect(appendOperationPlan(options)).rejects.toThrow();
      else {
        const result = await appendOperationPlan(options);
        expect(result.hash).toBe(await hashSeriesValue(plan));
        expect(
          await decodeRecoveryEvidence(saved.payload, saved.source_hash, result.hash, "FULL_PLAN"),
        ).toEqual(plan);
        expect((await appendOperationPlan(options)).reused).toBe(true);
      }
      expect(calls.filter((x) => x === "POST")).toHaveLength(1);
      expect(calls.at(-1)).toBe("GET");
    },
  );
});
