/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { appendPreparation, PREPARATION } from "./transport";
const gate = vi.hoisted(() => ({ check: vi.fn(async () => {}) }));
vi.mock("./freshness", () => ({ recheckPreparationPins: gate.check }));
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
      expect(saved.source_id).toBe(PREPARATION + hash.slice(7));
      expect(saved.source_revision).toBe("1");
      expect(saved.payload).toEqual(payload);
      expect(saved.payload.operationalApproval).toBe(false);
    },
  );
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
});
