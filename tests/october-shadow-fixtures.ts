import {
  freezeAdoptedSeries,
  guardModelRun,
  hashSeriesValue,
  VERIFIED_INITIAL_FX,
  isAdoptedUsSeriesKind,
  type AdoptedSeriesKind,
  type FrozenModelSeries,
  type SeriesHash,
} from "../src/lib/ledger/modelSeries";
import type { OctoberRun } from "../src/lib/ledger/octoberShadowPipeline";
import type { OctoberRegistryRow, OctoberSessionRow } from "../src/lib/octoberShadowSummary.server";
export const hash = (digit: string): SeriesHash => `sha256:${digit.repeat(64)}`;
export async function fixtureSeries(kind: AdoptedSeriesKind = "US_A0") {
  return freezeAdoptedSeries({
    kind,
    frozenAt: "2026-10-02T15:37:00Z",
    codeHash: hash("a"),
    sourceHash: hash("b"),
    ...(isAdoptedUsSeriesKind(kind) ? { initialFx: VERIFIED_INITIAL_FX } : {}),
  });
}
export function registry(series: FrozenModelSeries): OctoberRegistryRow {
  return {
    series_id: series.bookId,
    strategy_id: series.policy.kind,
    role: ["US_A2", "US_B3", "KR_KOSPI_CONFIRM1_BEAR"].includes(series.policy.kind)
      ? "ALTERNATIVE_SHADOW"
      : "ADOPTED_SHADOW",
    scheduled_start: series.accountingStartDate,
    config_hash: series.configHash,
    payload: series,
  };
}
export async function usRun(
  series: FrozenModelSeries,
  date = "2026-10-05",
  previous: OctoberRun | null = null,
): Promise<OctoberRun> {
  const receipt = (
    await guardModelRun(series, {
      date,
      codeHash: series.codeHash,
      configHash: series.configHash,
      sourceHash: hash("c"),
    })
  ).receipt;
  const body = {
    book: "MODEL" as const,
    bookId: series.bookId,
    contractHash: series.contractHash,
    receipt,
    previousStateHash: previous?.stateHash ?? null,
    calendar: {
      market: "US" as const,
      coverageStart: "2026-10-01",
      coverageEnd: "2026-10-09",
      regularSessions: [
        "2026-10-01",
        "2026-10-02",
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
        "2026-10-08",
        "2026-10-09",
      ],
      sourceHash: hash("d"),
    },
    publication: {
      version: "october-manual-publication-v1" as const,
      inputHash: hash("e"),
      sourceHash: hash("c"),
      availableAt: `${date}T20:10:00Z`,
      decisionAt: `${date}T20:11:00Z`,
    },
    result: {
      state: {
        executionPolicy: {
          version: "isolated-us-model-v1" as const,
          bookId: series.bookId,
          contractHash: series.contractHash,
          accountingStartDate: series.accountingStartDate,
          initialCapital: series.fx!.usdCash,
          oneWayCost: series.oneWayCost,
        },
        modelCashExact: series.fx!.usdCash,
        initializedDate: series.accountingStartDate,
        lastDate: date,
        initialCapital: Number(series.fx!.usdCash),
        cash: Number(series.fx!.usdCash),
        positions: {},
        pendingTargets: {},
        pendingExits: {},
        lastQuarterRebalance: null,
        benchmarkBasePrice: null,
        benchmarkBaseDate: null,
        totalFees: 0,
      },
      trades: [],
      nav: Number(series.fx!.usdCash),
      cash: Number(series.fx!.usdCash),
      benchmarkNav: null,
      dailyReturn: null,
      cumulativeReturn: 0,
      turnover: 0,
      feesUsd: 0,
      positionsCount: 0,
    },
  };
  return { ...body, stateHash: await hashSeriesValue(body) };
}
export function sessionRow(run: OctoberRun, previous: OctoberRun | null = null): OctoberSessionRow {
  return {
    series_id: run.bookId,
    session_date: run.receipt.date,
    previous_session_date: previous?.receipt.date ?? null,
    state_hash: run.stateHash,
    payload: run,
  };
}
