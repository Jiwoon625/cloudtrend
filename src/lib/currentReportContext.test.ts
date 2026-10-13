import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({ read: vi.fn(), shadow: vi.fn(), integrated: vi.fn() }));
vi.mock("./ledger/websiteRepository.server", () => ({ readWebsiteDocument: mocks.read }));
vi.mock("./octoberShadowSummary.server", async (original) => ({
  ...(await original<typeof import("./octoberShadowSummary.server")>()),
  loadOctoberShadowSummaryForOwner: mocks.shadow,
}));
vi.mock("./integratedAllocationStore.server", () => ({
  readIntegratedAllocationBook: mocks.integrated,
}));
import {
  loadCurrentReportContextForOwner,
  CURRENT_REPORT_SOURCE_CONTRACT,
} from "./currentReportContext.server";
import { ADOPTED_SERIES_KINDS, RESTART_SERIES_VERSION } from "./ledger/modelSeries";
import { emptyNewActualMetadata, type NewActualExecution } from "./newActualPortfolio";
import { restartBook, restartSummary } from "../../tests/website-restart-fixtures";

import { createIntegratedAllocationShadow } from "./integratedAllocationShadow";

const uid = "11111111-1111-1111-1111-111111111111";
const now = new Date("2026-10-13T22:00:00Z");
const fill = (id: string): NewActualExecution => ({
  id,
  date: "2026-10-12",
  order: 0,
  symbol: id,
  name: id,
  market: "US",
  side: "BUY",
  shares: 2,
  price: 100,
  fee: 0,
  signalKey: null,
  note: "private note omitted",
});
function clientFor(
  data: unknown = {
    date: "2026-10-12",
    rule_version: "test",
    signals: [{ symbol: "SIGNAL", a0Entry: true, legacyHoldings: ["OLD"] }],
  },
  error: unknown = null,
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  for (const key of ["select", "eq", "gte", "lte", "order", "limit"] as const)
    query[key].mockReturnValue(query);
  const from = vi.fn().mockReturnValue(query);
  return { client: { from } as unknown as SupabaseClient, from, query };
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ revision: 1, payload: { executions: [fill("LEGACY")] } });
  const shadow = await restartSummary();
  shadow.books = await Promise.all(ADOPTED_SERIES_KINDS.map((kind) => restartBook(kind)));
  mocks.shadow.mockResolvedValue(shadow);
  mocks.integrated.mockImplementation(async (_client, _uid, kind) => ({
    kind,
    status: "NOT_INITIALIZED",
    ledger: null,
  }));
});
describe("current read-only reporting boundary", () => {
  it("keeps signals separate and never queries legacy portfolio tables", async () => {
    const { client, from, query } = clientFor();
    const report = await loadCurrentReportContextForOwner(client, uid, now);
    expect(from.mock.calls).toEqual([["us_screening_history"]]);
    expect(query.select).toHaveBeenCalledWith("date,rule_version,signals");
    expect(query.eq).toHaveBeenCalledWith("user_id", uid);
    expect(query.gte).toHaveBeenCalledWith("date", "2026-10-12");
    expect(query.lte).toHaveBeenCalledWith("date", "2026-10-13");
    expect(report.marketSignals.US.signals[0]).toMatchObject({ symbol: "SIGNAL", a0Entry: true });
    expect(report.marketSignals.US.signals[0]).not.toHaveProperty("legacyHoldings");
    expect(report.actual.pools.every((pool) => pool.positions.length === 0)).toBe(true);
    expect(report.actual.pools.every((pool) => pool.status === "NOT_INITIALIZED")).toBe(true);
    expect(mocks.shadow).toHaveBeenCalledWith(client, uid, RESTART_SERIES_VERSION);
    expect(mocks.integrated.mock.calls.map((call) => call.slice(1))).toEqual([
      [uid, "O1"],
      [uid, "S07"],
    ]);
    expect(report.shadow.books.map((book) => book.bookId)).toEqual(
      CURRENT_REPORT_SOURCE_CONTRACT.adoptedBookIds,
    );
  });
  it("uses only reviewed assigned quantities even for post-start raw fills", async () => {
    const metadata = emptyNewActualMetadata();
    metadata.cashEvents.push({
      id: "cash",
      date: "2026-10-12",
      kind: "DEPOSIT",
      amount: 1000,
      reference: "synthetic",
    });
    metadata.assignments["ALLOCATED"] = {
      executionId: "ALLOCATED",
      quantity: 1,
      gross: 100,
      fee: 0,
      brokerReference: "synthetic",
    };
    const doc = {
      revision: 2,
      payload: {
        executions: [fill("ALLOCATED"), fill("UNASSIGNED")],
        newActualPortfolio: metadata,
      },
    };
    mocks.read.mockImplementation(async (_client, _uid, source) =>
      source === "us_actual_portfolio_ledgers" ? doc : null,
    );
    const before = JSON.stringify(doc);
    const report = await loadCurrentReportContextForOwner(clientFor().client, uid, now);
    expect(report.actual.pools.find((pool) => pool.currency === "USD")?.positions).toMatchObject([
      { symbol: "ALLOCATED", quantity: "1" },
    ]);
    expect(JSON.stringify(report)).not.toContain("UNASSIGNED");
    expect(JSON.stringify(report)).not.toContain("private note");
    expect(JSON.stringify(doc)).toBe(before);
  });
  it("rejects old Shadow and incomplete restart books instead of using a legacy fallback", async () => {
    const current = await mocks.shadow();
    mocks.shadow.mockResolvedValueOnce({ ...current, version: "adopted-shadow-2026-10-05-v1" });
    await expect(loadCurrentReportContextForOwner(clientFor().client, uid, now)).rejects.toThrow(
      "신규 Shadow",
    );
    mocks.shadow.mockResolvedValueOnce({ ...current, books: current.books.slice(1) });
    await expect(loadCurrentReportContextForOwner(clientFor().client, uid, now)).rejects.toThrow(
      "신규 Shadow",
    );
  });
  it("distinguishes absent market data from no signals and propagates source failures", async () => {
    const report = await loadCurrentReportContextForOwner(clientFor(null).client, uid, now);
    expect(report.marketSignals.US.status).toBe("UNAVAILABLE");
    mocks.read.mockRejectedValueOnce(new Error("canonical integrity failed"));
    await expect(loadCurrentReportContextForOwner(clientFor().client, uid, now)).rejects.toThrow(
      "canonical integrity failed",
    );
    await expect(
      loadCurrentReportContextForOwner(clientFor(null, { message: "offline" }).client, uid, now),
    ).rejects.toThrow("offline");
  });
  it("keeps O1/S07 distinct and rejects a mismatched integrated identity", async () => {
    const ledger = await createIntegratedAllocationShadow("O1", {
      codeHash: `sha256:${"a".repeat(64)}`,
    });
    mocks.integrated.mockResolvedValueOnce({ kind: "O1", status: "INITIALIZED_WAITING", ledger });
    const report = await loadCurrentReportContextForOwner(clientFor().client, uid, now);
    expect(report.integratedShadow.books.map((book) => book.bookId)).toEqual(
      CURRENT_REPORT_SOURCE_CONTRACT.integratedBookIds,
    );
    expect(report.integratedShadow.books[0]?.sleeves).toHaveLength(3);
    expect(report.actual.pools.every((pool) => pool.positions.length === 0)).toBe(true);
    mocks.integrated.mockResolvedValueOnce({
      kind: "O1",
      status: "RECORDED",
      ledger: { ...ledger, bookId: "legacy:O1" },
    });
    await expect(loadCurrentReportContextForOwner(clientFor().client, uid, now)).rejects.toThrow(
      "Unexpected integrated",
    );
  });
  it("rejects future integrated holdings instead of leaking them into a report", async () => {
    const ledger = await createIntegratedAllocationShadow("O1", {
      codeHash: `sha256:${"a".repeat(64)}`,
    });
    ledger.markets.U.positions.push({
      symbol: "FUTURE",
      venue: "US",
      sector: null,
      quantity: "1",
      costKrw: "100",
      entryDate: "2026-10-14",
      lastMark: null,
    });
    mocks.integrated.mockResolvedValueOnce({ kind: "O1", status: "RECORDED", ledger });
    await expect(loadCurrentReportContextForOwner(clientFor().client, uid, now)).rejects.toThrow(
      "out-of-bound",
    );
  });
  it("rejects an unverified owner before reading anything", async () => {
    const { client, from } = clientFor();
    await expect(loadCurrentReportContextForOwner(client, "owner", now)).rejects.toThrow(
      "Verified owner",
    );
    expect(from).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
