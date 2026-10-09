import { describe, it, expect } from "vitest";
import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiShadowSession,
  type KospiShadowRow,
  type KospiShadowState,
} from "./kospiShadow";
const row = (score = 7, patch: Partial<KospiShadowRow> = {}): KospiShadowRow => ({
  symbol: "005930",
  name: "삼성전자",
  sector: "IT",
  date: "2026-10-02",
  open: 100,
  close: 100,
  volume: 1000,
  score,
  priority: 1,
  rsAccel: 1,
  commonHistory: true,
  onsetEligible: true,
  ...patch,
});
const day = (
  date: string,
  prev: string | null,
  score = 7,
  patch: Partial<KospiShadowSession> = {},
): KospiShadowSession => ({
  date,
  previousSessionDate: prev,
  sourceHash: `hash:${date}`,
  configHash: "config-v1",
  codeVersion: "sha1",
  sourceCollectedAt: `${date}T08:00:00Z`,
  confirmedClose: true,
  benchmarkClose: 2500,
  gate: { date, status: "NEUTRAL", issues: [] },
  rows: [row(score, { date })],
  ...patch,
});
function baseline() {
  return stepKospiShadow(day("2026-10-02", "2026-10-01"), null);
}
function onset(regime = "NEUTRAL" as "NEUTRAL" | "RISK_OFF" | "RISK_ON" | "UNKNOWN") {
  return stepKospiShadow(
    day("2026-10-05", "2026-10-02", 8, {
      gate: { date: "2026-10-05", status: regime, issues: [] },
    }),
    baseline().state,
  );
}
function confirmed() {
  return stepKospiShadow(day("2026-10-06", "2026-10-05", 9), onset().state);
}
describe("isolated KOSPI research Shadow", () => {
  it("does not create or confirm model entry intent from missing universe data", () => {
    const pendingOnset = stepKospiShadow(
      day("2026-10-05", "2026-10-02", 8, {
        rows: [row(8, { date: "2026-10-05", universeDataPending: true })],
      }),
      baseline().state,
    );
    expect(pendingOnset.state.awaiting).toEqual([]);
    expect(pendingOnset.candidates).toEqual([]);
    expect(pendingOnset.state.previousRows["005930"]?.score).toBe(8);
    const pendingConfirmation = stepKospiShadow(
      day("2026-10-06", "2026-10-05", 9, {
        rows: [row(9, { date: "2026-10-06", universeDataPending: true })],
      }),
      onset().state,
    );
    expect(pendingConfirmation.state.pendingEntries).toEqual([]);
    expect(pendingConfirmation.candidates[0]).toMatchObject({
      status: "EXCLUDED",
      reason: "CONFIRMATION_UNIVERSE_DATA_PENDING",
      confirmationScore: 9,
    });
  });
  it("keeps prior valid open orders and held exits independent from later close-time pending data", () => {
    const filled = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 9, {
        rows: [row(9, { date: "2026-10-07", universeDataPending: true })],
      }),
      confirmed().state,
    );
    expect(filled.trades[0]?.side).toBe("BUY");
    const held = stepKospiShadow(
      day("2026-10-08", "2026-10-07", 9.5, {
        rows: [row(9.5, { date: "2026-10-08", universeDataPending: true })],
      }),
      filled.state,
    );
    expect(held.state.pendingExits["005930"]?.reason).toBe("UP95");
    const exited = stepKospiShadow(
      day("2026-10-09", "2026-10-08", 9.5, {
        rows: [row(9.5, { date: "2026-10-09", universeDataPending: true })],
      }),
      held.state,
    );
    expect(exited.trades[0]).toMatchObject({ side: "SELL", reason: "UP95" });
    expect(exited.state.positions).toEqual({});
  });
  it("starts in cash without historical candidates, executions or actual records", () => {
    const result = stepKospiShadow(day("2026-10-02", "2026-10-01", 9.5), null);
    expect(result.state.cashKrw).toBe(100_000_000);
    expect(result.trades).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.state.awaiting).toEqual([]);
    expect(result.daily.cagr).toBeNull();
  });
  it("blocks confirmation at or above 9.5 for every origin regime, even without a fresh UP95 crossing", () => {
    for (const regime of ["RISK_ON", "NEUTRAL", "RISK_OFF"] as const) {
      for (const score of [9.5, 10]) {
        const s = onset(regime);
        const prev = structuredClone(s.state);
        const r = stepKospiShadow(
          day("2026-10-06", "2026-10-05", score, {
            gate: { date: "2026-10-06", status: "RISK_OFF", issues: [] },
            rows: [row(score, { date: "2026-10-06", rsAccel: 1 })],
          }),
          s.state,
        );
        expect(r.candidates[0]).toMatchObject({
          status: "EXCLUDED",
          reason: "CONFIRMATION_AT_OR_ABOVE_UPSIDE_EXIT",
          confirmationScore: score,
          onsetRegime: regime,
        });
        expect(r.state.pendingEntries).toEqual([]);
        expect(s.state).toEqual(prev);
      }
    }
    const overshootOnset = stepKospiShadow(day("2026-10-05", "2026-10-02", 9.5), baseline().state);
    const noFreshCross = stepKospiShadow(
      day("2026-10-06", "2026-10-05", 9.5),
      overshootOnset.state,
    );
    expect(noFreshCross.candidates[0]?.confirmationUp95).toBe(false);
    expect(noFreshCross.candidates[0]?.reason).toBe("CONFIRMATION_AT_OR_ABOVE_UPSIDE_EXIT");
    expect(noFreshCross.state.pendingEntries).toEqual([]);
  });
  it("requires positive RS only for frozen bear origin even after regime improves", () => {
    for (const rs of [null, 0, -1]) {
      const r = stepKospiShadow(
        day("2026-10-06", "2026-10-05", 8, { rows: [row(8, { date: "2026-10-06", rsAccel: rs })] }),
        onset("RISK_OFF").state,
      );
      expect(r.candidates[0]?.status).toBe("EXCLUDED");
      expect(r.state.pendingEntries).toEqual([]);
    }
    expect(
      stepKospiShadow(day("2026-10-06", "2026-10-05", 8), onset("RISK_OFF").state).state
        .pendingEntries,
    ).toHaveLength(1);
  });
  it("unknown origin is excluded and cannot be reclassified on a later date", () => {
    const s = onset("UNKNOWN");
    expect(s.candidates[0]?.reason).toBe("ONSET_REGIME_UNOBSERVABLE");
    expect(
      stepKospiShadow(day("2026-10-06", "2026-10-05", 9), s.state).state.pendingEntries,
    ).toEqual([]);
  });
  it("fills only the following open, exact prior-close sizing and fees, and no primary/actual fields", () => {
    const c = confirmed();
    expect(c.trades).toHaveLength(0);
    const r = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 9.6, {
        rows: [row(9.6, { date: "2026-10-07", open: 100, close: 110 })],
      }),
      c.state,
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({
      side: "BUY",
      shares: 33333,
      price: 100,
      feeKrw: 4999.95,
      modelOnly: true,
      strategyId: KOSPI_SHADOW_POLICY.id,
    });
    expect(r.daily.navKrw).toBeCloseTo(100328330.05);
    expect(r.state.totalEntries).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(
      /actual_shares|actual_price|kospiEightPointEntry|A0_QUARTER_PRIMARY/,
    );
  });
  it("confirms exactly the next market session across holidays, never next available stock bar", () => {
    const r = stepKospiShadow(day("2026-10-07", "2026-10-05", 8), onset().state);
    expect(r.state.pendingEntries).toHaveLength(1);
    const missing = stepKospiShadow(
      day("2026-10-06", "2026-10-05", 8, { rows: [] }),
      onset().state,
    );
    expect(missing.candidates[0]?.reason).toBe("CONFIRMATION_SCORE_MISSING");
    expect(
      stepKospiShadow(day("2026-10-07", "2026-10-06", 9), missing.state).state.pendingEntries,
    ).toEqual([]);
  });
  it("rejects duplicate/stale dates, gaps, config changes, duplicate symbols and unconfirmed data", () => {
    const s = baseline().state;
    for (const input of [
      day("2026-10-02", "2026-10-01"),
      day("2026-10-01", "2026-09-30"),
      day("2026-10-06", "2026-10-05"),
      day("2026-10-05", "2026-10-02", 8, { configHash: "new" }),
      day("2026-10-05", "2026-10-02", 8, { confirmedClose: false }),
      day("2026-10-05", "2026-10-02", 8, {
        rows: [row(8, { date: "2026-10-05" }), row(8, { date: "2026-10-05" })],
      }),
    ])
      expect(() => stepKospiShadow(input, s)).toThrow();
  });
  it("missing executable open skips entry permanently and does not spend cash", () => {
    const r = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 9.5, { rows: [row(9.5, { date: "2026-10-07", volume: 0 })] }),
      confirmed().state,
    );
    expect(r.candidates[0]?.reason).toBe("NO_EXECUTABLE_OPEN_NO_LATE_RETRY");
    expect(r.state.cashKrw).toBe(100_000_000);
    expect(r.state.pendingEntries).toEqual([]);
  });
  it("replay from preceding snapshot is deterministic, with immutable source object", () => {
    const p = confirmed().state,
      d = day("2026-10-07", "2026-10-06", 9.5),
      copy = structuredClone(p);
    expect(stepKospiShadow(d, p)).toEqual(stepKospiShadow(d, p));
    expect(p).toEqual(copy);
  });
  it("enforces three per sector and thirty positions", () => {
    const s = confirmed().state,
      c = s.pendingEntries[0]!;
    s.pendingEntries = Array.from({ length: 40 }, (_, i) => ({
      ...c,
      key: `S${i}|${c.originDate}`,
      symbol: `S${i}`,
      sector: "IT",
    }));
    let r = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 9, {
        rows: s.pendingEntries.map((c) => row(9, { symbol: c.symbol, date: "2026-10-07" })),
      }),
      s,
    );
    expect(r.daily.positions).toBe(3);
    expect(r.candidates.filter((c) => c.reason === "SECTOR_CAP")).toHaveLength(37);
    s.pendingEntries = s.pendingEntries.map((c, i) => ({ ...c, sector: `sector${i}` }));
    r = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 9, {
        rows: s.pendingEntries.map((c) => row(9, { symbol: c.symbol, date: "2026-10-07" })),
      }),
      s,
    );
    expect(r.daily.positions).toBe(30);
    expect(r.state.cashKrw).toBeGreaterThanOrEqual(0);
  });
  it("preserves UP95 held exits, never bear-liquidates, and reports stale marks", () => {
    const s = stepKospiShadow(day("2026-10-07", "2026-10-06", 9), confirmed().state).state;
    const bear = stepKospiShadow(
      day("2026-10-08", "2026-10-07", 9, {
        gate: { date: "2026-10-08", status: "RISK_OFF", issues: [] },
      }),
      s,
    );
    expect(bear.trades).toEqual([]);
    expect(bear.daily.positions).toBe(1);
    const exit = stepKospiShadow(day("2026-10-09", "2026-10-08", 9.5), bear.state);
    expect(exit.state.pendingExits["005930"]?.reason).toBe("UP95");
    const missing = stepKospiShadow(day("2026-10-12", "2026-10-09", 9.5, { rows: [] }), exit.state);
    expect(missing.daily.staleMarks).toEqual(["005930"]);
    expect(missing.state.pendingExits["005930"]).toBeTruthy();
    const sold = stepKospiShadow(day("2026-10-13", "2026-10-12", 9.5), missing.state);
    expect(sold.trades[0]?.side).toBe("SELL");
  });
  it("H60 tradable close and deferred open, while confirmation exit-score block still wins", () => {
    const s: KospiShadowState = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 7),
      confirmed().state,
    ).state;
    s.positions["005930"]!.heldSessions = 58;
    const o = stepKospiShadow(day("2026-10-08", "2026-10-07", 8), s);
    const r = stepKospiShadow(day("2026-10-09", "2026-10-08", 9.5), o.state);
    expect(r.trades[0]?.reason).toBe("H60_CLOSE");
    expect(r.candidates[0]?.reason).toBe("CONFIRMATION_AT_OR_ABOVE_UPSIDE_EXIT");
    const halted = stepKospiShadow(
      day("2026-10-09", "2026-10-08", 9, { rows: [row(9, { date: "2026-10-09", volume: 0 })] }),
      o.state,
    );
    expect(halted.state.pendingExits["005930"]?.reason).toBe("H60_DEFERRED_OPEN");
    expect(halted.daily.positions).toBe(1);
  });
  it("calculates NAV, session-based CAGR, MDD and cumulative mean exposure independently", () => {
    let s = confirmed();
    s = stepKospiShadow(
      day("2026-10-07", "2026-10-06", 9, { rows: [row(9, { date: "2026-10-07", close: 80 })] }),
      s.state,
    );
    expect(s.daily.navKrw).toBeCloseTo(s.daily.cashKrw + 33333 * 80);
    expect(s.daily.mdd).toBeCloseTo(s.daily.navKrw / 100_000_000 - 1);
    expect(s.daily.cagr).toBeCloseTo((s.daily.navKrw / 100_000_000) ** (252 / 3) - 1);
    expect(s.daily.averageExposure).toBeCloseTo(s.daily.exposure / 4);
  });
});

it("counts actual symbol observations in the restart, carries zero-volume entry and closes missing holdings at the previous open", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const policy = {
    version: "isolated-kospi-model-v1" as const,
    bookId: "adopted-shadow-2026-10-12-v1:KR_KOSPI_CONFIRM1_BEAR",
    contractHash: hash,
    codeHash: hash,
    configHash: hash,
    accountingStartDate: "2026-10-12" as const,
    fixedBudgetEndExclusive: "2027-10-12" as const,
    initialCapitalKrw: "100000000" as const,
    oneWayCost: "0.0015" as const,
  };
  const session = (
    date: string,
    previous: string,
    score: number,
    patch: Partial<KospiShadowSession> = {},
  ) => day(date, previous, score, { configHash: hash, codeVersion: hash, ...patch });
  const first = stepKospiShadow(
    session("2026-10-12", "2026-10-08", 9.5, { warmupRows: [row(7, { date: "2026-10-08" })] }),
    null,
    policy,
  );
  const ready = stepKospiShadow(session("2026-10-13", "2026-10-12", 9.5), first.state, policy);
  expect(ready.state.pendingEntries).toHaveLength(1);
  const delayed = stepKospiShadow(
    session("2026-10-14", "2026-10-13", 9.5, {
      rows: [row(9.5, { date: "2026-10-14", volume: 0 })],
    }),
    ready.state,
    policy,
  );
  expect(delayed.trades).toHaveLength(0);
  expect(delayed.state.pendingEntries).toHaveLength(1);
  const bought = stepKospiShadow(session("2026-10-15", "2026-10-14", 9.5), delayed.state, policy);
  expect(bought.trades[0]?.side).toBe("BUY");
  expect(bought.state.positions["005930"]!.heldSessions).toBe(1);
  const absent = stepKospiShadow(
    session("2026-10-16", "2026-10-15", 9.5, {
      rows: [
        row(9.5, {
          date: "2026-10-16",
          open: null,
          close: null,
          volume: null,
          priceObserved: false,
        }),
      ],
    }),
    bought.state,
    policy,
  );
  expect(absent.state.positions["005930"]!.heldSessions).toBe(1);
  const observed = stepKospiShadow(session("2026-10-19", "2026-10-16", 9.5), absent.state, policy);
  expect(observed.state.positions["005930"]!.heldSessions).toBe(2);
  const sold = stepKospiShadow(
    session("2026-10-20", "2026-10-19", 9.5, {
      rows: [row(7, { symbol: "000660", date: "2026-10-20" })],
    }),
    observed.state,
    policy,
  );
  expect(sold.trades[0]).toMatchObject({
    side: "SELL",
    price: 100,
    reason: "MODEL_UNOBSERVED_PREVIOUS_OPEN:2026-10-19",
  });
  expect(Object.keys(sold.state.positions)).toHaveLength(0);
});
