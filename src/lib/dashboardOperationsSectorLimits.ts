import { STRATEGY_CONFIG } from "./engine/operationalStrategy";
import type { LedgerDocument } from "./portfolioLedgers";

export interface DashboardSectorLimit {
  status: "blocked" | "room" | "unknown";
  count: number | null;
  limit: number | null;
  cap: number;
  maxPositions: number | null;
  asOfDate: string | null;
  issue: string | null;
}
export interface DashboardSectorContext {
  counts: Map<string, number> | null;
  maxPositions: number | null;
  asOfDate: string | null;
  issue: string | null;
}
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
// Missing mappings must never masquerade as an empty sector. Keep all actual codes
// unchanged: the strategy engine compares sectorCode, not display names or markets.
const unknownCodes = new Set(["", "-", "ETC", "기타", "미분류", "OTHER", "UNKNOWN", "N/A", "NA"]);
const knownSector = (value: unknown): value is string =>
  typeof value === "string" && !unknownCodes.has(value.trim().toUpperCase());

/** Read the saved strategy only. Never replay, sync, mutate, or substitute actual holdings. */
export function projectDashboardSectorContext(
  doc: LedgerDocument | null,
  screeningCreatedAt?: string | undefined,
): DashboardSectorContext {
  const maxPositions = doc?.settings?.maxPositions;
  const strategy = doc?.strategy;
  const context: DashboardSectorContext = {
    counts: null,
    maxPositions:
      typeof maxPositions === "number" && Number.isSafeInteger(maxPositions) && maxPositions > 0
        ? maxPositions
        : null,
    asOfDate: date(strategy?.summary?.latestDate) ? strategy.summary.latestDate : null,
    issue: null,
  };
  if (!strategy) return { ...context, issue: "전략 장부 미수신" };
  if (context.maxPositions === null || !context.asOfDate || !Array.isArray(strategy.trades))
    return { ...context, issue: "전략 장부 자료 미확인" };
  const counts = new Map<string, number>();
  const symbols = new Set<string>();
  for (const trade of strategy.trades) {
    if (!trade || typeof trade !== "object") return { ...context, issue: "전략 보유 자료 미확인" };
    // ETF and US ledgers are separate strategies and never use Korean stock slots.
    if (["ETF", "US"].includes(trade.market)) continue;
    if (trade.market !== "KOSPI" && trade.market !== "KOSDAQ")
      return { ...context, issue: "전략 보유 시장 미확인" };
    if (trade.status === "CLOSED") continue;
    if (trade.status !== "OPEN" || !Number.isFinite(trade.shares) || trade.shares < 0)
      return { ...context, issue: "전략 보유 자료 미확인" };
    if (trade.shares === 0) continue;
    if (
      !trade.symbol ||
      symbols.has(trade.symbol) ||
      !date(trade.entryDate) ||
      trade.entryDate > context.asOfDate ||
      trade.exitDate
    )
      return { ...context, issue: "전략 보유 자료 미확인" };
    if (!knownSector(trade.sectorCode)) return { ...context, issue: "전략 보유 섹터 미확인" };
    symbols.add(trade.symbol);
    counts.set(trade.sectorCode, (counts.get(trade.sectorCode) ?? 0) + 1);
  }
  const timestamp = (value: unknown): number | null =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    date(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
      ? Date.parse(value)
      : null;
  const calculatedAt = timestamp(strategy.calculatedAt);
  const signalCreatedAt = timestamp(screeningCreatedAt);
  // A same-day re-screen can change holdings without changing the trading date.
  // Conservative generation check only; timestamps do not prove atomic input identity.
  const issue =
    calculatedAt === null || signalCreatedAt === null
      ? "신호·장부 생성시각 미확인"
      : calculatedAt < signalCreatedAt
        ? "최신 신호보다 이전 전략 장부"
        : null;
  return { ...context, counts, issue };
}

export function dashboardSectorLimit(
  row: { market: string; date: string; sectorCode?: string | undefined },
  context: DashboardSectorContext | null,
): DashboardSectorLimit | undefined {
  if (row.market !== "KOSPI" && row.market !== "KOSDAQ") return undefined;
  // Deliberately ignore persisted settings.sectorCap: entry rules use STRATEGY_CONFIG.
  const cap = STRATEGY_CONFIG[row.market].sectorCap;
  const maxPositions = context?.maxPositions ?? null;
  const limit = maxPositions === null ? null : Math.max(1, Math.floor(maxPositions * cap + 1e-9));
  const sectorKnown = knownSector(row.sectorCode);
  const count =
    knownSector(row.sectorCode) && context?.counts
      ? (context.counts.get(row.sectorCode) ?? 0)
      : null;
  const issue =
    context?.issue ??
    (!context ? "전략 장부 미수신" : null) ??
    (!sectorKnown ? "종목 섹터 미확인" : null) ??
    (!date(row.date) || context?.asOfDate !== row.date ? "신호·장부 기준일 불일치" : null) ??
    (count === null || limit === null ? "전략 장부 자료 미확인" : null);
  return {
    status:
      issue || count === null || limit === null ? "unknown" : count >= limit ? "blocked" : "room",
    count,
    limit,
    cap,
    maxPositions,
    asOfDate: context?.asOfDate ?? null,
    issue,
  };
}
