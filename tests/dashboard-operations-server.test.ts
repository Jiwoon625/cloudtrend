import { describe, it, expect, vi } from "vitest";
import {
  SCREENING_CACHE_VERSION,
  DASHBOARD_CACHE_VERSION,
} from "../src/lib/screeningCacheContract";
import { projection } from "../src/lib/dashboardOperations.server";
import { downloadFreshObject } from "../src/lib/freshStorage";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("../src/lib/freshStorage", () => ({ downloadFreshObject: vi.fn() }));
const client = {
  storage: { from: () => ({ upload: async () => ({ error: null }) }) },
} as unknown as SupabaseClient;
describe("dashboard projection policy cache identity", () => {
  it("refuses stale policy summary before reading/reusing a sidecar", async () => {
    vi.mocked(downloadFreshObject).mockResolvedValueOnce({
      data: new Blob([JSON.stringify({ version: "old-policy", resultDigest: "old" })]),
      error: null,
    });
    await expect(projection(client, "old-summary", "kr")).rejects.toThrow("다시 실행");
  });
  it("refuses matching digest when full payload policy version is old", async () => {
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "same" }
        : path.endsWith("screening/latest.json")
          ? {
              version: "old",
              resultDigest: "same",
              payload: { analysis: { rows: [], asOfDate: "2026-10-05" } },
            }
          : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    await expect(projection(client, "old-full", "kr")).rejects.toThrow("갱신 중");
  });
  it("accepts current summary/full policy versions with matching digest", async () => {
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "new" }
        : path.endsWith("screening/latest.json")
          ? {
              version: SCREENING_CACHE_VERSION,
              resultDigest: "new",
              payload: { analysis: { rows: [], tradeDates: [], asOfDate: "2026-10-05" } },
            }
          : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    expect((await projection(client, "new-full", "kr"))?.date).toBe("2026-10-05");
  });
});
