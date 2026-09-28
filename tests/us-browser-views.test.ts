import { describe, expect, it } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";

describe("US presentation files", () => {
  it("preserves every signal and rank while excluding engine state and shrinking the home response", () => {
    const result = {
      generatedAt: "2026-09-28",
      dataHash: "frozen-hash",
      source: { provider: "Toss", collectedAt: "2026-09-28", schemaVersion: "1", metadata: {} },
      analysis: {
        date: "2026-09-25",
        ruleVersion: "frozen-rule",
        summary: { rankedRows: 5362 },
        state: { betaWeakStreak: { ABC: 3 } },
        rows: Array.from({ length: 5362 }, (_, i) => ({
          symbol: String(i),
          coreRank: i / 5362,
          a0BetaExit: i % 2 === 0,
        })),
      },
    };
    const before = JSON.stringify(result);
    const views = usBrowserViews(result as unknown as UsProspectiveCache);
    expect(JSON.stringify(result)).toBe(before);
    expect(views.summary.analysis.rowCount).toBe(5362);
    expect(views.summary.analysis).not.toHaveProperty("rows");
    expect(views.screening.analysis).not.toHaveProperty("state");
    const wire = gzipSync(JSON.stringify(views.screening));
    expect(JSON.parse(gunzipSync(wire).toString()).analysis.rows).toEqual(result.analysis.rows);
    expect(views.summary.dataHash).toBe(result.dataHash);
    expect(views.screening.analysis.ruleVersion).toBe(result.analysis.ruleVersion);
    expect(JSON.stringify(views.summary).length).toBeLessThan(before.length / 100);
    expect(wire.length).toBeLessThan(before.length / 2);
  });
});
