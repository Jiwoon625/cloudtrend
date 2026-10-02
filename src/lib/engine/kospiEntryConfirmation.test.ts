import { describe, expect, it } from "vitest";
import {
  kospiEntryConfirmation,
  PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
  isKospiEntryReady,
  kospiRelativeReturns,
  buildKospiEntrySnapshot,
  type KospiEntryObservation,
} from "./kospiEntryConfirmation";
import { getMockDataset } from "./mockProvider";
import { DEFAULT_SCORING_CONFIG } from "./scoring";
import type { DailyPrice } from "./types";
const o = (
  date: string,
  score: number | null,
  rsAccel: number | null = 1,
): KospiEntryObservation => ({ date, score, rsAccel, observed: true, eligible: true });
const before = o("2026-10-01", 7.5),
  onset = o("2026-10-02", 8, -2),
  confirm = o("2026-10-05", 8.5);
describe("KOSPI first-session close confirmation", () => {
  it("waits through weekend, judges confirmation RS rather than onset RS and is idempotent", () => {
    const pending = kospiEntryConfirmation(onset, before, o("2026-09-30", 7));
    expect(pending.state).toBe("pending");
    expect(isKospiEntryReady(pending)).toBe(false);
    expect(kospiEntryConfirmation(onset, before, o("2026-09-30", 7))).toEqual(pending);
    const ready = kospiEntryConfirmation(confirm, onset, before);
    expect(ready.state).toBe("confirmed");
    expect(ready.originDate).toBe(onset.date);
    expect(isKospiEntryReady(ready, confirm.date)).toBe(true);
    expect(isKospiEntryReady(ready, "2026-10-06")).toBe(false);
    expect(kospiEntryConfirmation(o("2026-10-06", 9), confirm, onset).state).toBe("none");
  });
  it.each([0, -1])("rejects non-positive confirmation RS %s", (rs) => {
    expect(
      kospiEntryConfirmation({ ...confirm, rsAccel: rs }, { ...onset, rsAccel: 2 }, before).state,
    ).toBe("rejected");
  });
  it("rejects score decline below eight while allowing a confirmation-day upper exit", () => {
    expect(kospiEntryConfirmation({ ...confirm, score: 7.5 }, onset, before).state).toBe(
      "rejected",
    );
    const up95 = kospiEntryConfirmation({ ...confirm, score: 9.5 }, onset, before);
    expect(up95.issues).toEqual([]);
    expect(isKospiEntryReady(up95, confirm.date)).toBe(true);
    expect(
      kospiEntryConfirmation({ ...confirm, score: 9.5 }, { ...onset, score: 9.5 }, before).state,
    ).toBe("confirmed");
  });
  it.each([9.5, 10])("allows UP95 score %s only after the first-session confirmation", (score) => {
    const ready = kospiEntryConfirmation({ ...confirm, score }, onset, before);
    expect(isKospiEntryReady(ready, confirm.date)).toBe(true);
    expect(kospiEntryConfirmation({ ...onset, score }, before, o("2026-09-30", 7)).state).toBe(
      "pending",
    );
    for (const rsAccel of [0, -1, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failed = kospiEntryConfirmation({ ...confirm, score, rsAccel }, onset, before);
      expect(isKospiEntryReady(failed)).toBe(false);
      expect(
        isKospiEntryReady(
          kospiEntryConfirmation(o("2026-10-06", score), { ...confirm, score, rsAccel }, onset),
        ),
      ).toBe(false);
    }
    expect(
      isKospiEntryReady(
        kospiEntryConfirmation({ ...confirm, score, eligible: false }, onset, before),
      ),
    ).toBe(false);
    expect(
      isKospiEntryReady(
        kospiEntryConfirmation({ ...confirm, score, observed: false }, onset, before),
      ),
    ).toBe(false);
  });
  it("retains valid v2 evidence without upgrading rejected, stale or impossible v2 crossings", () => {
    const previous = {
      ...kospiEntryConfirmation(confirm, onset, before),
      version: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
    };
    expect(isKospiEntryReady(previous, confirm.date)).toBe(true);
    expect(isKospiEntryReady(previous, "2026-10-06")).toBe(false);
    expect(isKospiEntryReady({ ...previous, score: 9.5 })).toBe(false);
    expect(isKospiEntryReady({ ...previous, score: 9.5, originScore: 9.5 })).toBe(true);
    expect(
      isKospiEntryReady({
        ...previous,
        state: "rejected",
        eligible: false,
        issues: ["확인일 U9.5 청산신호"],
      }),
    ).toBe(false);
  });
  it("separates unobservable from observed rejection and cannot catch up after a gap", () => {
    for (const missing of [
      { ...confirm, observed: false, score: null, rsAccel: null },
      { ...confirm, score: null },
      { ...confirm, rsAccel: null },
    ]) {
      expect(kospiEntryConfirmation(missing, onset, before).state).toBe("unobservable");
      expect(isKospiEntryReady(kospiEntryConfirmation(missing, onset, before))).toBe(false);
      expect(isKospiEntryReady(kospiEntryConfirmation(o("2026-10-06", 9), missing, onset))).toBe(
        false,
      );
    }
  });
  it("does not impose a price non-decline condition or require an onset-day run", () => {
    const result = kospiEntryConfirmation({ ...confirm, score: 8 }, onset, before);
    expect(isKospiEntryReady(result)).toBe(true);
  });
  it("uses adoption confirmation date, allowing an observed prior-day onset", () => {
    expect(
      isKospiEntryReady(
        kospiEntryConfirmation(o("2026-10-02", 8.5), o("2026-10-01", 8), o("2026-09-30", 7.5)),
      ),
    ).toBe(true);
    const old = kospiEntryConfirmation(
      o("2026-10-01", 8.5),
      o("2026-09-30", 8),
      o("2026-09-29", 7.5),
    );
    expect(old.state).toBe("confirmed");
    expect(isKospiEntryReady(old)).toBe(false);
  });
  it("does not let repeated dates count as a new trading session", () => {
    expect(
      isKospiEntryReady(kospiEntryConfirmation({ ...confirm, date: onset.date }, onset, before)),
    ).toBe(false);
  });
});
describe("KOSPI dated source reconstruction", () => {
  const ds = getMockDataset();
  it("marks stale symbols and missing benchmark observation as unobservable", () => {
    const inst = ds.instruments.find((i) => i.market === "KOSPI" && i.instrumentType === "STOCK")!;
    const stale = {
      ...ds,
      bars: { ...ds.bars, [inst.symbol]: ds.bars[inst.symbol]!.slice(0, -1) },
    };
    expect(buildKospiEntrySnapshot(stale, inst.symbol, DEFAULT_SCORING_CONFIG).entry.state).toBe(
      "unobservable",
    );
    const noIndex = { ...ds, indexSeries: ds.indexSeries.filter((i) => i.indexCode !== "KOSPI") };
    expect(buildKospiEntrySnapshot(noIndex, inst.symbol, DEFAULT_SCORING_CONFIG).entry.state).toBe(
      "unobservable",
    );
  });
  it("aligns 20/60 excess returns to market dates and never zero-fills missing prices", () => {
    const dates = Array.from({ length: 61 }, (_, i) => String(i).padStart(3, "0"));
    const bars = dates.map(
      (tradeDate, i) => ({ tradeDate, close: i === 60 ? 150 : i === 40 ? 120 : 100 }) as DailyPrice,
    );
    const index = dates.map((tradeDate) => ({ tradeDate, close: 100 }) as DailyPrice);
    const r = kospiRelativeReturns(bars, index, dates, "060");
    expect(r.rs20).toBeCloseTo(25);
    expect(r.rs60).toBeCloseTo(50);
    expect(r.rsAccel).toBeCloseTo(-25);
    expect(
      kospiRelativeReturns(
        bars.filter((b) => b.tradeDate !== "050"),
        index,
        dates,
        "060",
      ).rsAccel,
    ).toBeNull();
    expect(kospiRelativeReturns(bars, index.slice(0, -1), dates, "060").rsAccel).toBeNull();
  });
});
