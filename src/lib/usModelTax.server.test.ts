import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { loadUsModelTaxProjection, loadUsModelTaxProjections } from "./usModelTax.server";
import { modelTaxFixture } from "../../tests/fixtures/usModelTaxSource";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
function setup() {
  const source = modelTaxFixture();
  const reads: Array<{
    table: string;
    filters: Array<[string, unknown]>;
    range?: number[] | undefined;
  }> = [];
  const mutation = vi.fn(() => {
    throw new Error("unexpected mutation");
  });
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "owner" } }, error: null })) },
    from: vi.fn((table: string) => {
      const read = {
        table,
        filters: [] as Array<[string, unknown]>,
        range: undefined as number[] | undefined,
      };
      reads.push(read);
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((k, v) => {
          read.filters.push([k, v]);
          return query;
        }),
        lte: vi.fn((k, v) => {
          read.filters.push([k, v]);
          return query;
        }),
        in: vi.fn(() => query),
        order: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: source.registry, error: null })),
        range: vi.fn(async (a, b) => {
          read.range = [a, b];
          const rows =
            table === "us_portfolio_snapshots"
              ? source.snapshots
              : table === "us_portfolio_trades"
                ? source.trades
                : source.completed;
          return {
            data: rows.slice(a, b + 1).map((row) => {
              if (table !== "us_portfolio_snapshots") return row;
              const snapshot = row as (typeof source.snapshots)[number];
              return {
                ...snapshot,
                state: undefined,
                initializedDate: snapshot.state.initializedDate,
                initialCapital: snapshot.state.initialCapital,
                lastDate: snapshot.state.lastDate,
                modelCash: snapshot.state.cash,
                positions: snapshot.state.positions,
              };
            }),
            error: null,
          };
        }),
        insert: mutation,
        update: mutation,
        upsert: mutation,
        delete: mutation,
      };
      return query;
    }),
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async (path: string) => {
          const date = path.split("/").at(-1)!.replace(".json", "");
          const proof = source.sourceProofs.find((p) => p.date === date);
          return {
            data: new Blob([
              JSON.stringify({
                dataHash: proof?.dataHash,
                analysis: { date: proof?.date, ruleVersion: proof?.ruleVersion },
                source: {
                  metadata: {
                    previousSessionDate: proof?.previousSessionDate,
                    confirmedRegularClose: proof?.confirmedRegularClose,
                    failedSymbols: proof?.failedSymbols,
                  },
                },
              }),
            ]),
            error: null,
          };
        }),
        upload: mutation,
      })),
    },
    rpc: mutation,
  };
  vi.mocked(createClient).mockReturnValue(client as never);
  return { client: client as unknown as SupabaseClient, source, reads, mutation, raw: client };
}
beforeEach(() => vi.clearAllMocks());
describe("authenticated read-only model tax projection", () => {
  it("scopes every database and immutable-source read to the authenticated owner", async () => {
    const f = setup();
    const result = await loadUsModelTaxProjections("test-session", [
      { strategyId: f.source.strategyId, sourceDate: f.source.sourceDate },
    ]);
    expect(result[0]!.taxEvidence!.evidence.sales).toEqual([]);
    expect(f.raw.auth.getUser).toHaveBeenCalledWith("test-session");
    expect(f.reads.every((r) => r.filters.some(([k, v]) => k === "user_id" && v === "owner"))).toBe(
      true,
    );
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("never reads private records when authentication fails", async () => {
    const f = setup();
    f.raw.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "expired" },
    } as never);
    await expect(loadUsModelTaxProjections("expired", [])).rejects.toThrow("로그인");
    expect(f.raw.from).not.toHaveBeenCalled();
  });
  it("rejects a missing bootstrap rather than treating the visible window as full history", async () => {
    const f = setup();
    f.source.snapshots.shift();
    const r = await loadUsModelTaxProjection(f.client, "owner", f.source);
    expect(r.taxEvidence).toBeNull();
    expect(r.missingFields.join(" ")).toContain("초기 상태");
  });
  it("rejects incomplete immutable-source chain even if table dates match", async () => {
    const f = setup();
    f.source.sourceProofs[2]!.previousSessionDate = "2026-09-25";
    const r = await loadUsModelTaxProjection(f.client, "owner", f.source);
    expect(r.taxEvidence).toBeNull();
    expect(r.missingFields.join(" ")).toContain("이전 거래일");
  });
  it("pages past the REST limit and rejects duplicate fills instead of silently truncating", async () => {
    const f = setup();
    f.source.trades = Array.from({ length: 501 }, () => ({ ...f.source.trades[0]! }));
    const r = await loadUsModelTaxProjection(f.client, "owner", f.source);
    expect(f.reads.some((q) => q.table === "us_portfolio_trades" && q.range?.[0] === 500)).toBe(
      true,
    );
    expect(r.taxEvidence).toBeNull();
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("shares immutable proof reads and caps concurrent downloads at four", async () => {
    const f = setup();
    f.raw.auth.getUser.mockResolvedValue({
      data: { user: { id: "owner-concurrency-test" } },
      error: null,
    });
    const download = f.raw.storage.from().download;
    let active = 0,
      peak = 0;
    const bounded = vi.fn(async (path: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await download(path);
      active--;
      return result;
    });
    f.raw.storage.from.mockReturnValue({ download: bounded, upload: f.mutation });
    const r = { strategyId: f.source.strategyId, sourceDate: f.source.sourceDate };
    await loadUsModelTaxProjections("test-token", [r, r, r]);
    expect(bounded).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(4);
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("rejects a source fetch failure rather than treating it as no model sales", async () => {
    const f = setup();
    f.raw.storage.from.mockReturnValue({
      download: vi.fn(async () => ({ data: null, error: { message: "offline" } })),
      upload: f.mutation,
    } as never);
    await expect(loadUsModelTaxProjection(f.client, "owner", f.source)).rejects.toThrow(
      "확인할 수 없습니다",
    );
    expect(f.mutation).not.toHaveBeenCalled();
  });
});
