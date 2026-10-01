import { describe, expect, it, vi } from "vitest";
import {
  buildSnapshot,
  persistScreeningSnapshot,
  preservePreAdoptionSnapshot,
  type ScreeningSnapshot,
} from "../src/lib/screeningSnapshot";
import {
  LEGACY_OPERATIONAL_SIGNAL_VERSION,
  OPERATIONAL_SIGNAL_VERSION,
  isOperationalEntry,
} from "../src/lib/engine/operationalStrategy";
import { kospiEntryConfirmation } from "../src/lib/engine/kospiEntryConfirmation";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { compactDashboardRow } from "../src/lib/dashboardRow";
import { marketSignals, projectKrDashboard } from "../src/lib/dashboardOperations";
import { buildDashboardSummary } from "../src/lib/screeningCacheContract";
import {
  getPortfolioAwareDisplayStatus,
  isPortfolioAwareOperationalEntry,
} from "../src/lib/statusDisplay";
import type { SupabaseClient } from "@supabase/supabase-js";
const analysis = runAnalysis(getMockDataset());
const base = analysis.rows.find(
  (r) => r.instrument.market === "KOSPI" && r.instrument.instrumentType === "STOCK",
)!;
const obs = (date: string, score: number) => ({
  date,
  score,
  eligible: true,
  observed: true,
  rsAccel: 1,
});
const state = kospiEntryConfirmation(
  obs("2026-10-05", 8.5),
  obs("2026-10-02", 8),
  obs("2026-10-01", 7.5),
);
const row = {
  ...base,
  kospi80Onset: false,
  kosdaq80Onset: false,
  kospiEightPointEntry: true,
  operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
  kospiEntry: state,
  exitSignal: null,
  rs20: 2,
  rs60: 1,
  snapshot: { ...base.snapshot, tradeDate: state.date },
};
const current = { ...analysis, asOfDate: state.date, rows: [row] };
describe("confirmation projections and actual-position context", () => {
  it("persists all dated confirmation evidence in snapshots and compact dashboard", () => {
    expect(buildSnapshot(current).entries[0]!.kospiEntry).toEqual(state);
    expect(compactDashboardRow(row).kospiEntry).toEqual(state);
    expect(isOperationalEntry(buildSnapshot(current).entries[0]!, state.date)).toBe(true);
    const summary = buildDashboardSummary(current, "x", "x");
    expect(summary.counts.kospiEightPointEntries).toBe(1);
    expect(summary.kospiEntryRows[0]!.kospiEntry).toEqual(state);
    expect(projectKrDashboard(current).rows[0]!.onset).toBe(true);
  });
  it("excludes held and any sale since original onset in every live surface", () => {
    const context = {
      heldSymbols: [],
      lastSellDateBySymbol: { [row.instrument.symbol]: state.originDate! },
    };
    expect(isPortfolioAwareOperationalEntry(row, context, state.date)).toBe(false);
    expect(getPortfolioAwareDisplayStatus(row, context, state.date)).toContain("재진입 제외");
    expect(
      marketSignals(
        projectKrDashboard(current),
        "KOSPI",
        [],
        [
          {
            symbol: row.instrument.symbol,
            market: "KOSPI",
            side: "SELL",
            shares: 1,
            date: state.originDate!,
          },
        ],
      ).onsetCount,
    ).toBe(0);
    expect(
      marketSignals(projectKrDashboard(current), "KOSPI", [
        { symbol: row.instrument.symbol, name: "x", shares: 1, firstEntryDate: "2026-10-01" },
      ]).onsetCount,
    ).toBe(0);
  });
  it("does not label stale rows entry-ready even without holdings context", () => {
    expect(isPortfolioAwareOperationalEntry(row, undefined, "2026-10-06")).toBe(false);
    expect(getPortfolioAwareDisplayStatus(row, undefined, "2026-10-06")).toContain("기한 지난");
    expect(
      marketSignals(projectKrDashboard({ ...current, asOfDate: "2026-10-06" }), "KOSPI", [])
        .onsetCount,
    ).toBe(0);
  });
});
describe("pre-adoption persistence", () => {
  const incoming = { ...buildSnapshot(current), date: "2026-09-30", asOfDate: "2026-09-30" };
  const legacy: ScreeningSnapshot = {
    ...incoming,
    entries: incoming.entries.map((e) => ({
      ...e,
      kospiEntry: undefined,
      kospi80Onset: true,
      operationalSignalVersion: LEGACY_OPERATIONAL_SIGNAL_VERSION,
    })),
  };
  it("retains the existing legacy snapshot rather than fabricating new historical trades", () => {
    expect(preservePreAdoptionSnapshot(incoming, legacy)).toBe(legacy);
    expect(preservePreAdoptionSnapshot(incoming, null)).toBe(incoming);
    expect(
      preservePreAdoptionSnapshot({ ...incoming, asOfDate: "2026-10-05" }, legacy).asOfDate,
    ).toBe("2026-10-05");
  });
  it("never upserts over old policy history, and read failure never writes", async () => {
    const upsert = vi.fn();
    const table = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { snapshot: legacy }, error: null }),
      upsert,
    };
    const client = { from: vi.fn(() => table) } as unknown as SupabaseClient;
    expect(await persistScreeningSnapshot(client, "uid", incoming)).toBe(legacy);
    expect(upsert).not.toHaveBeenCalled();
    table.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error("read failed") });
    await expect(persistScreeningSnapshot(client, "uid", incoming)).rejects.toThrow("read failed");
    expect(upsert).not.toHaveBeenCalled();
  });
});
