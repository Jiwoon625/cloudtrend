export const US_PROSPECTIVE_RULE_VERSION = "us-prospective-1.0.0";

export type UsProspectiveStrategyId =
  | "A0_QUARTER_PRIMARY"
  | "A2_QUARTER_SHADOW"
  | "B3_BETA_SHADOW";

export interface UsProspectiveInputRow {
  date: string;
  symbol: string;
  name: string;
  market: string | null;
  sector: string | null;
  securityType: string | null;
  status: string | null;
  currency: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  dollarVolume: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  ret120: number | null;
  ret252: number | null;
  beta60Spy: number | null;
  ichimokuTkGap: number | null;
  relvol1_20: number | null;
  adv20Usd: number | null;
  amihud20: number | null;
  active20: boolean;
  tossTradable: boolean;
  isCommonShare: boolean;
  fxUsdKrw: number | null;
}

export interface UsProspectivePreviousState {
  coreRanks?: Record<string, number>;
  betaWeakStreak?: Record<string, number>;
}

export interface UsProspectiveRow extends UsProspectiveInputRow {
  ret120Rank: number | null;
  ret252Rank: number | null;
  coreScore: number | null;
  coreRank: number | null;
  betaRank: number | null;
  tkRank: number | null;
  relvolRank: number | null;
  liquidityRank: number | null;
  amihudRank: number | null;
  eligibleBase: boolean;
  onset80: boolean;
  aggressiveConfirm: boolean;
  balancedConfirm: boolean;
  a0Entry: boolean;
  a0Exit: boolean;
  a2Entry: boolean;
  a2Exit: boolean;
  b3Entry: boolean;
  b3BaseExit: boolean;
  betaWeakStreak: number;
  b3BetaExit: boolean;
  b3Exit: boolean;
  primarySignal: "ENTRY" | "EXIT" | "WATCH" | "NONE";
}

export interface UsProspectiveAnalysis {
  date: string;
  ruleVersion: string;
  rows: UsProspectiveRow[];
  state: Required<UsProspectivePreviousState>;
  summary: {
    inputRows: number;
    rankedRows: number;
    a0Entries: number;
    a0Exits: number;
    a2Entries: number;
    a2Exits: number;
    b3Entries: number;
    b3Exits: number;
    spyClose: number | null;
  };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else quoted = false;
      } else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const s = value.trim();
  if (!s || /^(na|n\/a|null|none|nan)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["true", "1", "y", "yes", "t"].includes(value.trim().toLowerCase());
}

export function parseUsProspectiveCsv(text: string): UsProspectiveInputRow[] {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("US 스크리닝 CSV에 헤더 또는 데이터가 없습니다.");
  const header = splitCsvLine(lines[0]!).map((v) => v.trim());
  const idx = new Map(header.map((key, i) => [key, i]));
  const v = (cells: string[], key: string) => {
    const i = idx.get(key);
    return i === undefined ? undefined : cells[i];
  };
  const required = [
    "date",
    "symbol",
    "open",
    "close",
    "ret120",
    "ret252",
    "beta60_spy",
    "ichimoku_tk_gap",
    "relvol1_20",
    "adv20_usd",
    "amihud20",
  ];
  const missing = required.filter((key) => !idx.has(key));
  if (missing.length > 0) throw new Error(`US 스크리닝 CSV 필수 열 누락: ${missing.join(", ")}`);

  return lines.slice(1).flatMap((line) => {
    const c = splitCsvLine(line);
    const symbol = (v(c, "symbol") ?? "").trim().toUpperCase();
    const date = (v(c, "date") ?? "").trim().slice(0, 10);
    if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [
      {
        date,
        symbol,
        name: (v(c, "name") ?? symbol).trim() || symbol,
        market: (v(c, "market") ?? "").trim() || null,
        sector: (v(c, "sector") ?? "").trim() || null,
        securityType: (v(c, "security_type") ?? "").trim() || null,
        status: (v(c, "status") ?? "").trim() || null,
        currency: (v(c, "currency") ?? "").trim() || null,
        open: num(v(c, "open")),
        high: num(v(c, "high")),
        low: num(v(c, "low")),
        close: num(v(c, "close")),
        volume: num(v(c, "volume")),
        dollarVolume: num(v(c, "dollar_volume")),
        sharesOutstanding: num(v(c, "shares_outstanding")),
        marketCap: num(v(c, "market_cap")),
        ret120: num(v(c, "ret120")),
        ret252: num(v(c, "ret252")),
        beta60Spy: num(v(c, "beta60_spy")),
        ichimokuTkGap: num(v(c, "ichimoku_tk_gap")),
        relvol1_20: num(v(c, "relvol1_20")),
        adv20Usd: num(v(c, "adv20_usd")),
        amihud20: num(v(c, "amihud20")),
        active20: bool(v(c, "active20")),
        tossTradable: bool(v(c, "toss_tradable"), true),
        isCommonShare: bool(v(c, "is_common_share"), true),
        fxUsdKrw: num(v(c, "fx_usdkrw")),
      },
    ];
  });
}

function percentileRank(items: Array<[string, number]>): Map<string, number> {
  const sorted = [...items].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const out = new Map<string, number>();
  if (sorted.length === 0) return out;
  if (sorted.length === 1) {
    out.set(sorted[0]![0], 1);
    return out;
  }
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j]![1] === sorted[i]![1]) j++;
    const averageZeroBasedRank = ((i + (j - 1)) / 2) / (sorted.length - 1);
    for (let k = i; k < j; k++) out.set(sorted[k]![0], averageZeroBasedRank);
    i = j;
  }
  return out;
}

function finitePairs(rows: UsProspectiveInputRow[], field: keyof UsProspectiveInputRow, invert = false) {
  const pairs: Array<[string, number]> = [];
  for (const row of rows) {
    const value = row[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    pairs.push([row.symbol, invert ? -value : value]);
  }
  return pairs;
}

function rankOf(map: Map<string, number>, symbol: string) {
  return map.get(symbol) ?? null;
}

/**
 * US3.5/US3.8 동결 산식의 prospective 구현.
 * - Core: rank(ret120) 50% + rank(ret252) 50% -> 재순위
 * - Entry: Core 0.80 Onset + beta top10% + liquidity/amihud bottom10% 제외
 * - A0/A2 confirmation: ichimoku TK gap top20%
 * - B3 confirmation: relvol1_20 top20%
 * - A0/A2 Core exit: <0.70, B3 base exit: <0.50
 * - B3 shadow extra exit: beta rank <0.60 3일 연속
 */
export function runUsProspectiveAnalysis(
  inputRows: UsProspectiveInputRow[],
  previous: UsProspectivePreviousState = {},
): UsProspectiveAnalysis {
  if (inputRows.length === 0) throw new Error("US 스크리닝 입력이 비어 있습니다.");
  const date = inputRows.map((r) => r.date).sort().at(-1)!;
  const rows = inputRows.filter((r) => r.date === date);

  const tradable = rows.filter(
    (r) =>
      r.isCommonShare &&
      r.tossTradable &&
      (r.status === null || r.status.toUpperCase() === "ACTIVE") &&
      r.close !== null &&
      r.close > 0 &&
      r.ret120 !== null &&
      r.ret252 !== null,
  );

  const r120 = percentileRank(finitePairs(tradable, "ret120"));
  const r252 = percentileRank(finitePairs(tradable, "ret252"));
  const beta = percentileRank(finitePairs(tradable, "beta60Spy"));
  const tk = percentileRank(finitePairs(tradable, "ichimokuTkGap"));
  const relvol = percentileRank(finitePairs(tradable, "relvol1_20"));
  const liq = percentileRank(finitePairs(tradable, "adv20Usd"));
  const ami = percentileRank(finitePairs(tradable, "amihud20", true));
  const coreScores: Array<[string, number]> = [];
  for (const row of tradable) {
    const a = r120.get(row.symbol);
    const b = r252.get(row.symbol);
    if (a === undefined || b === undefined) continue;
    coreScores.push([row.symbol, 0.5 * a + 0.5 * b]);
  }
  const coreRank = percentileRank(coreScores);
  const coreScore = new Map(coreScores);
  const prevCore = previous.coreRanks ?? {};
  const prevBetaStreak = previous.betaWeakStreak ?? {};
  const nextCore: Record<string, number> = {};
  const nextStreak: Record<string, number> = {};

  const out: UsProspectiveRow[] = rows.map((row) => {
    const core = rankOf(coreRank, row.symbol);
    const b = rankOf(beta, row.symbol);
    const tkRank = rankOf(tk, row.symbol);
    const rv = rankOf(relvol, row.symbol);
    const l = rankOf(liq, row.symbol);
    const a = rankOf(ami, row.symbol);
    if (core !== null) nextCore[row.symbol] = core;
    const prior = prevCore[row.symbol];
    const onset80 = !bootstrap && core !== null && core >= 0.8 && prior !== undefined && Number.isFinite(prior) && prior < 0.8;
    const eligibleBase =
      core !== null &&
      b !== null &&
      l !== null &&
      a !== null &&
      row.active20 &&
      (row.adv20Usd ?? 0) >= 500_000 &&
      b >= 0.9 &&
      l >= 0.1 &&
      a >= 0.1;
    const aggressiveConfirm = tkRank !== null && tkRank >= 0.8;
    const balancedConfirm = rv !== null && rv >= 0.8;
    const weak = b !== null && b < 0.6;
    const streak = weak ? (prevBetaStreak[row.symbol] ?? 0) + 1 : 0;
    nextStreak[row.symbol] = streak;
    const a0Entry = eligibleBase && onset80 && aggressiveConfirm;
    const a0Exit = core === null || core < 0.7;
    const a2Entry = a0Entry;
    const a2Exit = a0Exit;
    const b3Entry = eligibleBase && onset80 && balancedConfirm;
    const b3BaseExit = core === null || core < 0.5;
    const b3BetaExit = streak >= 3;
    const b3Exit = b3BaseExit || b3BetaExit;
    return {
      ...row,
      ret120Rank: rankOf(r120, row.symbol),
      ret252Rank: rankOf(r252, row.symbol),
      coreScore: coreScore.get(row.symbol) ?? null,
      coreRank: core,
      betaRank: b,
      tkRank,
      relvolRank: rv,
      liquidityRank: l,
      amihudRank: a,
      eligibleBase,
      onset80,
      aggressiveConfirm,
      balancedConfirm,
      a0Entry,
      a0Exit,
      a2Entry,
      a2Exit,
      b3Entry,
      b3BaseExit,
      betaWeakStreak: streak,
      b3BetaExit,
      b3Exit,
      primarySignal: a0Entry ? "ENTRY" : a0Exit ? "EXIT" : core !== null && core >= 0.7 ? "WATCH" : "NONE",
    };
  });

  out.sort(
    (x, y) =>
      (y.coreRank ?? -1) - (x.coreRank ?? -1) ||
      (y.betaRank ?? -1) - (x.betaRank ?? -1) ||
      x.symbol.localeCompare(y.symbol),
  );
  const spyClose = out.find((r) => r.symbol === "SPY")?.close ?? null;
  return {
    date,
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    rows: out,
    state: { coreRanks: nextCore, betaWeakStreak: nextStreak },
    summary: {
      inputRows: rows.length,
      rankedRows: coreRank.size,
      a0Entries: out.filter((r) => r.a0Entry).length,
      a0Exits: out.filter((r) => r.a0Exit).length,
      a2Entries: out.filter((r) => r.a2Entry).length,
      a2Exits: out.filter((r) => r.a2Exit).length,
      b3Entries: out.filter((r) => r.b3Entry).length,
      b3Exits: out.filter((r) => r.b3Exit).length,
      spyClose,
    },
  };
}

export function usProspectiveCompactSignals(analysis: UsProspectiveAnalysis) {
  return analysis.rows
    .filter((r) => r.a0Entry || r.a2Entry || r.b3Entry || r.a0Exit || r.b3Exit)
    .slice(0, 250)
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      coreRank: r.coreRank,
      betaRank: r.betaRank,
      tkRank: r.tkRank,
      relvolRank: r.relvolRank,
      a0Entry: r.a0Entry,
      a0Exit: r.a0Exit,
      a2Entry: r.a2Entry,
      a2Exit: r.a2Exit,
      b3Entry: r.b3Entry,
      b3Exit: r.b3Exit,
      b3BetaExit: r.b3BetaExit,
    }));
}
