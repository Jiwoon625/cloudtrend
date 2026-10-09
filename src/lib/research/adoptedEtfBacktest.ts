import type { MarketDataset } from "../engine/dataset";
import {
  calculateEtfStrategies,
  ETF_POLICY,
  type EtfStrategySnapshot,
} from "../engine/etfStrategy";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import { fromLegacyNumber } from "../ledger/decimal";
import { validDate } from "../ledger/date";
import {
  initializeEtfCurrentRulesResearch,
  stepEtfCurrentRulesResearch,
  type EtfAdoptedShadowState,
  type EtfResearchExecutionContract,
  type EtfShadowDailyRecord,
  type EtfShadowFill,
  type EtfShadowIssueCode,
  type EtfShadowSessionInput,
} from "../ledger/etfAdoptedShadow";
import { hashSeriesValue, type ModelCalendar, type SeriesHash } from "../ledger/modelSeries";

export const ADOPTED_ETF_RESEARCH_VERSION = "adopted-etf-annual-nav-volatility-research-v2";

/** Canonical observed rows, before display interpolation. Never pass synthetic open/volume. */
export interface EtfResearchObservedBar {
  tradeDate: string;
  open: number | null;
  close: number | null;
  volume: number | null;
  openObserved?: boolean;
  volumeObserved?: boolean;
}

export interface AdoptedEtfDatedSnapshot {
  date: string;
  /** These must be freshly calculated by the current calculateEtfStrategies implementation. */
  strategies: Array<{ symbol: string; strategy: EtfStrategySnapshot }>;
}

/** The supported source adapter recomputes current signals; stored research scores are not inputs. */
export function calculateAdoptedEtfSnapshot(dataset: MarketDataset): AdoptedEtfDatedSnapshot {
  return {
    date: dataset.asOfDate,
    strategies: [...calculateEtfStrategies(dataset)].map(([symbol, strategy]) => ({
      symbol,
      strategy,
    })),
  };
}

export interface AdoptedEtfBacktestInput {
  runId: string;
  startDate: string;
  endDate: string;
  codeHash: SeriesHash;
  /** Hash of the raw-source/mapping manifest, not a saved feature panel. */
  sourceHash: SeriesHash;
  calendar: ModelCalendar;
  /** Explicit ETF universe. Stock/index rows must not become ETF execution observations. */
  etfSymbols: readonly string[];
  observedBars: Readonly<Record<string, readonly EtfResearchObservedBar[]>>;
  /** One current-engine snapshot per covered session, in chronological order. Supports streaming. */
  snapshots: Iterable<AdoptedEtfDatedSnapshot> | AsyncIterable<AdoptedEtfDatedSnapshot>;
  includeRecords?: boolean;
  /** Legacy mode is for parity tests only; new runs use the approved annual asset base. */
  allocationPolicy?: "ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1" | "ADOPTED_VOLATILITY";
}

export interface AdoptedEtfBacktestResult {
  mode: "CURRENT_RULES_RESEARCH";
  version: typeof ADOPTED_ETF_RESEARCH_VERSION;
  contract: EtfResearchExecutionContract;
  startDate: string;
  endDate: string;
  firstSessionDate: string;
  lastSessionDate: string;
  initialNav: "100000000";
  dailyNav: Array<{
    date: string;
    cash: string;
    marketValue: string | null;
    nav: string | null;
    valuationStatus: EtfAdoptedShadowState["valuation"]["status"];
    positionCount: number;
    fees: string;
    realizedPnl: string;
    sourceHash: SeriesHash;
  }>;
  fills: EtfShadowFill[];
  quality: {
    sessions: number;
    missingNavSessions: number;
    staleNavSessions: number;
    incompleteSignalSnapshots: number;
    missingSignalSnapshots: number;
    issueCounts: Partial<Record<EtfShadowIssueCode, number>>;
    proxyExitCount: number;
    /** Historical event-time convention, not evidence of original publication availability. */
    availabilityConvention: "SESSION_CLOSE_RESEARCH_NEXT_OPEN";
    currentRulesAppliedToHistory: true;
    terminalPositionsLiquidated: false;
  };
  pending: Pick<EtfAdoptedShadowState, "pendingConfirmations" | "pendingEntries" | "pendingExits">;
  finalState: EtfAdoptedShadowState;
  records?: EtfShadowDailyRecord[];
}

function assertDate(value: string) {
  if (!validDate(value)) throw new Error("Invalid ETF research date");
}
function assertHash(value: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error("ETF research requires SHA-256 provenance");
}
function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Real-date full-period replay of the adopted ETF executor. Warmup stays in the signal
 * dataset, while portfolio state starts all cash. No DB, production ledger, or scheduler writes.
 */
export async function runAdoptedEtfBacktest(
  input: AdoptedEtfBacktestInput,
): Promise<AdoptedEtfBacktestResult> {
  assertDate(input.startDate);
  assertDate(input.endDate);
  assertHash(input.codeHash);
  assertHash(input.sourceHash);
  assertHash(input.calendar.sourceHash);
  assertDate(input.calendar.coverageStart);
  assertDate(input.calendar.coverageEnd);
  if (!/^[a-zA-Z0-9._-]+$/.test(input.runId) || input.startDate > input.endDate)
    throw new Error("Invalid ETF research run ID or period");
  if (
    input.calendar.market !== "KR" ||
    input.calendar.coverageStart > input.startDate ||
    input.calendar.coverageEnd < input.endDate ||
    new Set(input.calendar.regularSessions).size !== input.calendar.regularSessions.length
  )
    throw new Error("ETF research requires a complete, explicit KR calendar for the period");
  for (const date of input.calendar.regularSessions) {
    assertDate(date);
    if (date < input.calendar.coverageStart || date > input.calendar.coverageEnd)
      throw new Error("ETF research calendar session outside coverage");
  }
  const sessions = [...input.calendar.regularSessions]
    .sort()
    .filter((d) => d >= input.startDate && d <= input.endDate);
  if (!sessions.length) throw new Error("ETF research period has no covered sessions");
  const sessionSet = new Set(input.calendar.regularSessions);
  const symbols = [...input.etfSymbols].sort();
  if (
    !symbols.length ||
    new Set(symbols).size !== symbols.length ||
    symbols.some((s) => !/^[A-Z0-9]{6}$/.test(s))
  )
    throw new Error("ETF research requires unique six-character ETF symbols");
  const symbolSet = new Set(symbols);
  const barsByDate = new Map<string, Map<string, EtfResearchObservedBar>>();
  for (const symbol of symbols) {
    const seen = new Set<string>();
    for (const bar of input.observedBars[symbol] ?? []) {
      assertDate(bar.tradeDate);
      if (seen.has(bar.tradeDate))
        throw new Error(`Duplicate canonical ETF observation: ${symbol}/${bar.tradeDate}`);
      seen.add(bar.tradeDate);
      if (bar.tradeDate < input.startDate || bar.tradeDate > input.endDate) continue;
      if (!sessionSet.has(bar.tradeDate))
        throw new Error(`ETF observation outside regular sessions: ${symbol}/${bar.tradeDate}`);
      if (!barsByDate.has(bar.tradeDate)) barsByDate.set(bar.tradeDate, new Map());
      barsByDate.get(bar.tradeDate)!.set(symbol, bar);
    }
  }
  const configHash = await hashSeriesValue({
    version: ADOPTED_ETF_RESEARCH_VERSION,
    context: CURRENT_RULES_RESEARCH,
    policy: ETF_POLICY,
    allocationPolicy: input.allocationPolicy ?? "ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1",
    startDate: input.startDate,
    endDate: input.endDate,
    etfSymbols: symbols,
    calendar: input.calendar,
    initialKrw: "100000000",
    oneWayCost: "0.0015",
    availability: "SESSION_CLOSE_RESEARCH_NEXT_OPEN",
  });
  const body = {
    book: "MODEL" as const,
    bookId: `RESEARCH:ETF_V02:${input.runId}` as const,
    accountingStartDate: input.startDate,
    initialKrw: "100000000" as const,
    oneWayCost: "0.0015" as const,
    researchEntryBudgetPolicy: input.allocationPolicy ?? "ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1",
    codeHash: input.codeHash,
    configHash,
    sourceHash: input.sourceHash,
  };
  const contract: EtfResearchExecutionContract = Object.freeze({
    ...body,
    contractHash: await hashSeriesValue(body),
  });
  let state = await initializeEtfCurrentRulesResearch(contract, CURRENT_RULES_RESEARCH);
  const dailyNav: AdoptedEtfBacktestResult["dailyNav"] = [];
  const fills: EtfShadowFill[] = [];
  const records: EtfShadowDailyRecord[] = [];
  const quality: AdoptedEtfBacktestResult["quality"] = {
    sessions: 0,
    missingNavSessions: 0,
    staleNavSessions: 0,
    incompleteSignalSnapshots: 0,
    missingSignalSnapshots: 0,
    issueCounts: {},
    proxyExitCount: 0,
    availabilityConvention: "SESSION_CLOSE_RESEARCH_NEXT_OPEN",
    currentRulesAppliedToHistory: true,
    terminalPositionsLiquidated: false,
  };
  let previousStateHash = await hashSeriesValue(state);
  for await (const snapshot of input.snapshots) {
    const date = sessions[quality.sessions];
    if (!date || snapshot.date !== date)
      throw new Error(
        `ETF snapshots must cover each regular session exactly; expected ${date ?? "end of period"}, got ${snapshot.date}`,
      );
    const seen = new Set<string>();
    for (const row of snapshot.strategies) {
      if (
        !symbolSet.has(row.symbol) ||
        seen.has(row.symbol) ||
        row.strategy.date !== date ||
        row.strategy.version !== ETF_POLICY.version
      )
        throw new Error(
          "ETF snapshot symbol/date/version does not match the current research input",
        );
      seen.add(row.symbol);
      if (row.strategy.dataStatus !== "ready") quality.incompleteSignalSnapshots += 1;
    }
    quality.missingSignalSnapshots += symbols.length - seen.size;
    const observed = barsByDate.get(date) ?? new Map<string, EtfResearchObservedBar>();
    const openAt = `${date}T00:00:00Z`;
    const signalAvailableAt = `${date}T06:40:00Z`;
    const pricesWithoutHash = symbols.map((symbol) => {
      const bar = observed.get(symbol);
      return {
        symbol,
        open: {
          asOfDate: date,
          availableAt: openAt,
          price:
            bar?.openObserved !== false && finitePositive(bar?.open)
              ? fromLegacyNumber(bar.open)
              : null,
          volume:
            bar?.volumeObserved !== false &&
            typeof bar?.volume === "number" &&
            Number.isFinite(bar.volume)
              ? bar.volume
              : null,
        },
        close: {
          asOfDate: date,
          availableAt: `${date}T06:30:00Z`,
          price: finitePositive(bar?.close) ? fromLegacyNumber(bar.close) : null,
        },
      };
    });
    const sourceHash = await hashSeriesValue({
      rawSourceHash: input.sourceHash,
      previousStateHash,
      date,
      prices: pricesWithoutHash,
      strategies: [...snapshot.strategies].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    });
    const sessionInput: EtfShadowSessionInput = {
      sessionDate: date,
      previousSessionDate: state.lastSessionDate,
      openAt,
      closeAt: `${date}T07:00:00Z`,
      decisionWindow: "SESSION_CLOSE",
      calendar: input.calendar,
      codeHash: input.codeHash,
      configHash,
      sourceHash,
      prices: pricesWithoutHash.map((row) => ({
        symbol: row.symbol,
        open: { ...row.open, sourceHash },
        close: { ...row.close, sourceHash },
      })),
      closeSignals: snapshot.strategies.map((row) => ({
        ...row,
        availableAt: signalAvailableAt,
        sourceHash,
      })),
    };
    const result = await stepEtfCurrentRulesResearch(
      contract,
      state,
      sessionInput,
      CURRENT_RULES_RESEARCH,
    );
    state = result.state;
    previousStateHash = await hashSeriesValue(result);
    quality.sessions += 1;
    if (state.valuation.status === "MISSING") quality.missingNavSessions += 1;
    if (state.valuation.status === "STALE") quality.staleNavSessions += 1;
    for (const issue of result.record.issues)
      quality.issueCounts[issue.code] = (quality.issueCounts[issue.code] ?? 0) + 1;
    quality.proxyExitCount += result.record.fills.filter(
      (fill) => fill.reason === "MODEL_UNOBSERVED",
    ).length;
    fills.push(...result.record.fills);
    dailyNav.push({
      date,
      cash: state.cash,
      marketValue: state.valuation.marketValue,
      nav: state.valuation.nav,
      valuationStatus: state.valuation.status,
      positionCount: state.positions.length,
      fees: result.record.fees,
      realizedPnl: result.record.realizedPnl,
      sourceHash,
    });
    if (input.includeRecords) records.push(result.record);
  }
  if (quality.sessions !== sessions.length)
    throw new Error(`ETF snapshots ended before regular session ${sessions[quality.sessions]}`);
  return {
    mode: "CURRENT_RULES_RESEARCH",
    version: ADOPTED_ETF_RESEARCH_VERSION,
    contract,
    startDate: input.startDate,
    endDate: input.endDate,
    firstSessionDate: sessions[0]!,
    lastSessionDate: sessions.at(-1)!,
    initialNav: "100000000",
    dailyNav,
    fills,
    quality,
    pending: {
      pendingConfirmations: state.pendingConfirmations,
      pendingEntries: state.pendingEntries,
      pendingExits: state.pendingExits,
    },
    finalState: state,
    ...(input.includeRecords ? { records } : {}),
  };
}
