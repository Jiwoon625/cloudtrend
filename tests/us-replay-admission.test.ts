import { describe, expect, it, vi, beforeEach } from "vitest";
import { bytesHash } from "../scripts/us-replay-source";
import { sourceCsv } from "./us-replay-fixtures";
import { runUsScreening } from "../scripts/run-us-screening";
import type { trustedSupabaseClient } from "../scripts/analysis-run-store";
const spy = vi.hoisted(() => ({ replay: vi.fn() }));
vi.mock("../src/lib/shadowReplay.server", () => ({ replayUsShadow: spy.replay }));
beforeEach(() => spy.replay.mockReset());
function client(
  history: unknown,
  metadata: unknown = {
    confirmedRegularClose: true,
    failedSymbols: 0,
    previousSessionDate: "2026-10-05",
  },
) {
  const csv = sourceCsv("2026-10-06");
  const writes: string[] = [];
  const ingest = {
    storage_bucket: "cloudtrend-data",
    storage_path: "input.csv",
    data_hash: bytesHash(csv),
    row_count: 2,
    symbol_count: 2,
    as_of_date: "2026-10-06",
    collected_at: "2026-10-06T21:00:00Z",
    metadata,
  };
  const c = {
    from(table: string) {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        lt() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        async maybeSingle() {
          return { data: table === "us_screening_ingest" ? ingest : history, error: null };
        },
      };
      return q;
    },
    storage: {
      from: () => ({
        async download(path: string) {
          return path === "input.csv"
            ? { data: { text: async () => csv }, error: null }
            : { data: null, error: { message: "404 Object not found" } };
        },
        async upload() {
          writes.push("upload");
          return { error: null };
        },
      }),
    },
  };
  return { c: c as unknown as ReturnType<typeof trustedSupabaseClient>, writes };
}
describe("ordinary US runner pre-mutation admission", () => {
  it("rejects past input without writing a Shadow audit, archive, ledger or cache", async () => {
    const f = client({ date: "2026-10-07", data_hash: "other", rule_version: "other" });
    await expect(runUsScreening(f.c, "owner")).rejects.toThrow("Past US history");
    expect(spy.replay).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("rejects immutable completed hash mismatch before Shadow replay", async () => {
    const f = client({ date: "2026-10-06", data_hash: "other", rule_version: "other" });
    await expect(runUsScreening(f.c, "owner")).rejects.toThrow("immutable");
    expect(spy.replay).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("rejects unconfirmed source before any mutation", async () => {
    const f = client(null, { confirmedRegularClose: false, failedSymbols: 0 });
    await expect(runUsScreening(f.c, "owner")).rejects.toThrow("confirmed session");
    expect(spy.replay).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
});
