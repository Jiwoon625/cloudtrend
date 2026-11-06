import { afterEach, describe, it, expect, vi } from "vitest";
import { installDriveReadOnlyNetwork } from "../scripts/drive-history-network";
import { runDriveHistoryScreening } from "../scripts/run-drive-history-screening";
import { isVerifiedDriveHistory } from "../scripts/drive-history-inputs";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});
describe("Drive-only validation boundary", () => {
  it("denies historical source GET, signed path encoding and any Supabase mutation", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    globalThis.fetch = fetch;
    const guard = installDriveReadOnlyNetwork();
    for (const source of ["screening", "us-screening"])
      await expect(
        globalThis.fetch(
          `https://ahbvrtugugwnbrfnbxzp.supabase.co/storage/v1/object/authenticated/cloudtrend-data/owner%2Fsource%2F${source}%2Fx.csv`,
        ),
      ).rejects.toThrow("historical-source");
    await expect(
      globalThis.fetch("https://ahbvrtugugwnbrfnbxzp.supabase.co/rest/v1/screening_history", {
        method: "POST",
      }),
    ).rejects.toThrow("supabase-write");
    expect(fetch).not.toHaveBeenCalled();
    expect(guard.receipt.denied).toHaveLength(3);
    guard.restore();
  });
  it("permits DB settings and operational index artifacts, recorded separately", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}"));
    const guard = installDriveReadOnlyNetwork();
    await fetch("https://ahbvrtugugwnbrfnbxzp.supabase.co/rest/v1/signal_rules");
    await fetch(
      "https://ahbvrtugugwnbrfnbxzp.supabase.co/storage/v1/object/authenticated/cloudtrend-data/owner/results/ingestion/underlying-index/hash.json",
    );
    expect(guard.receipt.allowed).toEqual({ "db-read": 1, "storage-state-or-cache-read": 1 });
    guard.restore();
  });
  it("does not authorize dashboard publication from arbitrary inputs/evidence", async () => {
    expect(isVerifiedDriveHistory({ baselineSha256: "x", orderedSources: [] })).toBe(false);
    await expect(runDriveHistoryScreening("/tmp/never-created-by-test", true)).rejects.toThrow(
      "not enabled",
    );
  });
});
