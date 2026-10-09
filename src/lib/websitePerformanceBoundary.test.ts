import { describe, expect, it } from "vitest";
import { websiteShadowSummary, visiblePerformanceEvidence } from "./websitePerformanceBoundary";
import { restartSummary } from "../../tests/website-restart-fixtures";
describe("website performance boundary", () => {
  it("keeps valid restart data without changing the persisted source", async () => {
    const original = await restartSummary(true),
      before = structuredClone(original);
    expect(original.books[0]!.status).toBe("RECORDED");
    expect(websiteShadowSummary(original)?.books).toHaveLength(1);
    expect(original).toEqual(before);
  });
  it("rejects beta versions and null", async () => {
    const input = await restartSummary();
    input.version = "adopted-shadow-2026-10-05-v1";
    expect(websiteShadowSummary(input)).toBeNull();
    expect(websiteShadowSummary(null)).toBeNull();
  });
  it.each(["identity", "start", "first", "latest", "history", "trades", "holdings"])(
    "rejects an entire mixed book rather than clipping its curve but retaining beta returns: %s",
    async (field) => {
      const input = await restartSummary(true),
        book = input.books[0]!;
      if (field === "identity") book.bookId = "adopted-shadow-2026-10-05-v1:US_A0";
      if (field === "start") book.scheduledStart = "2026-10-05";
      if (field === "first") book.firstSessionDate = "2026-10-09";
      if (field === "latest") book.latestSessionDate = "2026-10-09";
      if (field === "history") book.history = [{ date: "2026-10-09", nav: 1, benchmark: null }];
      if (field === "trades")
        book.trades = [
          {
            date: "2026-10-09",
            symbol: "SYNTH",
            side: "BUY",
            quantity: "1",
            price: "1",
            reason: "fixture",
          },
        ];
      if (field === "holdings")
        book.holdings = [
          {
            entryDate: "2026-10-09",
            symbol: "SYNTH",
            name: "fixture",
            quantity: "1",
            price: "1",
            value: "1",
          },
        ];
      const before = structuredClone(input);
      expect(websiteShadowSummary(input)?.books).toEqual([]);
      expect(input).toEqual(before);
    },
  );
  it("filters pre-start replay metadata without erasing its source", async () => {
    const input = await restartSummary();
    input.replayStatus = ["2026-10-09", "2026-10-12"].map((signalDate) => ({
      market: "KR",
      signalDate,
      calculatedAt: input.checkedAt,
      sourceCapturedAt: null,
      modelDecisionAt: null,
      executionAt: null,
      replayMode: "RETROSPECTIVE",
      status: "WAITING_INPUT",
      reason: "fixture",
    }));
    expect(websiteShadowSummary(input)?.replayStatus.map((r) => r.signalDate)).toEqual([
      "2026-10-12",
    ]);
    expect(input.replayStatus).toHaveLength(2);
  });
});

it("does not render beta archive metadata or summaries in reviewed-input details, preserving the saved source", () => {
  const input = {
    action: "confirmBaseline",
    baseline: {
      valuation: { date: "2026-10-12", cash: "12765" },
      betaArchive: {
        asOfDate: "2026-10-09",
        summaries: { legacyPnl: "76543210" },
        source: { recordId: "BETA_ONLY" },
      },
    },
  };
  const before = structuredClone(input),
    display = visiblePerformanceEvidence(input);
  expect(display).toContain("12765");
  for (const text of ["betaArchive", "legacyPnl", "76543210", "BETA_ONLY", "2026-10-09"])
    expect(display).not.toContain(text);
  expect(input).toEqual(before);
});
