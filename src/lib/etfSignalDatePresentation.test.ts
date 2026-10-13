import saved from "../../tests/fixtures/morning-display-synthetic.json";
import { describe, expect, it } from "vitest";
import type { ScreeningRow } from "./engine/pipeline";
import { ETF_POLICY } from "./engine/etfStrategy";
import { etfSignalDateLabels } from "./etfSignalDatePresentation";
const date = "2024-04-15";
function row(patch = {}) {
  return {
    instrument: { symbol: "SYN005", instrumentType: "ETF" },
    snapshot: { tradeDate: date, close: 7600 },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      previousDate: "2024-04-12",
      dataStatus: "ready",
      rawOnset: false,
      score: 60,
      previousScore: 61,
      technical: 70,
      priority: 0,
      health: 100,
      environment: 30,
      environmentSource: "peer_mix_lag1",
      region: "KR",
      underlyingClose: 120,
      underlyingMa60: 700,
      issues: [],
      originDate: null,
      confirmationDate: null,
      entryState: "none",
      ...patch,
    },
  } as unknown as ScreeningRow;
}
describe("ETF signal date display", () => {
  it("shows unknown for synthetic SYN005 missing adjusted history/MA60", () => {
    const r = row({
      score: null,
      previousScore: null,
      technical: null,
      underlyingMa60: null,
      dataStatus: "incomplete",
      issues: [
        "수정주가 출처·120일 이력 확인 필요",
        "기초지수 MA60·추세 이력 부족",
        "기술점수 이력 부족",
      ],
    });
    const before = JSON.stringify(r);
    expect(etfSignalDateLabels(r, date)).toEqual({ origin: "미확인", confirmation: "미확인" });
    expect(JSON.stringify(r)).toBe(before);
  });
  it("preserves synthetic session SYN007 confirmation waiting, without claiming entry", () => {
    expect(
      etfSignalDateLabels(
        row({
          score: 85,
          previousScore: 75,
          rawOnset: true,
          originDate: date,
          entryState: "pending",
        }),
        date,
      ),
    ).toEqual({ origin: date, confirmation: "다음 정규 거래일 종가" });
  });
  it("distinguishes a confirmed no-signal from missing prior score", () => {
    expect(etfSignalDateLabels(row(), date)).toEqual({ origin: "없음", confirmation: "없음" });
    expect(etfSignalDateLabels(row({ previousScore: null }), date)).toEqual({
      origin: "미확인",
      confirmation: "미확인",
    });
  });
  it.each(["confirmed", "rejected", "data_pending"])(
    "keeps dated historical facts for %s without making a decision",
    (entryState) => {
      expect(
        etfSignalDateLabels(
          row({ originDate: "2024-04-12", confirmationDate: date, entryState }),
          date,
        ),
      ).toEqual({ origin: "2024-04-12", confirmation: date });
    },
  );
  it.each([
    { date: "2024-04-12" },
    { version: "old" },
    { originDate: "2024-04-16" },
    { originDate: "2024-02-30" },
    { originDate: date, confirmationDate: "2024-04-12" },
    { originDate: date, confirmationDate: date },
  ])("fails closed on stale/malformed/future dates", (patch) => {
    expect(etfSignalDateLabels(row(patch), date)).toEqual({
      origin: "미확인",
      confirmation: "미확인",
    });
  });
  it("keeps batch pending and absent strategy unknown", () => {
    expect(etfSignalDateLabels(row({ dataStatus: "krx_batch_pending" }), date)).toEqual({
      origin: "미확인",
      confirmation: "미확인",
    });
    const r = row();
    delete r.etfStrategy;
    expect(etfSignalDateLabels(r, date)).toEqual({ origin: "미확인", confirmation: "미확인" });
  });
});

it.each(["krx_batch_pending", "incomplete"])(
  "does not promise next-session confirmation for %s",
  (dataStatus) => {
    expect(
      etfSignalDateLabels(
        row({ dataStatus, entryState: "pending", rawOnset: true, originDate: date }),
        date,
      ),
    ).toEqual({ origin: date, confirmation: "미확인" });
  },
);

it("renders synthetic strategy boundaries without altering their source", () => {
  const before = JSON.stringify(saved);
  for (const sample of saved.rows) {
    const r = {
      instrument: { symbol: sample.symbol, name: sample.name, instrumentType: "ETF" },
      snapshot: { tradeDate: date, close: 1 },
      etfStrategy: sample.strategy,
    } as unknown as ScreeningRow;
    const result = etfSignalDateLabels(r, date);
    expect(result).toEqual(
      sample.symbol === "SYN007"
        ? { origin: date, confirmation: "다음 정규 거래일 종가" }
        : { origin: "미확인", confirmation: "미확인" },
    );
  }
  expect(JSON.stringify(saved)).toBe(before);
});
