import { describe, expect, it } from "vitest";
import {
  historyScoreLabel,
  historyEtfOnsetLabel,
  historyEntryStatus,
} from "./historyEntryPresentation";
import type { SnapshotEntry } from "@/lib/screeningSnapshot";
const entry = (patch: Partial<SnapshotEntry>) =>
  ({
    instrumentType: "ETF",
    technicalPoints: 47.70830797054343,
    ...patch,
  }) as SnapshotEntry;
describe("archived score labels", () => {
  it("keeps a known rejection visible alongside pending universe inputs", () => {
    const row = entry({
      hardFilterStatus: "PENDING",
      pendingRules: ["KRX 시총 대기"],
      kospiEntry: { state: "rejected", issues: ["RISK_OFF"] } as SnapshotEntry["kospiEntry"],
    });
    expect(historyEntryStatus(row)).toContain("신규 진입 제외");
    expect(historyEntryStatus(row)).toContain("판단 보류 · KRX 시총 대기");
  });
  it("does not turn pending or unrecorded ETF raw signals into absence", () => {
    expect(historyEtfOnsetLabel(entry({}), "2026-10-12")).toBe("미기록");
    expect(
      historyEtfOnsetLabel(
        entry({
          evidence: {
            etfStrategy: { date: "2026-10-12", dataStatus: "krx_batch_pending", rawOnset: false },
          },
        }),
        "2026-10-12",
      ),
    ).toBe("미확인");
    expect(
      historyEtfOnsetLabel(
        entry({
          evidence: { etfStrategy: { date: "2026-10-12", dataStatus: "ready", rawOnset: false } },
        }),
        "2026-10-12",
      ),
    ).toBe("없음");
  });
  it("keeps technical points separate from unavailable M0 and rounds display only", () => {
    const row = entry({
      evidence: { etfStrategy: { date: "2026-10-12", dataStatus: "krx_batch_pending", score: 88 } },
    });
    expect(historyScoreLabel(row, "2026-10-12")).toBe("기술 47.71/100 · M0 미확인");
    expect(row.technicalPoints).toBe(47.70830797054343);
  });
  it("preserves missing archived evidence and only shows a ready dated M0", () => {
    expect(historyScoreLabel(entry({}), "2026-10-12")).toContain("M0 미기록");
    const row = entry({
      evidence: { etfStrategy: { date: "2026-10-12", dataStatus: "ready", score: 82.123 } },
    });
    expect(historyScoreLabel(row, "2026-10-12")).toContain("M0 82.12");
    expect(historyScoreLabel(row, "2026-10-13")).toContain("M0 미확인");
  });
  it("identifies stock and US scales without turning null into zero", () => {
    expect(
      historyScoreLabel(entry({ instrumentType: "STOCK", technicalPoints: 8 }), "2026-10-12"),
    ).toBe("기술 8/10");
    expect(historyScoreLabel(entry({ market: "US", technicalPoints: null }), "2026-10-12")).toBe(
      "Core 미관측",
    );
  });
});
