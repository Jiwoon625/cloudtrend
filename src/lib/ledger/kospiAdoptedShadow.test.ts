import { describe, expect, it } from "vitest";
import { KOSPI_SHADOW_POLICY, stepKospiShadow, type KospiShadowRow } from "../engine/kospiShadow";
import { decimal } from "./decimal";
import { stepAdoptedKospiShadowSeries, type AdoptedKospiShadowInput } from "./kospiAdoptedShadow";
import { freezeAdoptedSeries, hashSeriesValue, type ModelCalendar } from "./modelSeries";
import { nextReviewedRegularSession, regularOpenAt } from "./octoberShadowCalendar";

const codeHash = `sha256:${"a".repeat(64)}` as const;
const sourceHash = `sha256:${"b".repeat(64)}` as const;
const create = () =>
  freezeAdoptedSeries({
    kind: "KR_KOSPI_CONFIRM1_BEAR",
    codeHash,
    sourceHash,
    frozenAt: "2026-10-08T15:37:00Z",
  });
const calendar: ModelCalendar = {
  market: "KR",
  sourceHash,
  coverageStart: "2026-10-12",
  coverageEnd: "2026-10-20",
  regularSessions: [
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-19",
    "2026-10-20",
  ],
};
function beforeNextOpen(date: string, minutes: number) {
  const next = nextReviewedRegularSession("KR", date);
  if (!next) throw new Error("Reviewed next KR session required in fixture");
  return new Date(Date.parse(regularOpenAt("KR", next)) - minutes * 60 * 1000).toISOString();
}
const finalizedAt = (date: string) => beforeNextOpen(date, 70);
const decisionAt = (date: string) => beforeNextOpen(date, 50);
const row = (date: string, score = 7, patch: Partial<KospiShadowRow> = {}): KospiShadowRow => ({
  symbol: "005930",
  name: "삼성전자",
  sector: "IT",
  date,
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
function input(date: string, configHash: string, score = 7): AdoptedKospiShadowInput {
  return {
    calendar,
    decisionAt: decisionAt(date),
    codeHash,
    configHash,
    session: {
      date,
      previousSessionDate: calendar.regularSessions.filter((day) => day < date).at(-1) ?? null,
      sourceHash,
      codeVersion: codeHash,
      configHash,
      sourceCollectedAt: finalizedAt(date),
      confirmedClose: true,
      benchmarkClose: 2500,
      gate: { date, status: "NEUTRAL", issues: [] },
      rows: [row(date, score)],
    },
  };
}
async function pending() {
  const series = await create();
  const first = await stepAdoptedKospiShadowSeries(series, input("2026-10-12", series.configHash));
  const onset = await stepAdoptedKospiShadowSeries(
    series,
    input("2026-10-13", series.configHash, 8),
    first.run,
  );
  const confirmed = await stepAdoptedKospiShadowSeries(
    series,
    input("2026-10-14", series.configHash, 9.5),
    onset.run,
  );
  return { series, first, onset, confirmed };
}

describe("isolated October KOSPI confirm1/bear-only journal adapter", () => {
  it("starts Oct12 v2 accounting with Oct12 observations, no inherited history, and immutable reuse", async () => {
    const series = await create();
    const source = input("2026-10-12", series.configHash, 9.5);
    const saved = structuredClone(source);
    const first = await stepAdoptedKospiShadowSeries(series, source);
    expect(first.run.firstValidSessionDate).toBe("2026-10-12");
    expect(first.run.result.state).toMatchObject({
      initializedDate: "2026-10-12",
      lastDate: "2026-10-12",
      cashKrw: 100000000,
      modelCashExact: "100000000",
      modelFeesExact: "0",
      positions: {},
      awaiting: [],
      pendingEntries: [],
      pendingExits: {},
    });
    expect(first.run.result.trades).toEqual([]);
    expect(source).toEqual(saved);
    expect(Object.isFrozen(first.run.result.state)).toBe(true);
    expect((await stepAdoptedKospiShadowSeries(series, source, first.run)).run).toBe(first.run);
    const { stateHash, ...body } = first.run;
    expect(await hashSeriesValue(body)).toBe(stateHash);
  });

  it("can use Oct8 warmup only to detect a new Oct12 onset, never pre-start pending intent", async () => {
    const series = await create();
    const source = input("2026-10-12", series.configHash, 8);
    source.session.warmupRows = [row("2026-10-08", 7)];
    const first = await stepAdoptedKospiShadowSeries(series, source);
    expect(first.run.result.state.awaiting[0]).toMatchObject({
      originDate: "2026-10-12",
      status: "AWAITING_CONFIRMATION",
    });
    expect(first.run.result.state.pendingEntries).toEqual([]);
    expect(first.run.result.trades).toEqual([]);
    expect((await stepAdoptedKospiShadowSeries(series, source, first.run)).status).toBe("REUSE");
    const confirmed = await stepAdoptedKospiShadowSeries(
      series,
      input("2026-10-13", series.configHash, 9.5),
      first.run,
    );
    expect(confirmed.run.result.state.pendingEntries[0]?.originDate).toBe("2026-10-12");
    const heldAbove = {
      ...source,
      session: { ...source.session, warmupRows: [row("2026-10-08", 8)] },
    };
    expect(
      (await stepAdoptedKospiShadowSeries(series, heldAbove)).run.result.state.awaiting,
    ).toEqual([]);
    await expect(
      stepAdoptedKospiShadowSeries(series, {
        ...source,
        session: { ...source.session, warmupRows: [row("2026-10-07", 7)] },
      }),
    ).rejects.toThrow("warmup");
  });

  it("fills integer shares within fixed fee-inclusive 100m/30 and preserves legacy sizing", async () => {
    const { series, confirmed } = await pending();
    const source = input("2026-10-15", series.configHash, 9.6);
    const next = await stepAdoptedKospiShadowSeries(series, source, confirmed.run);
    expect(next.run.result.trades[0]).toMatchObject({
      shares: 33283,
      feeKrw: 4992.45,
      side: "BUY",
      executionDate: "2026-10-15",
      originDate: "2026-10-13",
    });
    expect(next.run.result.state.modelCashExact).toBe("96666707.55");
    expect(
      decimal(next.run.result.state.positions["005930"]!.modelBasisExact!),
    ).toBeLessThanOrEqual(decimal("3333333.33333333"));
    expect(confirmed.run.result.state.positions).toEqual({});
    const legacyFirst = stepKospiShadow(input("2026-10-12", series.configHash).session, null);
    const legacyOnset = stepKospiShadow(
      input("2026-10-13", series.configHash, 8).session,
      legacyFirst.state,
    );
    const legacyConfirmed = stepKospiShadow(
      input("2026-10-14", series.configHash, 9.5).session,
      legacyOnset.state,
    );
    const legacyFill = stepKospiShadow(source.session, legacyConfirmed.state);
    expect(legacyFill.trades[0]!.shares).toBe(33333);
    expect(legacyFill.state.executionPolicy).toBeUndefined();
    const changedNav = structuredClone(confirmed.run.result.state);
    changedNav.lastNavKrw = 120000000;
    const stillFixed = stepKospiShadow(source.session, changedNav, changedNav.executionPolicy);
    expect(stillFixed.trades[0]!.shares).toBe(33283);
  });

  it("never forces an oversized share and accounts for exact exit fees and realized P&L", async () => {
    const { series, confirmed } = await pending();
    const oversized = input("2026-10-15", series.configHash, 9);
    oversized.session.rows[0]!.open = 4000000;
    const skipped = await stepAdoptedKospiShadowSeries(series, oversized, confirmed.run);
    expect(skipped.run.result.trades).toEqual([]);
    expect(skipped.run.result.state.modelCashExact).toBe("100000000");
    expect(skipped.run.result.state.pendingEntries).toEqual([]);
    const bought = await stepAdoptedKospiShadowSeries(
      series,
      input("2026-10-15", series.configHash, 9),
      confirmed.run,
    );
    const exit = await stepAdoptedKospiShadowSeries(
      series,
      input("2026-10-16", series.configHash, 9.5),
      bought.run,
    );
    const fill = input("2026-10-19", series.configHash, 9.5);
    fill.session.rows[0]!.open = 110;
    const sold = await stepAdoptedKospiShadowSeries(series, fill, exit.run);
    expect(sold.run.result.trades[0]).toMatchObject({
      side: "SELL",
      shares: 33283,
      feeKrw: 5491.695,
      realizedPnlKrw: 322345.855,
    });
    expect(sold.run.result.state.positions).toEqual({});
    expect(sold.run.result.state.modelCashExact).toBe("100322345.855");
    expect(sold.run.result.state.modelFeesExact).toBe("10484.145");
  });

  it("rejects pre-start pending/observation state even on the raw isolated engine path", async () => {
    const { series, confirmed } = await pending();
    for (const patch of ["candidate", "observation"] as const) {
      const dirty = structuredClone(confirmed.run.result.state);
      if (patch === "candidate") dirty.pendingEntries[0]!.originDate = "2026-10-08";
      else dirty.previousRows["005930"]!.date = "2026-10-08";
      expect(() =>
        stepKospiShadow(
          input("2026-10-15", series.configHash).session,
          dirty,
          dirty.executionPolicy,
        ),
      ).toThrow("Pre-start");
    }
  });

  it.each(["RISK_ON", "NEUTRAL", "RISK_OFF"] as const)(
    "freezes %s onset regime, retaining bear-only RSAccel and permitted confirmation UP95",
    async (regime) => {
      const series = await create();
      const first = await stepAdoptedKospiShadowSeries(
        series,
        input("2026-10-12", series.configHash),
      );
      const onsetInput = input("2026-10-13", series.configHash, 8);
      onsetInput.session.gate.status = regime;
      const onset = await stepAdoptedKospiShadowSeries(series, onsetInput, first.run);
      const confirmInput = input("2026-10-14", series.configHash, 9.5);
      confirmInput.session.rows[0]!.rsAccel = 0;
      confirmInput.session.gate.status = regime === "RISK_OFF" ? "RISK_ON" : "RISK_OFF";
      const confirmed = await stepAdoptedKospiShadowSeries(series, confirmInput, onset.run);
      expect(confirmed.run.result.candidates[0]).toMatchObject({
        onsetRegime: regime,
        confirmationUp95: true,
      });
      expect(confirmed.run.result.state.pendingEntries.length).toBe(regime === "RISK_OFF" ? 0 : 1);
      expect(confirmed.run.result.policy).toEqual(KOSPI_SHADOW_POLICY);
    },
  );

  it("rejects calendar gaps, altered coverage, late data, unconfirmed close and non-session decisions", async () => {
    const series = await create();
    const first = await stepAdoptedKospiShadowSeries(
      series,
      input("2026-10-12", series.configHash),
    );
    await expect(
      stepAdoptedKospiShadowSeries(series, input("2026-10-14", series.configHash), first.run),
    ).rejects.toThrow("consecutive");
    const removed = input("2026-10-14", series.configHash);
    removed.calendar = {
      ...calendar,
      regularSessions: calendar.regularSessions.filter((day) => day !== "2026-10-13"),
    };
    removed.session.previousSessionDate = "2026-10-12";
    await expect(stepAdoptedKospiShadowSeries(series, removed, first.run)).rejects.toThrow(
      "calendar coverage changed",
    );
    const wrongPrevious = input("2026-10-13", series.configHash);
    wrongPrevious.session.previousSessionDate = "2026-10-08";
    await expect(stepAdoptedKospiShadowSeries(series, wrongPrevious, first.run)).rejects.toThrow(
      "exact previous",
    );
    for (const source of [
      { ...input("2026-10-13", series.configHash), decisionAt: "2026-10-14T08:10:00Z" },
      { ...input("2026-10-13", series.configHash), decisionAt: "2026-10-13T07:00:00Z" },
      {
        ...input("2026-10-13", series.configHash),
        session: { ...input("2026-10-13", series.configHash).session, confirmedClose: false },
      },
      {
        ...input("2026-10-13", series.configHash),
        session: {
          ...input("2026-10-13", series.configHash).session,
          sourceCollectedAt: "2026-10-14T07:00:00Z",
        },
      },
    ])
      await expect(stepAdoptedKospiShadowSeries(series, source, first.run)).rejects.toThrow(
        "T+1 pre-open",
      );
    await expect(
      stepAdoptedKospiShadowSeries(series, input("2026-10-08", series.configHash)),
    ).rejects.toThrow("post-start");
    await expect(
      stepAdoptedKospiShadowSeries(series, input("2027-10-05", series.configHash)),
    ).rejects.toThrow("first year");
  });

  it("rejects same-date changes, state tampering, changed code/config and cross-series state", async () => {
    const series = await create();
    const source = input("2026-10-12", series.configHash);
    const first = await stepAdoptedKospiShadowSeries(series, source);
    const changed = structuredClone(source);
    changed.session.rows[0]!.close = 101;
    await expect(stepAdoptedKospiShadowSeries(series, changed, first.run)).rejects.toThrow(
      "Same-date",
    );
    const dirty = structuredClone(first.run);
    dirty.result.state.cashKrw += 1;
    await expect(
      stepAdoptedKospiShadowSeries(series, input("2026-10-13", series.configHash), dirty),
    ).rejects.toThrow("provenance");
    await expect(
      stepAdoptedKospiShadowSeries(
        series,
        {
          ...source,
          codeHash: sourceHash,
          session: { ...source.session, codeVersion: sourceHash },
        },
        first.run,
      ),
    ).rejects.toThrow("Frozen code/config");
    await expect(
      stepAdoptedKospiShadowSeries(
        series,
        {
          ...source,
          configHash: sourceHash,
          session: { ...source.session, configHash: sourceHash },
        },
        first.run,
      ),
    ).rejects.toThrow("Frozen code/config");
    await expect(
      stepAdoptedKospiShadowSeries(series, source, { ...first.run, bookId: "ACTUAL" }),
    ).rejects.toThrow("other model");
    const baseline = await freezeAdoptedSeries({
      kind: "KR_KOSPI",
      codeHash,
      sourceHash,
      frozenAt: "2026-10-08T15:37:00Z",
    });
    await expect(stepAdoptedKospiShadowSeries(baseline, source)).rejects.toThrow(
      "unchanged isolated",
    );
    expect(() =>
      stepKospiShadow(input("2026-10-13", series.configHash).session, first.run.result.state),
    ).toThrow("legacy Shadow");
    const legacy = stepKospiShadow(source.session, null);
    expect(() =>
      stepKospiShadow(
        input("2026-10-13", series.configHash).session,
        legacy.state,
        first.run.result.state.executionPolicy,
      ),
    ).toThrow("frozen execution policy");
  });
});
