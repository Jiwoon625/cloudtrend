import { validMasterDay, strategyMarket, type MasterRow } from "./manualMaster";
import type { ActualPriceExitEvidence } from "./newActualPriceExit";
import type { DashboardIndex, DashboardMarketSignals } from "./dashboardOperations";

export const MASTER_EXIT_POLICY = "master-price-exit-v1";
export type MasterExit = ActualPriceExitEvidence & {
  market: "KOSPI" | "ETF";
  symbol: string;
  start: string;
  observedClose: number | null;
  peak: number | null;
  observationDate: string | null;
};

export function masterExitPending(row: MasterRow): MasterExit {
  return {
    market: strategyMarket(row) === "ETF" ? "ETF" : "KOSPI",
    symbol: row.symbol,
    start: row.start,
    status: "가격청산 근거 확인 대기",
    reason: null,
    signalDate: null,
    threshold: null,
    auditStatus: "PENDING",
    observedClose: null,
    peak: null,
    observationDate: null,
  };
}

export type ClosePoint = { tradeDate: string; close: number };

// Exact rational comparison to 12 decimals, independently of display rounding.
function units(value: string) {
  if (!/^\d+(\.\d{1,12})?$/.test(value)) throw new Error("Invalid decimal");
  const [whole, part = ""] = value.split(".");
  return BigInt(whole!) * 1000000000000n + BigInt(part.padEnd(12, "0"));
}

export function evaluateMasterExit(
  row: MasterRow,
  asOf: string,
  index: DashboardIndex,
  bars: readonly ClosePoint[],
): MasterExit {
  const result = masterExitPending(row);
  if (Number(row.quantity) <= 0 || !["KOSPI", "ETF"].includes(strategyMarket(row))) return result;
  const mark = index.rows.find(
    (r) => r.symbol === row.symbol && r.market === result.market && r.date === index.date,
  );
  if (!mark?.price || !Number.isFinite(mark.price) || mark.price <= 0 ||
      index.date < row.start || index.date < asOf) return result;
  const close = units(mark.price.toFixed(12));
  let basis: bigint;
  let ratio: bigint;
  if (result.market === "KOSPI") {
    basis = units(row.averageKrw);
    ratio = 92n;
  } else {
    const relevant = bars.filter((b) => b.tradeDate >= row.start);
    if (
      !relevant.length ||
      relevant.some((b) => !validMasterDay(b.tradeDate) || b.tradeDate > index.date ||
        !Number.isFinite(b.close) || b.close <= 0) ||
      new Set(relevant.map((b) => b.tradeDate)).size !== relevant.length
    ) return result;
    const byDay = new Map(relevant.map((b) => [b.tradeDate, b.close]));
    const required = index.tradeDates.filter((d) => d >= row.start && d <= index.date);
    if (!index.tradeDates.some((d) => d <= row.start) ||
        !required.length || required.some((d) => !byDay.has(d)) ||
        !byDay.has(row.start) || byDay.get(index.date) !== mark.price) return result;
    result.peak = Math.max(...relevant.map((b) => b.close));
    basis = units(result.peak.toFixed(12));
    ratio = 90n;
  }
  if (basis <= 0n) return result;
  const hit = close * 100n <= basis * ratio;
  const threshold = Number(basis * ratio) / 100 / 1e12;
  return {
    ...result,
    status: hit ? "청산 대기 · 다음 거래 가능 시가" : "보유",
    reason: hit ? (result.market === "KOSPI" ? "K4" : "E4") : null,
    threshold: threshold.toFixed(8),
    signalDate: hit ? index.date : null,
    auditStatus: "VERIFIED",
    observedClose: mark.price,
    observationDate: index.date,
  };
}

export function applyMasterPriceExits(
  markets: DashboardMarketSignals[],
  rows: MasterRow[],
  evidence: Record<string, MasterExit>,
): DashboardMarketSignals[] {
  return markets.map((group) => {
    const exits = [...group.exits];
    for (const row of rows) {
      if (Number(row.quantity) <= 0 || strategyMarket(row) !== group.market) continue;
      const exit = evidence[row.symbol];
      if (!exit?.reason || !exit.signalDate || !exit.threshold ||
          !["VERIFIED", "LATCHED"].includes(exit.auditStatus ?? "")) continue;
      if (exit.start !== row.start || exit.market !== group.market) continue;
      const reason = exit.reason + " · 청산 기준 " + Number(exit.threshold).toLocaleString("ko-KR") + "원";
      const existing = exits.findIndex((r) => r.symbol === row.symbol);
      const previous = existing >= 0 ? exits[existing] : undefined;
      const signal = {
        symbol: row.symbol, name: row.name, market: group.market,
        sector: previous?.sector ?? "-", date: exit.signalDate,
        price: exit.observedClose, score: previous?.score ?? null, priority: previous?.priority ?? 0,
        reason: previous ? reason + " · " + previous.reason : reason,
        held: true, actualQuantity: Number(row.quantity), actualEntryDate: row.start,
      };
      if (existing >= 0) exits[existing] = signal;
      else exits.push(signal);
    }
    return { ...group, exits, exitCount: group.exitCount === null && !exits.length ? null : exits.length };
  });
}
