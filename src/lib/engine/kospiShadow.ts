import {
  decimal,
  divide,
  format,
  fromLegacyNumber,
  integerBudgetQuantity,
} from "../ledger/decimal";

/** Research-policy model only. Never import this into operational entry/actual-ledger code. */
export const KOSPI_SHADOW_POLICY = {
  id: "KOSPI_CONFIRM1_BEAR_RSACCEL_SHADOW",
  version: "kospi-confirm1-bear-rsaccel-shadow-v1",
  label: "KOSPI 하루확인·불황 시 RSAccel 필터",
  role: "SHADOW",
  earliestStartDate: "2026-10-02",
  initialCapitalKrw: 100_000_000,
  slots: 30,
  maxPerSector: 3,
  oneWayCost: 0.0015,
  entryScore: 8,
  upsideExitScore: 9.5,
  maxHoldingSessions: 60,
  priceBasis: "SOURCE_OHLC_REFERENCE_NOT_ACTUAL_EXECUTION",
} as const;
export type ShadowRegime = "RISK_ON" | "NEUTRAL" | "RISK_OFF" | "UNKNOWN";
export interface ShadowGate {
  date: string;
  status: ShadowRegime;
  issues: string[];
  [key: string]: unknown;
}
export interface KospiShadowRow {
  symbol: string;
  name: string;
  sector: string;
  date: string;
  open: number | null;
  close: number | null;
  volume: number | null;
  score: number | null;
  priority: number | null;
  rsAccel: number | null;
  commonHistory: boolean;
  onsetEligible: boolean;
}
export interface KospiShadowSession {
  date: string;
  previousSessionDate: string | null;
  sourceHash: string;
  configHash: string;
  codeVersion: string;
  sourceCollectedAt: string;
  confirmedClose: boolean;
  benchmarkClose: number;
  gate: ShadowGate;
  rows: KospiShadowRow[];
  /** Optional final pre-start observations only; never legacy positions or pending signals. */
  warmupRows?: KospiShadowRow[];
}
export interface ShadowCandidate {
  key: string;
  symbol: string;
  name: string;
  sector: string;
  originDate: string;
  originScore: number;
  onsetRegime: ShadowRegime;
  onsetGate: ShadowGate;
  requiresRsAccel: boolean;
  confirmationDate: string | null;
  confirmationScore: number | null;
  confirmationRsAccel: number | null;
  confirmationUp95: boolean;
  priority: number | null;
  status: "AWAITING_CONFIRMATION" | "MODEL_ENTRY_PENDING" | "EXCLUDED" | "MODEL_FILLED";
  reason: string;
}
export interface ShadowPosition {
  symbol: string;
  name: string;
  sector: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  basisKrw: number;
  /** Present only for the explicitly isolated October model. */
  modelBasisExact?: string;
  lastPrice: number;
  lastPriceDate: string;
  lastPriceBasis: "OPEN" | "CLOSE";
  heldSessions: number;
  candidate: ShadowCandidate;
}
export interface ShadowTrade {
  key: string;
  strategyId: typeof KOSPI_SHADOW_POLICY.id;
  modelOnly: true;
  symbol: string;
  name: string;
  sector: string;
  side: "BUY" | "SELL";
  signalDate: string;
  executionDate: string;
  price: number;
  shares: number;
  feeKrw: number;
  notionalKrw: number;
  reason: string;
  originDate: string;
  onsetRegime: ShadowRegime;
  realizedPnlKrw: number | null;
  netReturn: number | null;
}
export interface ShadowDaily {
  date: string;
  navKrw: number;
  cashKrw: number;
  benchmarkNavKrw: number;
  exposure: number;
  dailyReturn: number | null;
  cumulativeReturn: number;
  cagr: number | null;
  mdd: number;
  averageExposure: number;
  positions: number;
  feesKrw: number;
  turnover: number;
  staleMarks: string[];
}
/** Additive sizing/accounting boundary; omission preserves the existing research series. */
export interface KospiModelExecutionPolicy {
  version: "isolated-kospi-model-v1";
  bookId: string;
  contractHash: string;
  codeHash: string;
  configHash: string;
  accountingStartDate: "2026-10-12";
  fixedBudgetEndExclusive: "2027-10-12";
  initialCapitalKrw: "100000000";
  oneWayCost: "0.0015";
}
export interface KospiShadowState {
  executionPolicy?: KospiModelExecutionPolicy;
  modelCashExact?: string;
  modelFeesExact?: string;
  strategyId: typeof KOSPI_SHADOW_POLICY.id;
  ruleVersion: string;
  configHash: string;
  initializedDate: string;
  lastDate: string;
  initialCapitalKrw: number;
  cashKrw: number;
  benchmarkBase: number;
  previousRows: Record<string, KospiShadowRow>;
  awaiting: ShadowCandidate[];
  pendingEntries: ShadowCandidate[];
  pendingExits: Record<string, { reason: string; signalDate: string }>;
  positions: Record<string, ShadowPosition>;
  lastNavKrw: number;
  peakNavKrw: number;
  mdd: number;
  exposureSum: number;
  sessions: number;
  totalFeesKrw: number;
  totalEntries: number;
  totalClosedTrades: number;
}
export interface KospiShadowSnapshot {
  schemaVersion: 1;
  policy: typeof KOSPI_SHADOW_POLICY;
  source: Omit<KospiShadowSession, "rows">;
  state: KospiShadowState;
  daily: ShadowDaily;
  candidates: ShadowCandidate[];
  trades: ShadowTrade[];
}
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const up95 = (previous: number | null | undefined, current: number | null | undefined) =>
  finite(previous) && finite(current) && previous < 9.5 && current >= 9.5;
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

export function validateShadowSession(session: KospiShadowSession) {
  if (
    !validDate(session.date) ||
    !session.confirmedClose ||
    session.date < KOSPI_SHADOW_POLICY.earliestStartDate
  )
    throw new Error("Shadow requires a confirmed prospective KOSPI close");
  if (
    !session.sourceHash ||
    !session.configHash ||
    !session.codeVersion ||
    !session.sourceCollectedAt
  )
    throw new Error("Shadow source/config/code provenance is required");
  if (!positive(session.benchmarkClose) || session.gate.date !== session.date)
    throw new Error("Shadow benchmark/gate must match the exact session");
  if (
    session.previousSessionDate !== null &&
    (!validDate(session.previousSessionDate) || session.previousSessionDate >= session.date)
  )
    throw new Error("Invalid previous KOSPI session");
  if (new Set(session.rows.map((r) => r.symbol)).size !== session.rows.length)
    throw new Error("Duplicate Shadow symbols");
  if (session.rows.some((r) => r.date !== session.date || !r.symbol || !r.sector))
    throw new Error("Shadow rows must have dated symbol and sector provenance");
}

/** Pure next-session simulation. Existing positions and pending orders only come from frozen snapshots. */
export function stepKospiShadow(
  session: KospiShadowSession,
  previous: KospiShadowState | null,
  executionPolicy?: KospiModelExecutionPolicy,
): KospiShadowSnapshot {
  validateShadowSession(session);
  if (previous?.executionPolicy && !executionPolicy)
    throw new Error("Isolated KOSPI state cannot enter the legacy Shadow engine path");
  if (executionPolicy) {
    const p = executionPolicy;
    if (
      p.version !== "isolated-kospi-model-v1" ||
      p.bookId !== "adopted-shadow-2026-10-12-v2:KR_KOSPI_CONFIRM1_BEAR" ||
      ![p.contractHash, p.codeHash, p.configHash].every((hash) =>
        /^sha256:[a-f0-9]{64}$/.test(hash),
      ) ||
      p.accountingStartDate !== "2026-10-12" ||
      p.fixedBudgetEndExclusive !== "2027-10-12" ||
      p.initialCapitalKrw !== "100000000" ||
      p.oneWayCost !== "0.0015" ||
      session.configHash !== p.configHash ||
      session.codeVersion !== p.codeHash ||
      session.date < p.accountingStartDate ||
      session.date >= p.fixedBudgetEndExclusive
    )
      throw new Error("Invalid isolated KOSPI execution policy or first-year boundary");
    if (
      session.warmupRows &&
      (previous !== null ||
        session.date !== "2026-10-12" ||
        new Set(session.warmupRows.map((row) => row.symbol)).size !== session.warmupRows.length ||
        session.warmupRows.some((row) => row.date !== "2026-10-08" || !row.symbol || !row.sector))
    )
      throw new Error("KOSPI warmup permits only final pre-start observations at initialization");
    const identity = (value: KospiModelExecutionPolicy) =>
      JSON.stringify([
        value.version,
        value.bookId,
        value.contractHash,
        value.codeHash,
        value.configHash,
        value.accountingStartDate,
        value.fixedBudgetEndExclusive,
        value.initialCapitalKrw,
        value.oneWayCost,
      ]);
    if (previous) {
      if (
        !previous.executionPolicy ||
        identity(previous.executionPolicy) !== identity(p) ||
        previous.initializedDate !== p.accountingStartDate ||
        previous.initialCapitalKrw !== Number(p.initialCapitalKrw) ||
        previous.modelCashExact === undefined ||
        previous.modelFeesExact === undefined ||
        Number(previous.modelCashExact) !== previous.cashKrw ||
        Number(previous.modelFeesExact) !== previous.totalFeesKrw ||
        decimal(previous.modelCashExact) < 0n ||
        decimal(previous.modelFeesExact) < 0n
      )
        throw new Error("KOSPI state does not match its frozen execution policy");
      const candidates = [
        ...previous.awaiting,
        ...previous.pendingEntries,
        ...Object.values(previous.positions).map((position) => position.candidate),
      ];
      if (
        previous.lastDate < p.accountingStartDate ||
        candidates.some(
          (candidate) =>
            candidate.originDate < p.accountingStartDate ||
            (candidate.confirmationDate !== null &&
              candidate.confirmationDate < candidate.originDate),
        ) ||
        Object.values(previous.pendingExits).some(
          (order) => order.signalDate < p.accountingStartDate,
        ) ||
        Object.values(previous.previousRows).some((row) => row.date < p.accountingStartDate) ||
        Object.values(previous.positions).some(
          (position) =>
            position.entryDate < p.accountingStartDate ||
            !Number.isSafeInteger(position.shares) ||
            position.shares <= 0 ||
            position.modelBasisExact === undefined ||
            decimal(position.modelBasisExact) <= 0n ||
            Number(position.modelBasisExact) !== position.basisKrw,
        )
      )
        throw new Error("Pre-start signals or invalid positions cannot enter isolated KOSPI state");
    }
  }
  if (
    previous &&
    (previous.strategyId !== KOSPI_SHADOW_POLICY.id ||
      previous.ruleVersion !== KOSPI_SHADOW_POLICY.version ||
      previous.configHash !== session.configHash)
  )
    throw new Error("Shadow policy/config is frozen; do not mutate an existing series");
  if (
    previous &&
    (session.date <= previous.lastDate || session.previousSessionDate !== previous.lastDate)
  )
    throw new Error(
      "Shadow requires the exact next session; duplicate, stale and missing sessions are rejected",
    );
  const rows = new Map(session.rows.map((r) => [r.symbol, r]));
  const state: KospiShadowState = previous
    ? clone(previous)
    : {
        ...(executionPolicy
          ? {
              executionPolicy: clone(executionPolicy),
              modelCashExact: executionPolicy.initialCapitalKrw,
              modelFeesExact: "0",
            }
          : {}),
        strategyId: KOSPI_SHADOW_POLICY.id,
        ruleVersion: KOSPI_SHADOW_POLICY.version,
        configHash: session.configHash,
        initializedDate: executionPolicy?.accountingStartDate ?? session.date,
        lastDate: session.date,
        initialCapitalKrw: KOSPI_SHADOW_POLICY.initialCapitalKrw,
        cashKrw: KOSPI_SHADOW_POLICY.initialCapitalKrw,
        benchmarkBase: session.benchmarkClose,
        previousRows: executionPolicy
          ? Object.fromEntries((session.warmupRows ?? []).map((row) => [row.symbol, clone(row)]))
          : {},
        awaiting: [],
        pendingEntries: [],
        pendingExits: {},
        positions: {},
        lastNavKrw: KOSPI_SHADOW_POLICY.initialCapitalKrw,
        peakNavKrw: KOSPI_SHADOW_POLICY.initialCapitalKrw,
        mdd: 0,
        exposureSum: 0,
        sessions: 0,
        totalFeesKrw: 0,
        totalEntries: 0,
        totalClosedTrades: 0,
      };
  const candidates: ShadowCandidate[] = [],
    trades: ShadowTrade[] = [];
  let fees = 0,
    notional = 0;
  // Legacy allocation retains prior NAV/30; the opt-in October contract uses fixed capital/30.
  const targetTicket = state.lastNavKrw / KOSPI_SHADOW_POLICY.slots;
  const fixedBudget = executionPolicy
    ? format(divide(decimal(executionPolicy.initialCapitalKrw), decimal("30")))
    : null;
  let modelCash = executionPolicy ? decimal(state.modelCashExact!) : 0n;
  let modelFees = executionPolicy ? decimal(state.modelFeesExact!) : 0n;
  let dayModelFees = 0n;
  const record = (
    position: ShadowPosition,
    side: "BUY" | "SELL",
    price: number,
    reason: string,
    signalDate: string,
  ) => {
    let gross = price * position.shares,
      fee = gross * KOSPI_SHADOW_POLICY.oneWayCost;
    let pnl = side === "SELL" ? gross - fee - position.basisKrw : null;
    if (executionPolicy) {
      if (!Number.isSafeInteger(position.shares) || position.shares <= 0)
        throw new Error("KOSPI model fills require positive safe integer shares");
      const exactGross = decimal(fromLegacyNumber(price)) * BigInt(position.shares);
      const scale = decimal("1");
      const exactFee = (exactGross * decimal(executionPolicy.oneWayCost) + scale - 1n) / scale;
      modelCash += (side === "BUY" ? -exactGross : exactGross) - exactFee;
      if (modelCash < 0n) throw new Error("Isolated KOSPI fill exceeds exact cash");
      modelFees += exactFee;
      dayModelFees += exactFee;
      state.modelCashExact = format(modelCash);
      state.modelFeesExact = format(modelFees);
      state.cashKrw = Number(state.modelCashExact);
      state.totalFeesKrw = Number(state.modelFeesExact);
      fees = Number(format(dayModelFees));
      gross = Number(format(exactGross));
      fee = Number(format(exactFee));
      if (side === "BUY") {
        position.modelBasisExact = format(exactGross + exactFee);
        position.basisKrw = Number(position.modelBasisExact);
      } else pnl = Number(format(exactGross - exactFee - decimal(position.modelBasisExact!)));
    } else fees += fee;
    notional += gross;
    trades.push({
      key: [KOSPI_SHADOW_POLICY.id, position.candidate.key, session.date, side, reason].join("|"),
      strategyId: KOSPI_SHADOW_POLICY.id,
      modelOnly: true,
      symbol: position.symbol,
      name: position.name,
      sector: position.sector,
      side,
      signalDate,
      executionDate: session.date,
      price,
      shares: position.shares,
      feeKrw: fee,
      notionalKrw: gross,
      reason,
      originDate: position.candidate.originDate,
      onsetRegime: position.candidate.onsetRegime,
      realizedPnlKrw: pnl,
      netReturn: pnl === null ? null : pnl / position.basisKrw,
    });
    return { gross, fee };
  };
  const close = (position: ShadowPosition, price: number, reason: string, signalDate: string) => {
    const { gross, fee } = record(position, "SELL", price, reason, signalDate);
    if (!executionPolicy) state.cashKrw += gross - fee;
    state.totalClosedTrades++;
    delete state.positions[position.symbol];
    delete state.pendingExits[position.symbol];
  };
  // Frozen held exit orders execute before entry allocation. Missing/halted opens defer exits only.
  for (const p of Object.values(state.positions)) {
    const row = rows.get(p.symbol),
      exit = state.pendingExits[p.symbol];
    if (positive(row?.open)) {
      p.lastPrice = row.open;
      p.lastPriceDate = session.date;
      p.lastPriceBasis = "OPEN";
    }
    if (exit && positive(row?.open) && positive(row?.volume))
      close(p, row.open, exit.reason, exit.signalDate);
  }
  for (const saved of state.pendingEntries.sort(
    (a, b) =>
      (b.confirmationScore ?? -Infinity) - (a.confirmationScore ?? -Infinity) ||
      (b.priority ?? -Infinity) - (a.priority ?? -Infinity) ||
      a.symbol.localeCompare(b.symbol),
  )) {
    const c = clone(saved),
      row = rows.get(c.symbol);
    let reason: string | null = null;
    if (state.positions[c.symbol]) reason = "ALREADY_HELD";
    else if (Object.keys(state.positions).length >= KOSPI_SHADOW_POLICY.slots)
      reason = "POSITION_CAP";
    else if (
      Object.values(state.positions).filter((p) => p.sector === c.sector).length >=
      KOSPI_SHADOW_POLICY.maxPerSector
    )
      reason = "SECTOR_CAP";
    else if (!positive(row?.open) || !positive(row?.volume))
      reason = "NO_EXECUTABLE_OPEN_NO_LATE_RETRY";
    else {
      const shares = executionPolicy
        ? Number(
            integerBudgetQuantity(
              fixedBudget!,
              format(modelCash),
              fromLegacyNumber(row.open),
              executionPolicy.oneWayCost,
            ),
          )
        : Math.min(
            Math.max(1, Math.floor(targetTicket / row.open + 0.5)),
            Math.floor(state.cashKrw / (row.open * (1 + KOSPI_SHADOW_POLICY.oneWayCost))),
          );
      if (shares < 1) reason = "INSUFFICIENT_MODEL_CASH";
      else {
        const p: ShadowPosition = {
          symbol: c.symbol,
          name: c.name,
          sector: c.sector,
          shares,
          entryPrice: row.open,
          entryDate: session.date,
          basisKrw: shares * row.open * (1 + KOSPI_SHADOW_POLICY.oneWayCost),
          lastPrice: row.open,
          lastPriceDate: session.date,
          lastPriceBasis: "OPEN",
          heldSessions: 0,
          candidate: clone(c),
        };
        const { gross, fee } = record(
          p,
          "BUY",
          row.open,
          "CONFIRMED_RESEARCH_ENTRY",
          c.confirmationDate!,
        );
        if (!executionPolicy) state.cashKrw -= gross + fee;
        state.positions[c.symbol] = p;
        state.totalEntries++;
        c.status = "MODEL_FILLED";
        c.reason = "MODEL_ONLY_NEXT_SESSION_OPEN";
      }
    }
    if (reason) {
      c.status = "EXCLUDED";
      c.reason = reason;
    }
    candidates.push(c);
  }
  state.pendingEntries = [];
  // Capture held status before H60 closes, matching the confirmation-UP95 research exception.
  const heldOnConfirmationClose = new Set(Object.keys(state.positions));
  for (const p of Object.values(state.positions)) {
    const row = rows.get(p.symbol);
    if (positive(row?.close)) {
      p.lastPrice = row.close;
      p.lastPriceDate = session.date;
      p.lastPriceBasis = "CLOSE";
      p.heldSessions++;
      if (p.heldSessions >= KOSPI_SHADOW_POLICY.maxHoldingSessions) {
        if (positive(row.open) && positive(row.volume))
          close(p, row.close, "H60_CLOSE", session.date);
        else
          state.pendingExits[p.symbol] ??= {
            reason: "H60_DEFERRED_OPEN",
            signalDate: session.date,
          };
      }
    }
    if (state.positions[p.symbol] && up95(state.previousRows[p.symbol]?.score, row?.score))
      state.pendingExits[p.symbol] ??= { reason: "UP95", signalDate: session.date };
  }
  for (const saved of state.awaiting) {
    const c = clone(saved),
      row = rows.get(c.symbol);
    c.confirmationDate = session.date;
    c.confirmationScore = row?.score ?? null;
    c.confirmationRsAccel = row?.rsAccel ?? null;
    c.confirmationUp95 = up95(c.originScore, row?.score);
    c.priority = row?.priority ?? null;
    let reason: string | null = null;
    if (c.onsetRegime === "UNKNOWN") reason = "ONSET_REGIME_UNOBSERVABLE";
    else if (!row || !finite(row.score)) reason = "CONFIRMATION_SCORE_MISSING";
    else if (row.score < KOSPI_SHADOW_POLICY.entryScore) reason = "CONFIRMATION_SCORE_BELOW_8";
    else if (!row.commonHistory || !positive(row.open))
      reason = "COMMON_HISTORY_OR_SIGNAL_OPEN_INELIGIBLE";
    else if (c.requiresRsAccel && !finite(row.rsAccel))
      reason = "BEAR_CONFIRMATION_RSACCEL_MISSING";
    else if (c.requiresRsAccel && row.rsAccel! <= 0)
      reason = "BEAR_CONFIRMATION_RSACCEL_NONPOSITIVE";
    else if (c.confirmationUp95 && heldOnConfirmationClose.has(c.symbol))
      reason = "HELD_UP95_EXCEPTION_BLOCKED";
    if (reason) {
      c.status = "EXCLUDED";
      c.reason = reason;
    } else {
      c.status = "MODEL_ENTRY_PENDING";
      c.reason = "MODEL_ONLY_NEXT_SESSION_OPEN";
      state.pendingEntries.push(clone(c));
    }
    candidates.push(c);
  }
  state.awaiting = [];
  // Optional warmup only detects an onset at this first post-start close. No earlier intent is imported.
  if (previous || (executionPolicy && session.warmupRows?.length))
    for (const row of session.rows) {
      const old = state.previousRows[row.symbol];
      if (
        !old ||
        !finite(old.score) ||
        !finite(row.score) ||
        old.score >= 8 ||
        row.score < 8 ||
        !row.onsetEligible
      )
        continue;
      const c: ShadowCandidate = {
        key: `${row.symbol}|${session.date}`,
        symbol: row.symbol,
        name: row.name,
        sector: row.sector,
        originDate: session.date,
        originScore: row.score,
        onsetRegime: session.gate.status,
        onsetGate: clone(session.gate),
        requiresRsAccel: session.gate.status === "RISK_OFF",
        confirmationDate: null,
        confirmationScore: null,
        confirmationRsAccel: null,
        confirmationUp95: false,
        priority: null,
        status: "AWAITING_CONFIRMATION",
        reason: "NEXT_KOSPI_SESSION_CLOSE",
      };
      if (session.gate.status === "UNKNOWN") {
        c.status = "EXCLUDED";
        c.reason = "ONSET_REGIME_UNOBSERVABLE";
      } else state.awaiting.push(clone(c));
      candidates.push(c);
    }
  const value = Object.values(state.positions).reduce((sum, p) => sum + p.shares * p.lastPrice, 0),
    nav = state.cashKrw + value;
  const exposure = nav > 0 ? value / nav : 0;
  state.peakNavKrw = Math.max(state.peakNavKrw, nav);
  state.mdd = Math.min(state.mdd, nav / state.peakNavKrw - 1);
  state.sessions++;
  state.exposureSum += exposure;
  if (!executionPolicy) state.totalFeesKrw += fees;
  const elapsed = state.sessions - 1;
  const daily: ShadowDaily = {
    date: session.date,
    navKrw: nav,
    cashKrw: state.cashKrw,
    benchmarkNavKrw: (state.initialCapitalKrw * session.benchmarkClose) / state.benchmarkBase,
    exposure,
    dailyReturn: previous ? nav / state.lastNavKrw - 1 : null,
    cumulativeReturn: nav / state.initialCapitalKrw - 1,
    cagr: elapsed > 0 ? Math.pow(nav / state.initialCapitalKrw, 252 / elapsed) - 1 : null,
    mdd: state.mdd,
    averageExposure: state.exposureSum / state.sessions,
    positions: Object.keys(state.positions).length,
    feesKrw: fees,
    turnover: notional / state.lastNavKrw,
    staleMarks: Object.values(state.positions)
      .filter((p) => p.lastPriceDate !== session.date || p.lastPriceBasis !== "CLOSE")
      .map((p) => p.symbol),
  };
  state.lastDate = session.date;
  state.lastNavKrw = nav;
  state.previousRows = Object.fromEntries(session.rows.map((row) => [row.symbol, clone(row)]));
  const { rows: _rows, ...source } = session;
  return {
    schemaVersion: 1,
    policy: KOSPI_SHADOW_POLICY,
    source: clone(source),
    state,
    daily,
    candidates,
    trades,
  };
}
