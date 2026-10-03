import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUsMarketDataSummary } from "../src/lib/usProspectiveCloud";
const mocks = vi.hoisted(() => ({ read: vi.fn(), binary: vi.fn() }));
vi.mock("@/lib/cloud", () => ({
  ownerPath: async (p: string) => p,
  readObject: mocks.read,
  readBinaryObject: mocks.binary,
  userId: vi.fn(),
  supabase: {},
}));
vi.mock("@/lib/usOrderPreview.functions", () => ({ usOrderPreviewsServer: vi.fn() }));
const summary = {
  dataHash: "same",
  generatedAt: "now",
  source: {},
  analysis: { date: "2026-10-02", ruleVersion: "rule", summary: {}, rowCount: 1 },
};
const detail = {
  ...summary,
  analysis: { ...summary.analysis, rows: [{ symbol: "TEST", date: "2026-10-02", close: 100 }] },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.binary.mockResolvedValue(null);
});
describe("US data status legacy enrichment", () => {
  it("uses compact stored quality without fetching rows again", async () => {
    mocks.read.mockResolvedValue({ ...summary, quality: { rowCount: 1 } });
    const data = await loadUsMarketDataSummary();
    expect(data?.quality?.rowCount).toBe(1);
    expect(mocks.binary).not.toHaveBeenCalled();
  });
  it("enriches only matching date and hash from the existing browser cache", async () => {
    mocks.read.mockResolvedValueOnce(summary).mockResolvedValueOnce(detail);
    const data = await loadUsMarketDataSummary();
    expect(data?.quality?.rowCount).toBe(1);
    expect(data?.dataHash).toBe("same");
  });
  it("keeps valid summary and withholds mismatched detail", async () => {
    mocks.read
      .mockResolvedValueOnce(summary)
      .mockResolvedValueOnce({ ...detail, dataHash: "different" });
    const data = await loadUsMarketDataSummary();
    expect(data?.quality).toBeUndefined();
    expect(data?.qualityNote).toContain("일치하지 않아");
    expect(data?.dataHash).toBe("same");
  });
  it("preserves summary if optional detailed quality cannot load", async () => {
    mocks.read.mockResolvedValueOnce(summary);
    mocks.binary.mockRejectedValueOnce(new Error("offline"));
    const data = await loadUsMarketDataSummary();
    expect(data?.qualityNote).toContain("불러오지 못해");
    expect(data?.analysis.rowCount).toBe(1);
  });
});
