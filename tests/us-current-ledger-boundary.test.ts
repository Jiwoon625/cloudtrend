import { beforeEach, describe, expect, it, vi } from "vitest";
import { runUsScreening } from "../scripts/run-us-screening";
import { runUsDailyContinuation } from "../scripts/us-daily-continuation";
import { sourceCsv } from "./us-replay-fixtures";
import { bytesHash } from "../scripts/us-replay-source";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
import { usesLegacyUsOperatingLedger } from "../src/lib/legacyUsLedgerBoundary";
import type { trustedSupabaseClient } from "../scripts/analysis-run-store";

const mocks = vi.hoisted(() => ({ replay: vi.fn(), publish: vi.fn() }));
vi.mock("../src/lib/shadowReplay.server", () => ({ replayUsShadow: mocks.replay }));
vi.mock("../scripts/us-screening-publication", () => ({
  compactRow: (row: unknown) => row,
  publishBrowserViews: mocks.publish,
}));
vi.mock("../scripts/us-recovery-publication", () => ({
  loadPublishedUsRecoveryView: async () => null,
}));
beforeEach(() => {
  vi.clearAllMocks();
});

function fixture(date = "2026-10-12", priorDate = "2026-10-09") {
  const csv = sourceCsv(date);
  const files = new Map<string, string>([
    ["input.csv", csv],
    [
      `owner/results/us-screening/${priorDate}.json`,
      JSON.stringify({
        analysis: { state: { lastDate: priorDate, coreRanks: { TEST: 0.7 }, betaWeakStreak: {} } },
      }),
    ],
  ]);
  let history: Record<string, unknown> = { date: priorDate };
  const tables: string[] = [],
    writes: string[] = [],
    downloads: string[] = [];
  const ingest = {
    storage_bucket: "cloudtrend-data",
    storage_path: "input.csv",
    data_hash: bytesHash(csv),
    row_count: 2,
    symbol_count: 2,
    as_of_date: date,
    collected_at: `${date}T21:00:00Z`,
    metadata: { confirmedRegularClose: true, failedSymbols: 0, previousSessionDate: priorDate },
  };
  const client = {
    from(table: string) {
      tables.push(table);
      if (!["us_screening_history", "us_screening_ingest"].includes(table))
        throw new Error(`Retired ledger access: ${table}`);
      let before: string | undefined;
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        lt: (_key: string, value: string) => {
          before = value;
          return q;
        },
        maybeSingle: async () => ({
          data: table === "us_screening_ingest" ? ingest : before ? { date: priorDate } : history,
          error: null,
        }),
        insert: async (value: Record<string, unknown>) => {
          writes.push(table);
          history = value;
          return { error: null };
        },
      };
      return q;
    },
    rpc() {
      throw new Error("Retired operating RPC access");
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloads.push(path);
          return files.has(path)
            ? { data: { text: async () => files.get(path)! }, error: null }
            : { data: null, error: { message: "404 Object not found" } };
        },
        upload: async (path: string, body: string) => {
          writes.push(path);
          files.set(path, body);
          return { error: null };
        },
      }),
    },
  };
  mocks.replay.mockResolvedValue({
    market: "US",
    processed: [{ date, status: "RECORDED" }],
    deferred: null,
    latestRecordedDate: date,
    throughDate: date,
    latestAnalysis: null,
  });
  return {
    client: client as unknown as ReturnType<typeof trustedSupabaseClient>,
    tables,
    writes,
    downloads,
    ingest,
    files,
    setHistory: (value: Record<string, unknown>) => {
      history = value;
    },
  };
}

describe("retired US operating ledger boundary", () => {
  it("retains historical dates and rejects malformed dates", () => {
    expect(usesLegacyUsOperatingLedger("2026-10-09")).toBe(true);
    expect(usesLegacyUsOperatingLedger("2026-10-12")).toBe(false);
    expect(() => usesLegacyUsOperatingLedger("2026-99-12")).toThrow();
  });
  it.each([
    ["2026-10-12", "2026-10-09"],
    ["2026-10-13", "2026-10-12"],
  ])("publishes %s without any old operating tables or continuation", async (date, previous) => {
    const f = fixture(date, previous);
    await runUsScreening(f.client, "owner");
    expect(mocks.replay).toHaveBeenCalledTimes(1);
    expect(f.writes).toContain("us_screening_history");
    expect(f.writes).toContain("owner/cache/us-screening/latest.json");
    expect(f.downloads.some((path) => path.includes("us-continuation"))).toBe(false);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("same-date completed publication reuses immutable output without replay or old ledgers", async () => {
    const f = fixture();
    await runUsScreening(f.client, "owner");
    const immutable = f.files.get("owner/results/us-screening/2026-10-12.json");
    await runUsScreening(f.client, "owner");
    expect(mocks.replay).toHaveBeenCalledTimes(1);
    expect(f.writes.filter((x) => x === "us_screening_history")).toHaveLength(1);
    expect(f.files.get("owner/results/us-screening/2026-10-12.json")).toBe(immutable);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });
  it("does not publish a completion marker while restart Shadow is deferred", async () => {
    const f = fixture();
    mocks.replay.mockResolvedValue({
      market: "US",
      processed: [],
      deferred: { date: "2026-10-12" },
      latestRecordedDate: null,
    });
    await expect(runUsScreening(f.client, "owner")).rejects.toThrow("has not completed");
    expect(f.writes).not.toContain("us_screening_history");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("requires missing dates to use the new replay route before ordinary screening", async () => {
    const f = fixture();
    f.setHistory({ date: "2026-10-08" });
    await expect(runUsScreening(f.client, "owner")).rejects.toThrow("restart-series recovery");
    expect(f.writes).toEqual([]);
    expect(mocks.replay).not.toHaveBeenCalled();
  });
  it("old continuation cannot accept a new date even if called directly", async () => {
    await expect(
      runUsDailyContinuation({ ingest: { as_of_date: "2026-10-12" } } as Parameters<
        typeof runUsDailyContinuation
      >[0]),
    ).rejects.toThrow("historical-only");
  });
});

describe("restart publication after partial model commit", () => {
  it("matches the actual empty-start engine when models are already saved and latestAnalysis is null", async () => {
    const expected = runUsProspectiveAnalysis(parseUsProspectiveCsv(sourceCsv("2026-10-12")), {});
    const fresh = fixture();
    mocks.replay.mockResolvedValueOnce({
      market: "US",
      processed: [],
      deferred: null,
      latestRecordedDate: "2026-10-12",
      latestAnalysis: expected,
    });
    await runUsScreening(fresh.client, "owner");
    const resumed = fixture();
    // Model commit already finished, but no screening completion marker exists.
    // The Oct9 source intentionally contains TEST core rank .7, which would
    // create a forbidden onset at the new date if inherited on retry.
    await runUsScreening(resumed.client, "owner");
    const output = (f: ReturnType<typeof fixture>) =>
      JSON.parse(f.files.get("owner/results/us-screening/2026-10-12.json")!).analysis;
    expect(output(resumed)).toEqual(output(fresh));
    expect(output(resumed).summary.a0Entries).toBe(0);
    expect(output(resumed).rows.every((r: { onset80: boolean }) => r.onset80 === false)).toBe(true);
  });
});
