import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";
import type { DailyPrice, Instrument } from "./engine/types";
import type { EtfStrategySnapshot } from "./engine/etfStrategy";
import type { KospiMarketGateEvidence } from "./engine/kospiMarketGate";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import { ETF_POLICY, etfKrxBatchPending, etfEntryWeight } from "./engine/etfStrategy";
import { isOperationalEntry } from "./engine/operationalStrategy";
import { evaluateKospiMarketGateAtDate } from "./engine/kospiMarketGate";
import { US_PROSPECTIVE_RULE_VERSION, type UsProspectiveAnalysis } from "./engine/usProspective";
import { US_PROSPECTIVE_PARTICIPATION } from "./engine/usProspectivePortfolio";
import { compareUsCandidates } from "./usCandidatePriority";
import { buildSnapshot } from "./screeningSnapshot";
import { deriveExitPlan, operationalExit } from "./portfolioStrategyRules";
import type { PortfolioTrade } from "./portfolioStoreCore";
import { fromLegacyNumber } from "./ledger/decimal";
import {
  INTEGRATED_ALLOCATION_START,
  type AllocationPosition,
  type AllocationSignal,
  type IntegratedAllocationLedger,
  type IntegratedAllocationSessionInput,
} from "./integratedAllocationShadow";

export type AllocationAdapterClock = Pick<
  IntegratedAllocationSessionInput,
  "openAt" | "closeAt" | "availableAt" | "decisionAt" | "sourceHash" | "codeHash" | "calendar"
>;
const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const quote = (value: number | null | undefined) =>
  positive(value) ? fromLegacyNumber(value) : null;
function prefixBars(dataset: MarketDataset, at: string) {
  return Object.fromEntries(
    Object.entries({ ...dataset.bars, ...dataset.observedBars }).map(([symbol, bars]) => {
      const rows = bars
        .filter((b) => b.tradeDate <= at)
        .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      if (new Set(rows.map((b) => b.tradeDate)).size !== rows.length)
        throw new Error("Allocation adapter requires normalized unique price rows");
      return [symbol, rows];
    }),
  );
}
function tradeForExit(position: AllocationPosition): PortfolioTrade {
  return {
    id: position.symbol,
    symbol: position.symbol,
    name: position.symbol,
    market: position.venue === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
    sectorCode: position.sector ?? "UNKNOWN",
    sectorName: position.sector ?? "UNKNOWN",
    signalDate: position.entryDate,
    entryDate: position.entryDate,
    entryPrice: 0,
    entryTechnicalPoints: null,
    entryPriorityPoints: null,
    entryStatus: "MODEL",
    targetWeight: 0,
    targetAmount: 0,
    shares: Number(position.quantity),
    buyAmount: 0,
    entryFee: 0,
    markDate: position.lastMark?.date ?? null,
    currentPrice: position.lastMark ? Number(position.lastMark.price) : null,
    currentTechnicalPoints: null,
    currentPriorityPoints: null,
    currentStatus: null,
    holdingDays: 0,
    exitSignalDate: null,
    exitDate: null,
    exitPrice: null,
    exitReason: null,
    exitFee: 0,
    realizedPnl: null,
    realizedReturn: null,
    status: "OPEN",
  };
}
/** Immutable, one-day intrinsic evidence. No prior ledger, history bars, or actual-book data. */
export interface IntegratedKrEvidence {
  version: "integrated-kr-daily-evidence-v1";
  date: string;
  clock: AllocationAdapterClock;
  instruments: Array<Pick<Instrument, "symbol" | "market" | "instrumentType" | "sectorCode">>;
  rows: Array<{
    instrument: Pick<Instrument, "symbol" | "market" | "instrumentType" | "sectorCode">;
    operatingScore10: number | null;
    priority: { points: number };
    etfStrategy?: EtfStrategySnapshot;
  }>;
  snapshot: ScreeningSnapshot;
  bars: Record<
    string,
    {
      tradeDate: string;
      open: number | null;
      close: number | null;
      volume: number | null;
      openObserved: boolean;
      volumeObserved: boolean;
    }
  >;
  priorGate: KospiMarketGateEvidence | null;
  etfBatchPending: boolean;
}
export function prepareIntegratedKrEvidence(
  dataset: MarketDataset,
  analysis: AnalysisResult,
  clock: AllocationAdapterClock,
): IntegratedKrEvidence {
  const at = analysis.asOfDate;
  if (
    dataset.asOfDate !== at ||
    at < INTEGRATED_ALLOCATION_START ||
    !dataset.tradeDates.includes(at)
  )
    throw new Error("Completed point-in-time KR analysis required");
  const instrument = (i: Instrument) => ({
    symbol: i.symbol,
    market: i.market,
    instrumentType: i.instrumentType,
    sectorCode: i.sectorCode,
  });
  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  const bars: IntegratedKrEvidence["bars"] = {};
  for (const [symbol, series] of Object.entries({ ...dataset.bars, ...dataset.observedBars })) {
    const today = series.filter((b) => b.tradeDate === at);
    if (today.length > 1)
      throw new Error("Allocation adapter requires normalized unique price rows");
    if (today[0]) {
      const b = today[0];
      bars[symbol] = {
        tradeDate: at,
        open: finite(b.open),
        close: finite(b.close),
        volume: finite(b.volume),
        openObserved: b.openObserved !== false,
        volumeObserved: b.volumeObserved !== false,
      };
    }
  }
  const priorDate = clock.calendar.sessions.filter((d) => d < at).at(-1);
  // Undefined optional snapshot fields are omitted; unknown numeric observations remain null.
  return JSON.parse(
    JSON.stringify({
      version: "integrated-kr-daily-evidence-v1",
      date: at,
      clock,
      instruments: dataset.instruments.map(instrument),
      rows: analysis.rows.map((r) => ({
        instrument: instrument(r.instrument),
        operatingScore10: r.operatingScore10,
        priority: { points: r.priority.points },
        ...(r.etfStrategy ? { etfStrategy: r.etfStrategy } : {}),
      })),
      snapshot: buildSnapshot({ ...analysis, calculatedAt: clock.availableAt }),
      bars,
      priorGate: priorDate ? evaluateKospiMarketGateAtDate(dataset, priorDate) : null,
      etfBatchPending: etfKrxBatchPending(
        { ...dataset, bars: { ...dataset.bars, ...dataset.observedBars } },
        priorDate ?? null,
      ),
    }),
  ) as IntegratedKrEvidence;
}
function evidenceBars(evidence: IntegratedKrEvidence[]): Record<string, DailyPrice[]> {
  const result: Record<string, DailyPrice[]> = {};
  for (const day of evidence)
    for (const [symbol, b] of Object.entries(day.bars)) {
      if (b.tradeDate !== day.date) throw new Error("Allocation daily evidence date mismatch");
      (result[symbol] ??= []).push({
        ...b,
        open: b.open ?? Number.NaN,
        close: b.close ?? Number.NaN,
        volume: b.volume ?? Number.NaN,
        high: 0,
        low: 0,
        tradingValue: 0,
        marketCap: null,
        foreignNetBuyValue: null,
        institutionNetBuyValue: null,
      });
    }
  for (const series of Object.values(result))
    series.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  return result;
}
/** Compact replay requires every already-completed local market day, never an inferred missing day. */
export function adaptIntegratedKrEvidence(
  previous: IntegratedAllocationLedger,
  input: { market: "K" | "E"; evidence: IntegratedKrEvidence; history: IntegratedKrEvidence[] },
): IntegratedAllocationSessionInput {
  const { market, evidence, history } = input;
  const ordered = [...history].sort((a, b) => a.date.localeCompare(b.date));
  if (
    ordered.length !== previous.markets[market].sessions.length ||
    ordered.some(
      (day, i) =>
        day.version !== "integrated-kr-daily-evidence-v1" ||
        day.date !== previous.markets[market].sessions[i] ||
        day.clock.codeHash !== previous.contract.codeHash,
    )
  )
    throw new Error("Complete immutable allocation evidence prefix required");
  return adaptPreparedKr(previous, market, evidence, evidenceBars([...ordered, evidence]));
}
/** Compatibility entry point for a caller already holding the point-in-time full dataset. */
export function adaptIntegratedKrSession(
  previous: IntegratedAllocationLedger,
  input: {
    market: "K" | "E";
    dataset: MarketDataset;
    analysis: AnalysisResult;
    clock: AllocationAdapterClock;
  },
): IntegratedAllocationSessionInput {
  return adaptPreparedKr(
    previous,
    input.market,
    prepareIntegratedKrEvidence(input.dataset, input.analysis, input.clock),
    prefixBars(input.dataset, input.analysis.asOfDate),
  );
}
function adaptPreparedKr(
  previous: IntegratedAllocationLedger,
  market: "K" | "E",
  evidence: IntegratedKrEvidence,
  bars: Record<string, DailyPrice[]>,
): IntegratedAllocationSessionInput {
  const { clock, date: at, priorGate, snapshot } = evidence;
  if (
    evidence.version !== "integrated-kr-daily-evidence-v1" ||
    snapshot.asOfDate !== at ||
    at < INTEGRATED_ALLOCATION_START ||
    clock.codeHash !== previous.contract.codeHash
  )
    throw new Error("Invalid allocation daily evidence");
  const sleeve = previous.markets[market],
    rows = evidence.rows.filter((r) =>
      market === "E"
        ? r.instrument.instrumentType === "ETF"
        : r.instrument.instrumentType === "STOCK",
    );
  if (new Set(rows.map((r) => r.instrument.symbol)).size !== rows.length)
    throw new Error("Duplicate allocation analysis rows");
  if (market === "E" && evidence.etfBatchPending)
    throw new Error("Completed ETF strategy observations required: KRX batch pending");
  const inputIssues: string[] = [];
  const priorDate = clock.calendar.sessions.filter((d) => d < at).at(-1) ?? null;
  if (priorGate !== null && priorGate.date !== priorDate)
    throw new Error("Previous completed KOSPI gate date mismatch");
  const kospiEntryAllowed =
    !!priorGate &&
    !priorGate.incomplete &&
    priorGate.evaluatedCount === 4 &&
    !priorGate.issues.length &&
    ["RISK_ON", "NEUTRAL"].includes(priorGate.status);
  const instruments = evidence.instruments.filter((i) =>
    market === "E" ? i.instrumentType === "ETF" : i.instrumentType === "STOCK",
  );
  const symbols = new Set([
    ...instruments.map((i) => i.symbol),
    ...sleeve.positions.map((p) => p.symbol),
    ...sleeve.pendingBuys.map((p) => p.symbol),
  ]);
  const prices = [...symbols].sort().map((symbol) => {
    const bar = bars[symbol]?.find((b) => b.tradeDate === at);
    const venue =
      instruments.find((i) => i.symbol === symbol)?.market ??
      sleeve.positions.find((p) => p.symbol === symbol)?.venue ??
      sleeve.pendingBuys.find((p) => p.symbol === symbol)?.venue;
    return {
      symbol,
      open: bar?.openObserved === false ? null : quote(bar?.open),
      close: quote(bar?.close),
      volume:
        bar?.volumeObserved === false || !Number.isFinite(bar?.volume)
          ? null
          : (bar?.volume ?? null),
      maxBuyQuantity: null,
      entryAllowed: venue !== "KOSPI" || kospiEntryAllowed,
    };
  });
  const entries = new Map(snapshot.entries.map((e) => [e.symbol, e]));
  const rawOnsets: string[] = [],
    signals: AllocationSignal[] = [],
    deliveredEntrySignals: AllocationSignal[] = [];
  const observedClose = (symbol: string) =>
    positive(bars[symbol]?.find((b) => b.tradeDate === at)?.close);
  const ordered = [...rows].sort((a, b) =>
    market === "E"
      ? (b.etfStrategy?.averageTradingValue20 ?? -Infinity) -
          (a.etfStrategy?.averageTradingValue20 ?? -Infinity) ||
        a.instrument.symbol.localeCompare(b.instrument.symbol)
      : (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity) ||
        b.priority.points - a.priority.points ||
        a.instrument.symbol.localeCompare(b.instrument.symbol),
  );
  for (const row of ordered) {
    const symbol = row.instrument.symbol;
    if (!observedClose(symbol)) continue;
    if (market === "E") {
      const s = row.etfStrategy;
      if (
        !s ||
        s.date !== at ||
        s.version !== ETF_POLICY.version ||
        s.dataStatus === "krx_batch_pending"
      ) {
        inputIssues.push(`SIGNAL_DATA_UNAVAILABLE:${symbol}`);
        continue;
      }
      if (s.exit === "DATA_UNAVAILABLE") inputIssues.push(`SIGNAL_DATA_UNAVAILABLE:${symbol}`);
      if (
        s.rawOnset &&
        s.originDate === at &&
        s.entryState === "pending" &&
        s.eligible &&
        s.score !== null &&
        s.score >= ETF_POLICY.entryScore &&
        s.previousScore !== null &&
        s.previousScore < ETF_POLICY.entryScore
      )
        rawOnsets.push(symbol);
      if (s.exit === "MA60")
        signals.push({
          symbol,
          venue: "ETF",
          sector: row.instrument.sectorCode,
          side: "SELL",
          originDate: at,
          reason: "MA60",
          annualVolatility: null,
        });
      const qualified =
        s.exit !== "MA60" &&
        s.eligible &&
        s.onset &&
        s.entryState === "confirmed" &&
        s.confirmationDate === at &&
        s.originDate === priorDate &&
        s.previousDate === priorDate &&
        s.dataStatus === "ready" &&
        !s.confirmationIssues.length &&
        s.averageTradingValue20 !== null &&
        Number.isFinite(s.averageTradingValue20) &&
        s.averageTradingValue20 >= 0 &&
        etfEntryWeight(s.annualVolatility) !== null;
      if (qualified) {
        const delivered: AllocationSignal = {
          symbol,
          venue: "ETF",
          sector: row.instrument.sectorCode,
          side: "BUY",
          originDate: s.originDate!,
          reason: "CONFIRM1",
          annualVolatility: s.annualVolatility,
        };
        deliveredEntrySignals.push({ ...delivered });
        signals.push(delivered);
      }
    } else {
      const e = entries.get(symbol)!,
        venue = row.instrument.market;
      if (venue !== "KOSPI" && venue !== "KOSDAQ") continue;
      if (
        e.kosdaq80Onset ||
        e.kospi80Onset ||
        (e.kospiEntry?.state === "pending" && e.kospiEntry.originDate === at)
      )
        rawOnsets.push(symbol);
      if (
        isOperationalEntry(e, at) &&
        (venue !== "KOSPI" || e.kospiEntry?.originDate === priorDate)
      )
        deliveredEntrySignals.push({
          symbol,
          venue,
          sector: row.instrument.sectorCode,
          side: "BUY",
          originDate: venue === "KOSPI" ? e.kospiEntry!.originDate! : at,
          reason: venue === "KOSPI" ? "CONFIRM1" : "ENTRY_ONSET80",
          annualVolatility: null,
        });
      const heldOrPending =
        sleeve.positions.some((p) => p.symbol === symbol) ||
        sleeve.pendingBuys.some((p) => p.symbol === symbol);
      const exit = operationalExit(e, venue, heldOrPending);
      if (exit)
        signals.push({
          symbol,
          venue,
          sector: row.instrument.sectorCode,
          side: "SELL",
          originDate: at,
          reason: exit,
          annualVolatility: null,
        });
      else if (
        isOperationalEntry(e, at) &&
        (venue !== "KOSPI" || e.kospiEntry?.originDate === priorDate)
      )
        signals.push({
          symbol,
          venue,
          sector: row.instrument.sectorCode,
          side: "BUY",
          originDate: venue === "KOSPI" ? e.kospiEntry!.originDate! : at,
          reason: venue === "KOSPI" ? "CONFIRM1" : "ENTRY_ONSET80",
          annualVolatility: null,
        });
    }
  }
  const executionExits: NonNullable<IntegratedAllocationSessionInput["executionExits"]> = [];
  for (const position of sleeve.positions) {
    if (market === "K") {
      const allSessions = clock.calendar.sessions.filter((d) => d <= at);
      const healthy = allSessions.filter((day) =>
        Object.entries(bars).some(
          ([symbol, observations]) =>
            symbol !== position.symbol &&
            observations.some(
              (b) => b.tradeDate === day && b.volumeObserved !== false && positive(b.volume),
            ),
        ),
      );
      const plan = deriveExitPlan(
        tradeForExit(position),
        [snapshot],
        bars[position.symbol] ?? [],
        at,
        healthy,
        allSessions,
      );
      if (plan?.exitDate === at)
        executionExits.push({
          symbol: position.symbol,
          timing: plan.timing,
          price: fromLegacyNumber(plan.exitPrice),
          priceDate: plan.reason.startsWith("모델 가정 청산") ? priorDate! : at,
          reason: plan.reason,
        });
    } else {
      const current = prices.find((p) => p.symbol === position.symbol),
        prior = bars[position.symbol]?.find((b) => b.tradeDate === priorDate);
      // Same exception rule as ETF_V02: liquid peers + unobserved volume + exact previous-session open.
      if (
        !positive(current?.volume) &&
        prices.some((p) => p.symbol !== position.symbol && positive(p.volume)) &&
        prior &&
        prior.openObserved !== false &&
        positive(prior.open)
      )
        executionExits.push({
          symbol: position.symbol,
          timing: "CLOSE",
          price: fromLegacyNumber(prior.open),
          priceDate: prior.tradeDate,
          reason: "MODEL_UNOBSERVED",
        });
    }
  }
  for (const signal of [...signals, ...deliveredEntrySignals])
    if (signal.side === "BUY") {
      const row = rows.find((r) => r.instrument.symbol === signal.symbol)!;
      signal.priority =
        market === "E"
          ? [row.etfStrategy!.averageTradingValue20!]
          : [row.operatingScore10 ?? -1, row.priority.points];
    }
  return {
    ...clock,
    market,
    date: at,
    previousSessionDate: sleeve.lastSessionDate,
    prices,
    rawOnsets,
    signals,
    deliveredEntrySignals,
    signalObservation: rows.some(
      (row) =>
        observedClose(row.instrument.symbol) &&
        (market !== "E" ||
          (row.etfStrategy &&
            row.etfStrategy.version === ETF_POLICY.version &&
            row.etfStrategy.dataStatus !== "krx_batch_pending")),
    )
      ? "COMPLETE"
      : "MISSING",
    executionExits,
    inputIssues,
  };
}

/** A0/Beta exit booleans and entry priority come from the existing US analysis, never a new scorer. */
export function adaptIntegratedUsSession(
  previous: IntegratedAllocationLedger,
  input: {
    analysis: UsProspectiveAnalysis;
    previousAnalysis: UsProspectiveAnalysis | null;
    clock: AllocationAdapterClock;
  },
): IntegratedAllocationSessionInput {
  const { analysis, previousAnalysis, clock } = input,
    sleeve = previous.markets.U,
    at = analysis.date;
  if (
    analysis.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
    at < INTEGRATED_ALLOCATION_START ||
    (sleeve.lastSessionDate !== null && previousAnalysis?.date !== sleeve.lastSessionDate) ||
    (previousAnalysis !== null && previousAnalysis.date >= at) ||
    analysis.rows.some((r) => r.date !== at) ||
    new Set(analysis.rows.map((r) => r.symbol)).size !== analysis.rows.length
  )
    throw new Error("Point-in-time current/prior US analysis required");
  const priorRows = new Map((previousAnalysis?.rows ?? []).map((r) => [r.symbol, r]));
  const current = new Map(analysis.rows.map((r) => [r.symbol, r]));
  const prices = analysis.rows.map((row) => {
    const adv = priorRows.get(row.symbol)?.adv20Usd;
    const capacity =
      positive(row.open) && positive(adv)
        ? String(Math.max(0, Math.floor((adv * US_PROSPECTIVE_PARTICIPATION) / row.open)))
        : "0";
    return {
      symbol: row.symbol,
      open: quote(row.open),
      close: quote(row.close),
      volume: row.volume,
      maxBuyQuantity: capacity,
      maxSellQuantity: capacity,
    };
  });
  const rawOnsets = analysis.rows.filter((r) => r.onset80).map((r) => r.symbol);
  const signals: AllocationSignal[] = [];
  const deliveredEntrySignals: AllocationSignal[] = [...analysis.rows]
    .filter((r) => r.a0Entry && r.symbol !== "SPY")
    .sort(compareUsCandidates)
    .map((row) => ({
      symbol: row.symbol,
      venue: "US",
      sector: row.sector,
      side: "BUY",
      originDate: at,
      reason: "ENTRY_ONSET80",
      annualVolatility: null,
      priority: [row.coreRank ?? -1, row.betaRank ?? -1, row.tkRank ?? -1],
    }));
  const tracked = new Set([
    ...sleeve.positions.map((p) => p.symbol),
    ...sleeve.pendingBuys.map((p) => p.symbol),
  ]);
  for (const symbol of tracked) {
    const row = current.get(symbol);
    if (!row || row.a0Exit)
      signals.push({
        symbol,
        venue: "US",
        sector: row?.sector ?? null,
        side: "SELL",
        originDate: at,
        reason:
          !row || row.coreRank === null
            ? "UNIVERSE_OR_DATA_EXIT"
            : row.a0BetaExit
              ? "A0_BETA_ANCHOR_3D"
              : "CORE_BELOW_0.70",
        annualVolatility: null,
      });
  }
  const reserved = new Set([
    ...sleeve.positions.map((p) => p.symbol),
    ...sleeve.pendingBuys.map((p) => p.symbol),
  ]);
  for (const row of [...analysis.rows]
    .filter((r) => r.a0Entry && r.symbol !== "SPY")
    .sort(compareUsCandidates)) {
    if (
      reserved.has(row.symbol) ||
      signals.some((s) => s.symbol === row.symbol) ||
      reserved.size >= 20
    )
      continue;
    signals.push({
      symbol: row.symbol,
      venue: "US",
      sector: row.sector,
      side: "BUY",
      originDate: at,
      reason: "ENTRY_ONSET80",
      annualVolatility: null,
    });
    reserved.add(row.symbol);
  }
  for (const signal of signals)
    if (signal.side === "BUY") {
      const row = current.get(signal.symbol)!;
      signal.priority = [row.coreRank ?? -1, row.betaRank ?? -1, row.tkRank ?? -1];
    }
  return {
    ...clock,
    market: "U",
    date: at,
    previousSessionDate: sleeve.lastSessionDate,
    prices,
    rawOnsets,
    signals,
    deliveredEntrySignals,
    signalObservation: analysis.rows.some((row) => row.symbol !== "SPY" && positive(row.close))
      ? "COMPLETE"
      : "MISSING",
  };
}
