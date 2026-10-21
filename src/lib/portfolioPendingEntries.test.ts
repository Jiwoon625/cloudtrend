import { describe, expect, it } from "vitest";
import { buildKrPendingEntryPreview } from "./portfolioPendingEntries";
import {
  calculateActual,
  type ActualExecution,
  type Candidate,
  type StrategyLedger,
} from "./portfolioLedgers";
import type { PortfolioTrade } from "./portfolioStoreCore";

const candidate = (patch: Partial<Candidate> = {}): Candidate => ({
  key: "SYNTH_A|2026-10-06",
  symbol: "SYNTH_A",
  name: "검증 종목 A",
  market: "KOSDAQ",
  sectorCode: "TEST",
  sectorName: "검증 섹터",
  signalDate: "2026-10-06",
  entryDate: null,
  price: null,
  technical: 8,
  priority: 5,
  decision: "다음 거래일 대기",
  ...patch,
});
const strategy = (candidates = [candidate()]): StrategyLedger => ({
  candidates,
  trades: [],
  summary: calculateActual(100000, [], {}, null).summary,
  quotes: {},
  firstSignalDate: "2026-10-06",
  calculatedAt: "2026-10-07T00:10:00Z",
  fingerprint: "synthetic-saved-ledger",
});
const execution = (patch: Partial<ActualExecution> = {}): ActualExecution => ({
  id: "synthetic-fill",
  symbol: "SYNTH_A",
  name: "검증 종목 A",
  market: "KOSDAQ",
  signalKey: "SYNTH_A|2026-10-06",
  side: "BUY",
  date: "2026-10-07",
  price: 100,
  shares: 3,
  fee: 0,
  note: "",
  order: 0,
  ...patch,
});
const options = { today: "2026-10-07" };

describe("saved KR pending-entry display projection", () => {
  it("shows three next-session candidates today without inventing prices, quantities, cash or holdings", () => {
    const input = strategy(
      ["A", "B", "C"].map((suffix) =>
        candidate({ key: `SYNTH_${suffix}|2026-10-06`, symbol: `SYNTH_${suffix}` }),
      ),
    );
    const original = JSON.stringify(input);
    const preview = buildKrPendingEntryPreview(input, options);
    expect(preview.todayCount).toBe(3);
    expect(preview.unknownDateCount).toBe(0);
    expect(preview.rows).toHaveLength(3);
    for (const row of preview.rows) {
      expect(row).toMatchObject({
        expectedEntryDate: "2026-10-07",
        timing: "TODAY",
        label: "오늘 진입 예정 · 시가 미확인",
        actualFilled: false,
      });
      for (const field of ["price", "shares", "cash", "entryDate", "entryPrice"])
        expect(row).not.toHaveProperty(field);
    }
    expect(input.summary.latestDate).toBeNull();
    expect(input.summary.cash).toBe(100000);
    expect(input.summary.openPositions).toBe(0);
    expect(input.trades).toEqual([]);
    expect(JSON.stringify(input)).toBe(original);
  });

  it("uses the reviewed holiday calendar across the October 9 holiday and weekend", () => {
    const preview = buildKrPendingEntryPreview(
      strategy([candidate({ signalDate: "2026-10-08" })]),
      { today: "2026-10-09" },
    );
    expect(preview.rows[0]).toMatchObject({ expectedEntryDate: "2026-10-12", timing: "UPCOMING" });
    expect(preview.todayCount).toBe(0);
  });

  it("leaves missing calendar evidence explicitly unknown", () => {
    const preview = buildKrPendingEntryPreview(strategy(), { ...options, calendar: null });
    expect(preview.rows[0]).toMatchObject({ expectedEntryDate: null, timing: "UNKNOWN" });
    expect(preview.rows[0]?.label).toContain("미확인");
    expect(preview.todayCount).toBe(0);
    expect(preview.unknownDateCount).toBe(1);
  });

  it.each(["2026-10-02", "2026-10-05", "2026-10-10", "2026-12-30", "2027-01-04", "invalid"])(
    "does not guess a date for an uncovered or non-session signal: %s",
    (signalDate) => {
      const preview = buildKrPendingEntryPreview(strategy([candidate({ signalDate })]), options);
      expect(preview.rows[0]?.expectedEntryDate).toBeNull();
      expect(preview.unknownDateCount).toBe(1);
    },
  );

  it("does not roll historical pending into today's entry", () => {
    const preview = buildKrPendingEntryPreview(strategy(), { today: "2026-10-12" });
    expect(preview.rows[0]).toMatchObject({
      expectedEntryDate: "2026-10-07",
      timing: "AWAITING_DATA",
    });
    expect(preview.todayCount).toBe(0);
    expect(preview.rows[0]?.label).toContain("예정일 경과");
  });

  it("includes KOSPI only after confirmation and preserves the execution gate warning", () => {
    const confirmed = candidate({
      market: "KOSPI",
      entryState: "confirmed",
      confirmationDate: "2026-10-06",
      decision: "다음 거래가능일 대기 · 체결 전 완료일 시장국면 재확인 필요",
    });
    expect(buildKrPendingEntryPreview(strategy([confirmed]), options).rows[0]).toMatchObject({
      expectedEntryDate: "2026-10-07",
      decision: confirmed.decision,
    });
    for (const entryState of ["pending", "none", "rejected", "unobservable"] as const)
      expect(
        buildKrPendingEntryPreview(strategy([{ ...confirmed, entryState }]), options).rows,
      ).toEqual([]);
    expect(
      buildKrPendingEntryPreview(strategy([{ ...confirmed, confirmationDate: null }]), options)
        .rows,
    ).toEqual([]);
  });

  it.each([
    "30종목 한도",
    "섹터 한도",
    "현금 부족",
    "동일 종목 보유",
    "가격 관측 불가 · 자료 누락",
    "전략 진입",
  ])("does not turn a blocked or already-decided candidate into pending: %s", (decision) => {
    expect(buildKrPendingEntryPreview(strategy([candidate({ decision })]), options).rows).toEqual(
      [],
    );
  });

  it("excludes recorded strategy fills and observed entry prices", () => {
    const input = strategy();
    input.trades = [{ id: candidate().key } as PortfolioTrade];
    expect(buildKrPendingEntryPreview(input, options).rows).toEqual([]);
    expect(
      buildKrPendingEntryPreview(
        strategy([candidate({ entryDate: "2026-10-07", price: 100 })]),
        options,
      ).rows,
    ).toEqual([]);
  });

  it("does not use an actual fill as a strategy fill or move it into model holdings", () => {
    const input = strategy();
    const actualExecutions = [execution()];
    const original = JSON.stringify({ input, actualExecutions });
    const preview = buildKrPendingEntryPreview(input, { ...options, actualExecutions });
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      actualFilled: true,
      actualLabel: "실제 체결 기록 있음",
      timing: "TODAY",
    });
    expect(preview.todayCount).toBe(1);
    expect(input.trades).toHaveLength(0);
    expect(input.summary.openPositions).toBe(0);
    expect(input.summary.cash).toBe(100000);
    expect(calculateActual(100000, actualExecutions, {}, null).positions).toHaveLength(1);
    expect(JSON.stringify({ input, actualExecutions })).toBe(original);
  });

  it.each([
    { shares: 0 },
    { shares: Number.NaN },
    { price: 0 },
    { side: "SELL" as const },
    { signalKey: null },
    { signalKey: "unrelated-signal" },
    { symbol: "OTHER_SYNTH" },
    { date: "2026-10-02" },
  ])("does not claim a linked actual purchase from unrelated/zero-share execution %j", (patch) => {
    expect(
      buildKrPendingEntryPreview(strategy(), { ...options, actualExecutions: [execution(patch)] })
        .rows[0]?.actualFilled,
    ).toBe(false);
  });

  it("has no pending entries without a saved strategy and de-duplicates candidate keys", () => {
    expect(buildKrPendingEntryPreview(null, options)).toEqual({
      rows: [],
      todayCount: 0,
      unknownDateCount: 0,
    });
    expect(
      buildKrPendingEntryPreview(strategy([candidate(), candidate()]), options).rows,
    ).toHaveLength(1);
  });
});
