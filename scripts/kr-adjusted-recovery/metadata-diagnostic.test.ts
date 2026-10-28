/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
// Transport-unit isolation only; the existing real capsule/vintage validator suites remain mandatory.
vi.mock("../kr-vintage-preflight/transport", async (load) => ({
  ...(await load<any>()),
  validateCapsule: async (row: any) => row.payload,
}));
vi.mock("../../src/lib/ledger/krSourceVintage", () => ({
  verifyKrSourceVintagePrivateApproval: async () => ({}),
}));
import { diagnosePreparationMetadata, PLAN } from "./transport";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  h = "sha256:" + "a".repeat(64);
async function fixture() {
  const scope = {
    symbol: "999999",
    predecessorDate: "2026-10-23",
    dates: ["2026-10-26", "2026-10-27"],
  };
  const emptyHash = await hashSeriesValue({});
  const p = {
    version: "kr-adjusted-recovery-read-plan-v1",
    kind: "RECOVERY_PREPARATION_PLAN_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    capsuleHash: h,
    preparedAt: "2026-10-28T10:00:00Z",
    scope,
    corporateActionEvidenceUrl: "https://dart.fss.or.kr/synthetic",
    models: ["ETF_V02", "KR_KOSDAQ", "KR_KOSPI", "KR_KOSPI_CONFIRM1_BEAR", "KR_MIXED"].map((k) => ({
      seriesId: "adopted-shadow-2026-10-12-v1:" + k,
      sessionDate: scope.predecessorDate,
      stateHash: h,
      payloadHash: h,
    })),
    archives: Array.from({ length: 13 }, (_, i) => {
      const date = `2026-10-${String(i + 1).padStart(2, "0")}`;
      return {
        date,
        sourceId: `october-input:KR:${date}:${h.slice(7)}`,
        sourceRevision: "1",
        sourceHash: h,
        payloadHash: h,
      };
    }),
    vintageV1: { registry: {}, receipt: {}, registryHash: emptyHash, receiptHash: emptyHash },
    kospi: {
      expectedPredecessorDate: scope.predecessorDate,
      revisionId: "october14-retrospective-v1",
      objects: Array.from({ length: 19 }, (_, i) => ({
        path:
          owner +
          `/shadow/kospi-confirm1-bear-rsaccel-v1/sessions/2026-10-${String(i + 1).padStart(2, "0")}.json`,
        metadata: {
          id: "synthetic-" + i,
          version: "synthetic-generation",
          eTag: '"opaque-3"',
          size: 10,
          updatedAt: "2026-10-28T10:00:00.481345Z",
        },
      })),
    },
  };
  const planHash = await hashSeriesValue(p);
  return {
    p,
    planHash,
    plan: {
      user_id: owner,
      source_id: PLAN + h.slice(7),
      source_revision: "1",
      source_hash: planHash,
      payload: p,
    },
    capsule: {
      source_hash: h,
      payload: {
        readPlan: {
          scope: {
            symbol: scope.symbol,
            targetDate: scope.dates[0],
            baselineAsOfDate: scope.dates[1],
          },
        },
      },
    },
  };
}
describe("bounded read-only metadata diagnosis", () => {
  it.each([false, true])(
    "makes only21 GETs, no source download or write, clock mismatch=%s",
    async (mismatch) => {
      const f = await fixture(),
        calls: any[] = [];
      const fetcher = async (url: any, init: any) => {
        const u = new URL(url);
        calls.push({ url: String(url), method: init.method });
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        if (u.pathname.startsWith("/rest/v1/"))
          return new Response(
            JSON.stringify([
              u.searchParams.get("source_id")!.startsWith("like.") ? f.capsule : f.plan,
            ]),
          );
        const i = Number(u.pathname.match(/2026-10-(\d+)\.json$/)![1]) - 1,
          pin = f.p.kospi.objects[i].metadata;
        return new Response(
          JSON.stringify({
            id: pin.id,
            version: pin.version,
            etag: pin.eTag,
            size: pin.size,
            last_modified: mismatch ? "2026-10-28T10:00:01.000Z" : pin.updatedAt,
          }),
          { headers: { "last-modified": "Wed, 28 Oct 2026 10:00:01 GMT" } },
        );
      };
      const result = await diagnosePreparationMetadata({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        capsuleHash: h,
        planHash: f.planHash,
        fetcher: fetcher as any,
      });
      expect(calls).toHaveLength(21);
      expect(calls.slice(2).every((c) => c.url.includes("/object/info/cloudtrend-data/"))).toBe(
        true,
      );
      expect(result.objectCount).toBe(19);
      expect(result.allPinnedChecksPass).toBe(!mismatch);
      expect(result.operationalApproval).toBe(false);
      const output = JSON.stringify(result);
      for (const secret of [
        owner,
        "synthetic-generation",
        "opaque-3",
        "2026-10-28",
        "/shadow/",
        "999999",
      ])
        expect(output).not.toContain(secret);
      expect(result.objects[0]).toMatchObject({
        ordinal: 0,
        readSucceeded: true,
        rawLastModifiedMinusDbMs: mismatch ? 519 : 0,
        httpLastModifiedMinusDbMs: 519,
      });
    },
  );
  it("does not expose errors or retry failed metadata reads", async () => {
    const f = await fixture(),
      calls: string[] = [];
    const fetcher = async (url: any, init: any) => {
      const u = new URL(url);
      calls.push(init.method);
      if (u.pathname.startsWith("/rest/v1/"))
        return new Response(
          JSON.stringify([
            u.searchParams.get("source_id")!.startsWith("like.") ? f.capsule : f.plan,
          ]),
        );
      throw Error("PRIVATE_CONTENT_AND_PATH");
    };
    const result = await diagnosePreparationMetadata({
      origin: "https://synthetic.supabase.co",
      key: "synthetic",
      owner,
      capsuleHash: h,
      planHash: f.planHash,
      fetcher: fetcher as any,
    });
    expect(calls).toHaveLength(21);
    expect(result.allReadsSucceeded).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTENT");
  });
  it("rejects the wrong external plan hash before any object info read", async () => {
    const f = await fixture(),
      urls: string[] = [];
    const fetcher = async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify([urls.length === 1 ? f.capsule : f.plan]));
    };
    await expect(
      diagnosePreparationMetadata({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        capsuleHash: h,
        planHash: "sha256:" + "b".repeat(64),
        fetcher: fetcher as any,
      }),
    ).rejects.toThrow();
    expect(urls).toHaveLength(2);
  });
  it("workflow diagnosis skips materialize, compute and append", () => {
    const w = fs.readFileSync(".github/workflows/kr-adjusted-recovery-preparation.yml", "utf8");
    expect(w).toContain("if: inputs.mode == 'diagnose'");
    expect(w.match(/if: inputs.mode == 'prepare'/g)).toHaveLength(3);
    expect(w).toContain("PREPARATION_MODE_REJECTED");
    expect(w).not.toContain("upload-artifact");
    expect(w).toContain("if: always()");
  });
});
