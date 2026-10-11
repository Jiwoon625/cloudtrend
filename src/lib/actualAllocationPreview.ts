import { compareDashboardCandidates, type DashboardSignal } from "./dashboardOperations";
import { decimal, format } from "./ledger/decimal";
import {
  operatingBudgetQuantity,
  type projectOperatingAvailability,
  type OperatingCurrency,
  type OperatingMarket,
  type OperatingSignalBudget,
} from "./operatingAllocation";

export interface ActualBudgetCandidate {
  signal: DashboardSignal;
  budget: OperatingSignalBudget | null;
  /** Only actual holdings/confirmed pending orders may occupy these limits. */
  limitStatus: "ROOM" | "BLOCKED" | "UNKNOWN";
  limitReason?: string;
  sectorKey?: string;
  sectorRemaining?: number;
}
export interface ActualAllocationPreviewRow {
  symbol: string;
  market: DashboardSignal["market"];
  signalOriginDate: string | null;
  status: "ESTIMATED" | "WAITING" | "SKIPPED";
  reason: string;
  budget: string | null;
  quantity: string | null;
  cashRequired: string | null;
}
const assetFor = (market: DashboardSignal["market"]): OperatingMarket =>
  market === "US" ? "US" : market === "ETF" ? "ETF" : "KR";

/** Use only validated, reservation-netted claims for a ledger-based estimate.
 * Unassigned cash and unreconciled/unknown pools must never fund a candidate.
 * This does not promote estimated cash to broker-confirmed availability.
 */
export function currencyCashForEstimate(
  availability: ReturnType<typeof projectOperatingAvailability>,
  currency: OperatingCurrency,
): string | null {
  if (availability.status === "CONFIRMED_CASH") return availability.spendableAvailable;
  if (availability.status !== "ESTIMATED_CASH") return null;
  const assets = currency === "KRW" ? (["KR", "ETF"] as const) : (["US"] as const);
  let total = 0n;
  for (const asset of assets) {
    const cash = availability.available[asset];
    if (cash === null) return null;
    total += decimal(cash);
  }
  return format(total);
}

/** A deterministic batch over already-ranked actual candidates. It never creates orders.
 * Market claims and the shared currency pool are both reduced once per preview fill.
 */
export function previewActualAllocationBatch(input: {
  candidates: ActualBudgetCandidate[];
  marketCash: Record<OperatingMarket, string | null>;
  currencyCash: Record<OperatingCurrency, string | null>;
  remainingSlots: Record<OperatingMarket, number | null>;
}): ActualAllocationPreviewRow[] {
  const marketCash = { ...input.marketCash };
  const currencyCash = { ...input.currencyCash };
  const slots = { ...input.remainingSlots };
  const sectorUsed = new Map<string, number>();
  return [...input.candidates]
    .sort((a, b) => compareDashboardCandidates(a.signal, b.signal))
    .map(({ signal, budget, limitStatus, limitReason, sectorKey, sectorRemaining }) => {
      const asset = assetFor(signal.market),
        currency = asset === "US" ? "USD" : "KRW";
      const base = {
        symbol: signal.symbol,
        market: signal.market,
        signalOriginDate: signal.signalOriginDate ?? null,
        budget: budget?.amount ?? null,
        quantity: null,
        cashRequired: null,
      };
      if (signal.actualState !== "READY")
        return { ...base, status: "WAITING", reason: "실제 미보유 신규 후보 확인 필요" };
      if (limitStatus !== "ROOM")
        return {
          ...base,
          status: limitStatus === "BLOCKED" ? "SKIPPED" : "WAITING",
          reason: limitReason ?? "실제 슬롯·섹터 한도 확인",
        };
      const slotsLeft = slots[asset];
      if (slotsLeft === null || !Number.isSafeInteger(slotsLeft) || slotsLeft < 0)
        return { ...base, status: "WAITING", reason: "실제 잔여 슬롯 미확인" };
      if (slotsLeft === 0) return { ...base, status: "SKIPPED", reason: "실제 최대 종목 수 도달" };
      if (asset === "KR") {
        if (
          !sectorKey ||
          sectorRemaining === undefined ||
          !Number.isSafeInteger(sectorRemaining) ||
          sectorRemaining < 0
        )
          return { ...base, status: "WAITING", reason: "실제 섹터 잔여 한도 미확인" };
        if ((sectorUsed.get(sectorKey) ?? 0) >= sectorRemaining)
          return { ...base, status: "SKIPPED", reason: "동시 후보를 포함한 섹터 한도 도달" };
      }
      if (
        !budget ||
        budget.market !== asset ||
        budget.currency !== currency ||
        budget.signalDate !== signal.signalOriginDate
      )
        return { ...base, status: "WAITING", reason: "해당 원신호의 고정 매수예산 확인 필요" };
      if (signal.price === null || !Number.isFinite(signal.price) || signal.price <= 0)
        return { ...base, status: "WAITING", reason: "현재 가격 미확인" };
      const estimate = operatingBudgetQuantity({
        budget,
        price: String(signal.price),
        marketCash: marketCash[asset],
        currencyCash: currencyCash[currency],
      });
      if (estimate.status === "BLOCKED")
        return { ...base, status: "WAITING", reason: "기록상 현금과 시장 귀속 확인 필요" };
      if (estimate.quantity === "0")
        return { ...base, status: "SKIPPED", reason: "비용 포함 1주 매수금액 부족" };
      slots[asset] = slotsLeft - 1;
      if (asset === "KR" && sectorKey)
        sectorUsed.set(sectorKey, (sectorUsed.get(sectorKey) ?? 0) + 1);
      marketCash[asset] = format(decimal(marketCash[asset]!) - decimal(estimate.cashRequired!));
      currencyCash[currency] = format(
        decimal(currencyCash[currency]!) - decimal(estimate.cashRequired!),
      );
      return {
        ...base,
        status: "ESTIMATED",
        reason:
          "기록상 가용 현금·현재 종가 기준 예상 · 실제 체결가·주문가능 현금은 증권사에서 최종 확인",
        quantity: estimate.quantity,
        cashRequired: estimate.cashRequired,
      };
    });
}

const unknownActualSectors = new Set([
  "",
  "-",
  "ETC",
  "기타",
  "미분류",
  "OTHER",
  "UNKNOWN",
  "N/A",
  "NA",
]);
export const isKnownActualSector = (value: string | null | undefined): value is string =>
  typeof value === "string" && !unknownActualSectors.has(value.trim().toUpperCase());

/** Actual holdings plus uniquely identified pending symbols share slots; partial fills count once. */
export function actualAllocationLimits(input: {
  positions: Array<{ market: DashboardSignal["market"]; symbol: string }>;
  rows: Array<{ market: string; symbol: string; sectorCode?: string | null | undefined }>;
  reservations: Array<import("./operatingAllocation").OperatingReservation>;
}) {
  const slots = { KR: 30, ETF: 10, US: 20 };
  const sectors = new Map<string, number>();
  const occupied = new Set<string>();
  const reserved = new Set<string>();
  const unknown = new Set<OperatingMarket>();
  let sectorsKnown = true;
  function occupy(
    venue: DashboardSignal["market"],
    symbol: string,
    sector: string | null | undefined,
  ) {
    const key = `${venue}:${symbol}`;
    if (occupied.has(key)) return;
    occupied.add(key);
    const asset = assetFor(venue);
    slots[asset] = Math.max(0, slots[asset] - 1);
    if (asset === "KR") {
      if (!isKnownActualSector(sector)) sectorsKnown = false;
      else sectors.set(sector, (sectors.get(sector) ?? 0) + 1);
    }
  }
  for (const p of input.positions)
    occupy(
      p.market,
      p.symbol,
      input.rows.find((r) => r.market === p.market && r.symbol === p.symbol)?.sectorCode,
    );
  for (const r of input.reservations) {
    if (!r.security) {
      unknown.add(r.market);
      if (r.market === "KR") sectorsKnown = false;
      continue;
    }
    reserved.add(`${r.security.venue}:${r.security.symbol}`);
    if (r.market === "KR") {
      const currentRow = input.rows.find(
        (row) => row.market === r.security!.venue && row.symbol === r.security!.symbol,
      );
      if (
        !currentRow ||
        !isKnownActualSector(currentRow.sectorCode) ||
        currentRow.sectorCode !== r.security.sectorCode
      ) {
        sectorsKnown = false;
        unknown.add("KR");
      }
    }
    occupy(r.security.venue, r.security.symbol, r.security.sectorCode);
  }
  return { slots, sectors, sectorsKnown, reserved, unknown };
}
