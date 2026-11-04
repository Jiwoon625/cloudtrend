import { it, expect, vi, beforeEach } from "vitest";
import { publishAllocatedPerformanceHistory } from "./allocatedPerformanceHistory.server";
import { emptyNewActualMetadata } from "./newActualPortfolio";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({ read: vi.fn(), upload: vi.fn() }));
vi.mock("./ledger/websiteRepository.server", () => ({ readWebsiteDocument: mocks.read }));
const client = { storage: { from: () => ({ upload: mocks.upload }) } } as unknown as SupabaseClient;
const input = {
  currency: "KRW" as const,
  sourceHash: "a".repeat(64),
  throughDate: "2026-11-03",
  dates: ["2026-11-03"],
  prices: [],
};
const ledger = {
  revision: 7,
  payload: {
    executions: [],
    newActualPortfolio: {
      ...emptyNewActualMetadata(),
      cashEvents: [
        {
          id: "synthetic",
          date: "2026-10-12",
          kind: "DEPOSIT",
          amount: 100,
          reference: "synthetic",
        },
      ],
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.upload.mockResolvedValue({ error: null });
  mocks.read.mockResolvedValue(ledger);
});
it("accepts the existing unprefixed screening fingerprint and pins ledger revision and price hash", async () => {
  expect(await publishAllocatedPerformanceHistory(client, "synthetic-owner", input)).toEqual({
    status: "UPDATED",
  });
  expect(mocks.upload.mock.calls[0]![0]).toBe(
    `synthetic-owner/results/actual-performance/KRW/revision-7/2026-11-03-${input.sourceHash}.json`,
  );
  const data = JSON.parse(await (mocks.upload.mock.calls[0]![1] as Blob).text());
  expect(data.sourceHash).toBe(`sha256:${input.sourceHash}`);
});
it("refuses to publish against a concurrently changed canonical ledger", async () => {
  mocks.read.mockResolvedValueOnce(ledger).mockResolvedValueOnce({ ...ledger, revision: 8 });
  await expect(
    publishAllocatedPerformanceHistory(client, "synthetic-owner", input),
  ).rejects.toThrow("변경");
  expect(mocks.upload).not.toHaveBeenCalled();
});
