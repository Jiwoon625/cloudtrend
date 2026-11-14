import { afterEach, describe, it, expect, vi } from "vitest";
import { installDriveReadOnlyNetwork } from "../scripts/drive-history-network";
import { runDriveHistoryScreening } from "../scripts/run-drive-history-screening";
import { isVerifiedDriveHistory, KR_BASELINE_SHA, KR_OWNER } from "../scripts/drive-history-inputs";
const original = globalThis.fetch;
const supabase = "https://ahbvrtugugwnbrfnbxzp.supabase.co";
const runId = "run-20261107";
const objectPrefix = `/storage/v1/object/cloudtrend-data/${KR_OWNER}/`;
const resultPaths = [
  "results/drive-screening/input-head/latest.json",
  "cache/screening/latest.json",
  "cache/screening/latest.json.gz",
  "cache/dashboard/latest.json",
  "cache/dashboard/latest.json.gz",
  "cache/screening/confirmed-etf-context.json",
  `results/screening/${runId}.json`,
  "results/screening/latest.json",
  `results/drive-screening/receipts/${runId}.json`,
];
function mockGuard() {
  const transport = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
  );
  globalThis.fetch = transport;
  return { guard: installDriveReadOnlyNetwork(), transport };
}
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    expect(isVerifiedDriveHistory({ baselineSha256: KR_BASELINE_SHA, orderedSources: [] })).toBe(
      false,
    );
    vi.stubEnv("SUPABASE_USER_ID", KR_OWNER);
    vi.stubEnv("GITHUB_ACTIONS", undefined);
    vi.stubEnv("GITHUB_WORKFLOW_REF", undefined);
    await expect(runDriveHistoryScreening("/tmp/never-created-by-test", true)).rejects.toThrow(
      "V7 publication requires the shared screening-writer Actions workflow",
    );
  });
});

describe("Drive history result-write boundary", () => {
  it.each(resultPaths)(
    "blocks every mutation of %s before result writes are enabled",
    async (path) => {
      const { guard, transport } = mockGuard();
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        await expect(globalThis.fetch(supabase + objectPrefix + path, { method })).rejects.toThrow(
          "supabase-write",
        );
      expect(transport).not.toHaveBeenCalled();
      expect(guard.receipt.supabaseWrites).toBe(0);
      expect(guard.receipt.allowed).toEqual({});
      expect(guard.receipt.denied).toHaveLength(5);
    },
  );

  it.each(resultPaths)(
    "allows POST and PUT only for the enabled result object %s",
    async (path) => {
      const { guard, transport } = mockGuard();
      guard.enableResultWrites(KR_OWNER, runId);
      const url = supabase + objectPrefix + path;
      for (const method of ["POST", "PUT"]) {
        const init = { method, body: "{}" };
        await expect(globalThis.fetch(url, init)).resolves.toBeInstanceOf(Response);
        expect(transport).toHaveBeenLastCalledWith(url, init);
      }
      expect(transport).toHaveBeenCalledTimes(2);
      expect(guard.receipt.supabaseWrites).toBe(2);
      expect(guard.receipt.allowed).toEqual({ "supabase-write": 2 });
      expect(guard.receipt.denied).toEqual([]);
    },
  );

  it("does not allow another owner, run, bucket, API route, or neighboring object", async () => {
    const { guard, transport } = mockGuard();
    guard.enableResultWrites(KR_OWNER, runId);
    const paths = [
      objectPrefix.replace(KR_OWNER, "00000000-0000-4000-8000-000000000000") + resultPaths[0],
      objectPrefix + "results/screening/another-run.json",
      objectPrefix + "results/drive-screening/receipts/another-run.json",
      objectPrefix + "results/screening/latest.json.backup",
      objectPrefix + "results/screening/latest.json/child",
      objectPrefix + "results/screening/unapproved.json",
      objectPrefix + "cache/dashboard/unapproved.json",
      objectPrefix.replace("cloudtrend-data", "another-bucket") + resultPaths[0],
      objectPrefix.replace("/object/", "/object/authenticated/") + resultPaths[0],
      objectPrefix.replace("/object/", "/object/sign/") + resultPaths[0],
      "/rest/v1/screening_history",
      "/rest/v1/rpc/publish_screening",
    ];
    for (const path of paths)
      for (const method of ["POST", "PUT"])
        await expect(globalThis.fetch(supabase + path, { method })).rejects.toThrow(
          "supabase-write",
        );
    expect(transport).not.toHaveBeenCalled();
    expect(guard.receipt.supabaseWrites).toBe(0);
    expect(guard.receipt.denied).toHaveLength(paths.length * 2);
  });

  it("continues blocking DELETE, PATCH, and other mutations even on enabled result paths", async () => {
    const { guard, transport } = mockGuard();
    guard.enableResultWrites(KR_OWNER, runId);
    for (const path of resultPaths)
      for (const method of ["DELETE", "PATCH", "OPTIONS"])
        await expect(globalThis.fetch(supabase + objectPrefix + path, { method })).rejects.toThrow(
          "supabase-write",
        );
    expect(transport).not.toHaveBeenCalled();
    expect(guard.receipt.supabaseWrites).toBe(0);
    expect(guard.receipt.denied).toHaveLength(resultPaths.length * 3);
  });

  it("keeps historical source reads and deletes blocked, including encoded signed paths", async () => {
    const { guard, transport } = mockGuard();
    guard.enableResultWrites(KR_OWNER, runId);
    for (const source of ["screening", "us-screening"])
      for (const path of [
        `${objectPrefix}source/${source}/history.csv`,
        `/storage/v1/object/authenticated/cloudtrend-data/${KR_OWNER}%2Fsource%2F${source}%2Fhistory.csv`,
        `/storage/v1/object/sign/cloudtrend-data/${KR_OWNER}%2Fsource%2F${source}%2Fhistory.csv?token=test`,
      ])
        for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"])
          await expect(globalThis.fetch(supabase + path, { method })).rejects.toThrow(
            "historical-source",
          );
    expect(transport).not.toHaveBeenCalled();
    expect(guard.receipt.historicalSourceGETs).toBe(0);
    expect(guard.receipt.supabaseWrites).toBe(0);
    expect(guard.receipt.denied).toHaveLength(30);
    expect(guard.receipt.denied.every(({ category }) => category === "historical-source")).toBe(
      true,
    );
  });

  it("uses Request methods and init overrides without letting blocked writes reach transport", async () => {
    const { guard, transport } = mockGuard();
    const request = new Request(supabase + objectPrefix + resultPaths[0], { method: "POST" });
    await expect(globalThis.fetch(request)).rejects.toThrow("supabase-write");
    guard.enableResultWrites(KR_OWNER, runId);
    await expect(globalThis.fetch(request)).resolves.toBeInstanceOf(Response);
    await expect(globalThis.fetch(request, { method: "put" })).resolves.toBeInstanceOf(Response);
    await expect(globalThis.fetch(request, { method: "DELETE" })).rejects.toThrow("supabase-write");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(guard.receipt.supabaseWrites).toBe(2);
    expect(guard.receipt.denied).toEqual([
      { method: "POST", category: "supabase-write" },
      { method: "DELETE", category: "supabase-write" },
    ]);
  });

  it.each([
    ["not-an-owner", runId],
    [KR_OWNER + "/another-owner", runId],
    [KR_OWNER, "short"],
    [KR_OWNER, "../other-run"],
    [KR_OWNER, "x".repeat(129)],
  ])("rejects invalid result identity %s / %s without enabling writes", async (owner, run) => {
    const { guard, transport } = mockGuard();
    expect(() => guard.enableResultWrites(owner, run)).toThrow("Invalid result write identity");
    await expect(
      globalThis.fetch(supabase + objectPrefix + resultPaths[0], { method: "POST" }),
    ).rejects.toThrow("supabase-write");
    expect(transport).not.toHaveBeenCalled();
    expect(guard.receipt.supabaseWrites).toBe(0);
  });

  it("replaces the permitted run instead of accumulating previous run paths", async () => {
    const { guard, transport } = mockGuard();
    guard.enableResultWrites(KR_OWNER, runId);
    guard.enableResultWrites(KR_OWNER, "replacement-run");
    for (const path of [
      `results/screening/${runId}.json`,
      `results/drive-screening/receipts/${runId}.json`,
    ])
      await expect(
        globalThis.fetch(supabase + objectPrefix + path, { method: "POST" }),
      ).rejects.toThrow("supabase-write");
    await expect(
      globalThis.fetch(supabase + objectPrefix + "results/screening/replacement-run.json", {
        method: "POST",
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(guard.receipt.supabaseWrites).toBe(1);
  });

  it("restores the original transport", () => {
    const { guard, transport } = mockGuard();
    expect(globalThis.fetch).not.toBe(transport);
    guard.enableResultWrites(KR_OWNER, runId);
    guard.restore();
    expect(globalThis.fetch).toBe(transport);
  });
});
