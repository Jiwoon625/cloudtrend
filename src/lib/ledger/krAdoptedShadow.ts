import { simulateStrategy, type StrategyLedger } from "../portfolioLedgers";
import type { DailyPrice, Market } from "../engine/types";
import type { KospiMarketGateEvidence } from "../engine/kospiMarketGate";
import type { ScreeningSnapshot } from "../screeningSnapshot";
import {
  assertModelSeriesIsolation,
  assertModelCalendarContinuation,
  firstModelSession,
  guardModelRun,
  hashSeriesValue,
  verifyFrozenSeries,
  type FrozenModelSeries,
  type ModelCalendar,
  type ModelRunReceipt,
  type SeriesHash,
} from "./modelSeries";
import { assertKrShadowDecisionWindow, krShadowDecisionWindow } from "./octoberShadowCalendar";
export interface KrSeriesInputs {
  date: string;
  codeHash: string;
  configHash: string;
  sourceHash: string;
  availableAt: string;
  decisionAt: string;
  confirmedClose: boolean;
  snapshots: ScreeningSnapshot[];
  bars: Record<string, DailyPrice[]>;
  markets: Record<string, Market>;
  marketGates: Record<string, KospiMarketGateEvidence>;
  calendar: ModelCalendar;
}
export interface AdoptedKrRun {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  receipt: ModelRunReceipt;
  previousStateHash: SeriesHash | null;
  calendar: ModelCalendar;
  frozenInputs: Pick<KrSeriesInputs, "snapshots" | "bars" | "markets" | "marketGates">;
  result: StrategyLedger;
  stateHash: SeriesHash;
  /** Compact persistence resolves exact content-addressed daily inputs before replay. */
  frozenInputArchive?: {
    version: "kr-daily-inputs-v1";
    days: Array<{ date: string; hash: SeriesHash }>;
    prefixHash: SeriesHash;
  };
}
function prefix(input: AdoptedKrRun["frozenInputs"], date: string): AdoptedKrRun["frozenInputs"] {
  const snapshots = input.snapshots
    .filter((s) => s.asOfDate <= date)
    .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
  const bars = Object.fromEntries(
    Object.entries(input.bars)
      .map(([symbol, rows]) => [
        symbol,
        rows
          .filter((r) => r.tradeDate <= date)
          .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)),
      ])
      .filter(([, rows]) => (rows as DailyPrice[]).length),
  );
  const symbols = new Set([
    ...Object.keys(bars),
    ...snapshots.flatMap((s) => s.entries.map((e) => e.symbol)),
  ]);
  return {
    snapshots,
    bars,
    markets: Object.fromEntries(
      Object.entries(input.markets).filter(([symbol]) => symbols.has(symbol)),
    ),
    marketGates: Object.fromEntries(
      Object.entries(input.marketGates).filter(([key]) => key <= date),
    ),
  };
}
/** Replays only immutable archived prefixes under a new policy. Existing KR callers are untouched. */
export async function stepAdoptedKrSeries(
  series: FrozenModelSeries,
  input: KrSeriesInputs,
  previous: AdoptedKrRun | null = null,
  resolvedPreviousInputs?: AdoptedKrRun["frozenInputs"],
): Promise<{ status: "NEW" | "REUSE"; run: AdoptedKrRun }> {
  await verifyFrozenSeries(series);
  if (!["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"].includes(series.policy.kind))
    throw new Error("KR adopted series required");
  if (!input.confirmedClose)
    throw new Error("Completed KR close confirmation is required");
  assertKrShadowDecisionWindow(input.date, input.availableAt, input.decisionAt);
  const first = firstModelSession(series, input.calendar);
  const sessions = [...input.calendar.regularSessions].sort();
  if (!sessions.includes(input.date)) throw new Error("Verified KR regular session required");
  if (
    input.snapshots.some(
      (s) =>
        s.asOfDate > input.date ||
        Date.parse(s.savedAt) > Date.parse(input.decisionAt) ||
        !krShadowDecisionWindow(s.asOfDate, s.savedAt, s.savedAt).eligible,
    ) ||
    new Set(input.snapshots.map((s) => s.asOfDate)).size !== input.snapshots.length
  )
    throw new Error("Snapshot dates/availability are not T+1 pre-open point-in-time evidence");
  if (!input.snapshots.some((s) => s.asOfDate === input.date))
    throw new Error("Current completed snapshot is required");
  for (const rows of Object.values(input.bars))
    if (
      rows.some((r) => r.tradeDate > input.date) ||
      new Set(rows.map((r) => r.tradeDate)).size !== rows.length
    )
      throw new Error("Future or duplicate price rows cannot enter a frozen run");
  if (previous) {
    assertModelSeriesIsolation(series, previous);
    assertModelCalendarContinuation(series, previous.calendar, input.calendar);
    const { stateHash, ...body } = previous;
    if ((await hashSeriesValue(body)) !== stateHash) throw new Error("Previous KR run has changed");
    const previousInputs = previous.frozenInputArchive
      ? resolvedPreviousInputs
      : previous.frozenInputs;
    if (
      !previousInputs ||
      (previous.frozenInputArchive &&
        (await hashSeriesValue(previousInputs)) !== previous.frozenInputArchive.prefixHash)
    )
      throw new Error("Archived KR input prefix is missing or changed");
    if (
      (await hashSeriesValue(prefix(input, previous.receipt.date))) !==
      (await hashSeriesValue(previousInputs))
    )
      throw new Error("Archived historical inputs changed; never rewrite a completed series");
  }
  const sameDate = previous?.receipt.date === input.date;
  const previousStateHash = sameDate ? previous.previousStateHash : (previous?.stateHash ?? null);
  const frozenInputs = prefix(input, input.date);
  const manifest = await hashSeriesValue({
    upstream: input.sourceHash,
    frozenInputs,
    availableAt: input.availableAt,
    calendar: input.calendar,
    previousStateHash,
  });
  const guard = await guardModelRun(
    series,
    {
      date: input.date,
      codeHash: input.codeHash,
      configHash: input.configHash,
      sourceHash: manifest,
    },
    sameDate ? previous.receipt : undefined,
  );
  if (guard.status === "REUSE" && previous) return { status: "REUSE", run: previous };
  const expected = previous ? sessions.find((s) => s > previous.receipt.date) : first;
  if (input.date !== expected) throw new Error("Missing regular KR sessions cannot be skipped");
  const result = simulateStrategy(
    { initialCapital: 100_000_000, maxPositions: 30, sectorCap: 0.3, roundTripCostRate: 0.003 },
    frozenInputs.snapshots,
    frozenInputs.bars,
    frozenInputs.markets,
    manifest,
    sessions.filter((s) => s <= input.date),
    frozenInputs.marketGates,
    {
      version: "kr-adopted-shadow-20261005-v1",
      startDate: "2026-10-05",
      throughDate: input.date,
      scope:
        series.policy.kind === "KR_MIXED"
          ? "MIXED"
          : series.policy.kind === "KR_KOSPI"
            ? "KOSPI"
            : "KOSDAQ",
    },
  );
  result.calculatedAt = input.decisionAt;
  const body = {
    book: "MODEL" as const,
    bookId: series.bookId,
    contractHash: series.contractHash,
    receipt: guard.receipt,
    previousStateHash,
    calendar: structuredClone(input.calendar),
    frozenInputs,
    result,
  };
  return { status: "NEW", run: { ...body, stateHash: await hashSeriesValue(body) } };
}
