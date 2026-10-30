/* eslint-disable @typescript-eslint/no-explicit-any -- malformed synthetic transport fixtures */
import { describe, it, expect } from "vitest";
import {
  reader,
  normalizeGeneration,
  encodeEvidence,
  decodeEvidence,
  appendEvidence,
  validateRequest,
  snapshot,
} from "./transport";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
const owner = "11111111-1111-4111-8111-111111111111";
const origin = "https://example.supabase.co";
const hash = "sha256:" + "a".repeat(64);
const generation = {
  id: "object",
  version: "generation",
  eTag: "etag",
  size: 2,
  updatedAt: "2026-10-30T01:00:00.000Z",
};
const info = {
  id: "object",
  version: "generation",
  etag: '"etag"',
  size: 2,
  last_modified: generation.updatedAt,
};
describe("new retrospective transport boundary", () => {
  it("normalizes exact identity metadata and rejects absent generation", () => {
    expect(normalizeGeneration(info)).toEqual(generation);
    expect(() => normalizeGeneration({ ...info, version: null })).toThrow();
  });
  it("forces owner filter and GET only for rows", async () => {
    let seen = "";
    const r = reader({
      origin,
      key: "test",
      owner,
      fetcher: async (url, init) => {
        seen = String(url);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect((init?.headers as any)["Accept-Encoding"]).toBe("identity");
        return new Response(JSON.stringify([{ user_id: owner }]), { status: 200 });
      },
    });
    expect(await r.rows("portfolio_ledgers", {}, 2)).toHaveLength(1);
    expect(new URL(seen).searchParams.get("user_id")).toBe("eq." + owner);
    await expect(r.rows("auth.users", {}, 2)).rejects.toThrow();
    await expect(r.rows("portfolio_ledgers", { user_id: "eq.attacker" }, 2)).rejects.toThrow();
  });
  it("rejects foreign rows and truncation rather than partial inventory", async () => {
    for (const rows of [[{ user_id: "foreign" }], [{ user_id: owner }, { user_id: owner }]]) {
      const r = reader({
        origin,
        key: "test",
        owner,
        fetcher: async () => new Response(JSON.stringify(rows)),
      });
      await expect(r.rows("portfolio_ledgers", {}, 2)).rejects.toThrow();
    }
  });
  it("pins info before and after object bytes", async () => {
    const calls: string[] = [];
    const r = reader({
      origin,
      key: "test",
      owner,
      fetcher: async (url) => {
        calls.push(String(url));
        return new Response(String(url).includes("/info/") ? JSON.stringify(info) : "{}");
      },
    });
    const result = await r.object(owner + "/source.json", undefined, generation);
    expect(result.bytes.toString()).toBe("{}");
    expect(calls.length).toBe(3);
  });
  it("rejects generation drift and cross-owner object paths", async () => {
    let n = 0;
    const r = reader({
      origin,
      key: "test",
      owner,
      fetcher: async (url) =>
        new Response(
          String(url).includes("/info/")
            ? JSON.stringify({ ...info, version: ++n === 1 ? "generation" : "changed" })
            : "{}",
        ),
    });
    await expect(r.object(owner + "/source.json")).rejects.toThrow();
    await expect(r.object("foreign/source.json")).rejects.toThrow();
    await expect(r.object(owner + "/../secret")).rejects.toThrow();
  });
  it("evidence binds compressed and logical domains", async () => {
    const value = {
      version: "kr-final-retrospective-plan-v1",
      operationalApproval: false,
      proof: [1, 2, 3],
    };
    const e = await encodeEvidence(value);
    expect(await decodeEvidence(e.envelope, e.storageHash, e.hash)).toEqual(value);
    await expect(
      decodeEvidence({ ...e.envelope, payload: "AAAA" }, e.storageHash, e.hash),
    ).rejects.toThrow();
    await expect(decodeEvidence(e.envelope, e.storageHash, hash)).rejects.toThrow();
  });
  it("rejects oversize declared gzip output before inflation", async () => {
    const e = await encodeEvidence({ test: true });
    const invalid = { ...e.envelope, bytes: 1024 * 1024 * 1024 };
    await expect(decodeEvidence(invalid, await hashSeriesValue(invalid), e.hash)).rejects.toThrow();
  });
  it("unknown POST outcome is resolved by exact readback without retry", async () => {
    let saved: any = null,
      posts = 0;
    const value = { version: "test", historicalAvailabilityClaim: false };
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        saved = JSON.parse(String(init.body));
        throw new Error("network after commit");
      }
      return new Response(JSON.stringify(saved ? [saved] : []));
    };
    const o = { origin, key: "test", owner, fetcher };
    await appendEvidence(o, "plan", value);
    expect(posts).toBe(1);
    await appendEvidence(o, "plan", value);
    expect(posts).toBe(1);
  });
  it("failed append does not retry or claim success", async () => {
    let posts = 0;
    await expect(
      appendEvidence(
        {
          origin,
          key: "test",
          owner,
          fetcher: async (_url, init) => {
            if (init?.method === "POST") {
              posts++;
              return new Response("", { status: 500 });
            }
            return new Response("[]");
          },
        },
        "plan",
        { test: 1 },
      ),
    ).rejects.toThrow();
    expect(posts).toBe(1);
  });
  it("validates exact request hash and forbids operational/preopen claims", async () => {
    const request: any = {
      version: "kr-final-retrospective-request-v1",
      owner,
      codeCommit: "b".repeat(40),
      operationalApproval: false,
      historicalAvailabilityClaim: false,
      modelInventoryProjection: "series-date-state-recorded-v1",
      predecessorDate: "2026-10-27",
      targetDates: ["2026-10-28", "2026-10-29"],
      preparedAt: "2026-10-30T01:00:00Z",
      config: {},
      expected: { sources: hash, models: hash, registries: hash, actual: hash },
      legacy: [
        { path: owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/latest.json", hash, generation },
      ],
    };
    expect(
      await validateRequest(request, await hashSeriesValue(request), owner, request.codeCommit),
    ).toBe(request);
    for (const patch of [
      { historicalAvailabilityClaim: true },
      { owner: "other" },
      { codeCommit: "c".repeat(40) },
      { targetDates: [] },
    ]) {
      const changed = { ...request, ...patch };
      await expect(
        validateRequest(changed, await hashSeriesValue(changed), owner, request.codeCommit),
      ).rejects.toThrow();
    }
  });
  it("full snapshot enforces row-count bounds and ownership", async () => {
    const fetcher: typeof fetch = async (url) =>
      new Response(
        JSON.stringify([
          {
            user_id: owner,
            ...(String(url).includes("analysis_source_files") ? { id: "source" } : {}),
          },
        ]),
      );
    const s = await snapshot({ origin, key: "test", owner, fetcher });
    expect(s.sources).toHaveLength(1);
    expect(s.actual.portfolio_ledgers).toHaveLength(1);
  });
});

describe("legacy namespace inventory", () => {
  it("lists only bounded owner legacy prefix using read-only POST", async () => {
    const { legacyInventory } = await import("./transport");
    const bodies: any[] = [];
    const paths = await legacyInventory({
      origin,
      key: "test",
      owner,
      fetcher: async (url, init) => {
        expect(String(url)).toBe(origin + "/storage/v1/object/list/cloudtrend-data");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(
          JSON.stringify(
            body.prefix.endsWith("/sessions")
              ? [{ name: "2026-10-27.json", id: "obj" }]
              : [
                  { name: "sessions", id: null },
                  { name: "latest.json", id: "obj" },
                ],
          ),
        );
      },
    });
    expect(paths).toHaveLength(2);
    expect(
      bodies.every((x) => x.prefix.startsWith(owner + "/shadow/kospi-confirm1-bear-rsaccel-v1")),
    ).toBe(true);
  });
  it("rejects traversal, oversized inventory and failed listing", async () => {
    const { legacyInventory } = await import("./transport");
    for (const value of [
      [{ name: "../escape", id: null }],
      Array.from({ length: 257 }, (_, i) => ({ name: String(i), id: "obj" })),
    ])
      await expect(
        legacyInventory({
          origin,
          key: "test",
          owner,
          fetcher: async () => new Response(JSON.stringify(value)),
        }),
      ).rejects.toThrow();
    await expect(
      legacyInventory({
        origin,
        key: "test",
        owner,
        fetcher: async () => new Response("", { status: 403 }),
      }),
    ).rejects.toThrow();
  });
});

describe("preservation guards", () => {
  it("rejects unrelated artifacts and actual drift; permits only exact planned appends", async () => {
    const { assertCaptureFresh } = await import("./transport");
    const tables: Record<string, any[]> = {
      analysis_source_files: [{ user_id: owner, id: "source" }],
      ledger_model_sessions: [
        {
          user_id: owner,
          series_id: "old",
          session_date: "2026-10-27",
          payload: { immutable: true },
        },
      ],
      ledger_model_series: [{ user_id: owner, series_id: "old" }],
      portfolio_ledgers: [{ user_id: owner, state: "original" }],
      us_actual_portfolio_ledgers: [{ user_id: owner, state: "original" }],
    };
    let archive: any[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === "POST") return new Response("[]");
      const u = new URL(String(url)),
        table = u.pathname.split("/").at(-1)!;
      let rows = tables[table] ?? [];
      if (table === "ledger_provenance_archive")
        rows = u.searchParams.get("source_id")?.includes("october-input") ? archive : [];
      return new Response(JSON.stringify(rows));
    };
    const o = { origin, key: "test", owner, fetcher };
    const b = { ...(await snapshot(o)), archiveRows: [], preparedRows: [], vintageRows: [] };
    const c: any = { preservationBaseline: b, captureManifest: { sourceObjects: [], legacy: [] } };
    await assertCaptureFresh(o, c);
    tables.portfolio_ledgers = [{ user_id: owner, state: "tampered" }];
    await expect(assertCaptureFresh(o, c)).rejects.toThrow();
    tables.portfolio_ledgers = b.actual.portfolio_ledgers;
    const expected = {
      source_id: "october-input:KR:2026-10-28:abc",
      source_hash: hash,
      payload: { exact: true },
    };
    archive = [{ ...expected, user_id: owner }];
    await expect(assertCaptureFresh(o, c)).rejects.toThrow();
    await assertCaptureFresh(o, c, [], {}, [expected]);
    archive[0].payload = { wrong: true };
    await expect(assertCaptureFresh(o, c, [], {}, [expected])).rejects.toThrow();
  });
});
