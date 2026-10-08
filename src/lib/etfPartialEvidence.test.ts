import { describe, expect, it } from "vitest";
import { ETF_POLICY, type EtfStrategySnapshot } from "./engine/etfStrategy";
import type { ScreeningRow } from "./engine/pipeline";
import { etfPartialEvidence } from "./etfPartialEvidence";

const date = "2026-10-07";
function row(overrides: Partial<EtfStrategySnapshot> = {}): ScreeningRow {
  return {
    instrument: {
      symbol: "360750",
      name: "TIGER 미국S&P500",
      instrumentType: "ETF",
      isLeveraged: false,
      isInverse: false,
    },
    snapshot: { tradeDate: date, close: 10000 },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      previousDate: "2026-10-06",
      eligible: false,
      score: null,
      previousScore: 82,
      technical: 80,
      priority: 0,
      health: null,
      environment: 70,
      environmentSource: "own_index_lag1",
      region: "US",
      sector: "MARKET_IDX",
      annualVolatility: 0.2,
      entryWeight: null,
      underlyingClose: null,
      underlyingMa60: null,
      onset: false,
      rawOnset: false,
      entryState: "data_pending",
      originDate: "2026-10-06",
      confirmationDate: date,
      confirmationIssues: ["KRX 일괄 미수신으로 확인 대기"],
      averageTradingValue20: null,
      dataStatus: "krx_batch_pending",
      krxReferenceDate: "2026-10-06",
      exit: null,
      issues: ["KRX 시총·20일 거래대금 필요", "기초지수 MA60·추세 이력 부족"],
      ...overrides,
    },
  } as ScreeningRow;
}

describe("ETF partial evidence presentation", () => {
  it("keeps valid independent components visible without filling KRX-dependent values", () => {
    const input = row();
    const before = structuredClone(input);
    expect(etfPartialEvidence(input, date)).toMatchObject({
      current: true,
      krxPending: true,
      isStrategyTarget: true,
      score: null,
      previousScore: 82,
      previousDate: "2026-10-06",
      technical: 50,
      priority: 0,
      health: null,
      environment: 10.5,
      annualVolatility: 0.2,
      entryWeight: null,
      averageTradingValue20: null,
      underlyingJudgment: "unconfirmed",
    });
    expect(input).toEqual(before);
  });

  it("does not promote contradictory pending scores, health or weights to usable values", () => {
    expect(
      etfPartialEvidence(row({ score: 99, health: 100, entryWeight: 0.1, eligible: true }), date),
    ).toMatchObject({ score: null, health: null, entryWeight: null });
  });

  it("shows an observed zero only when that component has valid evidence", () => {
    expect(
      etfPartialEvidence(
        row({
          dataStatus: "ready",
          eligible: true,
          technical: 0,
          priority: 0,
          health: 0,
          environment: 0,
          score: 0,
          annualVolatility: 0,
          averageTradingValue20: 0,
          entryWeight: 0.1,
          issues: [],
        }),
        date,
      ),
    ).toMatchObject({
      technical: 0,
      priority: 0,
      health: 0,
      environment: 0,
      score: 0,
      annualVolatility: 0,
      averageTradingValue20: 0,
      entryWeight: 0.1,
    });
  });

  it("does not convert absent or explicitly unavailable inputs into zero-valued components", () => {
    const missing = row();
    delete missing.etfStrategy;
    expect(etfPartialEvidence(missing, date)).toMatchObject({
      current: false,
      technical: null,
      priority: null,
      health: null,
      environment: null,
      score: null,
    });
    expect(
      etfPartialEvidence(
        row({
          dataStatus: "incomplete",
          technical: 0,
          priority: 0,
          health: 0,
          environment: 0,
          score: 0,
          environmentSource: "unavailable",
          issues: ["기술점수 이력 부족", "벤치마크 수익률 없음", "KRX 시총·20일 거래대금 필요"],
        }),
        date,
      ),
    ).toMatchObject({
      technical: null,
      priority: null,
      health: null,
      environment: null,
      score: null,
    });
  });

  it.each([{ version: "legacy" }, { date: "2026-10-06" }, { date: "" }, { dataStatus: undefined }])(
    "rejects incomplete or non-current stored provenance: %j",
    (override) => {
      const input = row(override as Partial<EtfStrategySnapshot>);
      expect(etfPartialEvidence(input, date)).toMatchObject({
        current: false,
        krxPending: false,
        technical: null,
        priority: null,
        health: null,
        environment: null,
        previousScore: null,
        annualVolatility: null,
        underlyingJudgment: "unconfirmed",
      });
    },
  );

  it("rejects a stale price snapshot even when strategy fields claim the current date", () => {
    const input = row();
    input.snapshot.tradeDate = "2026-10-06";
    expect(etfPartialEvidence(input, date).current).toBe(false);
    expect(etfPartialEvidence(input, date).technical).toBeNull();
  });

  it("does not borrow undated or future prior M0 and lagged environment values", () => {
    for (const previousDate of [null, "", date, "2026-10-08"]) {
      expect(etfPartialEvidence(row({ previousDate }), date)).toMatchObject({
        previousScore: null,
        environment: null,
        technical: 50,
      });
    }
  });

  it("retains short-history Priority and volatility when the technical component is unavailable", () => {
    expect(
      etfPartialEvidence(
        row({ issues: ["수정주가 출처·120일 이력 확인 필요", "기술점수 이력 부족"] }),
        date,
      ),
    ).toMatchObject({ technical: null, priority: 0, annualVolatility: 0.2 });
  });

  it.each([
    [90, 100, "below_ma60"],
    [100, 100, "above_ma60"],
    [110, 100, "above_ma60"],
    [null, 100, "unconfirmed"],
    [100, null, "unconfirmed"],
    [NaN, 100, "unconfirmed"],
    [100, 0, "unconfirmed"],
  ] as const)(
    "keeps underlying evidence separate from a pending signal: %s / %s",
    (close, ma60, judgment) => {
      const input = row({ underlyingClose: close, underlyingMa60: ma60 });
      const before = structuredClone(input);
      expect(etfPartialEvidence(input, date).underlyingJudgment).toBe(judgment);
      expect(input).toEqual(before);
      expect(input.etfStrategy?.onset).toBe(false);
      expect(input.etfStrategy?.exit).toBeNull();
    },
  );

  it("does not display nonfinite scores or values outside their score range", () => {
    expect(
      etfPartialEvidence(
        row({
          technical: NaN,
          priority: Infinity,
          health: -1,
          environment: 101,
          annualVolatility: NaN,
        }),
        date,
      ),
    ).toMatchObject({
      technical: null,
      priority: null,
      health: null,
      environment: null,
      annualVolatility: null,
    });
  });
});
