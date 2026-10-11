import type { DashboardIndex, DashboardMarketSignals } from "./dashboardOperations";
import type { loadActualPositionSnapshotForOwner } from "./websitePositionContext.server";
import {
  readOperatingAllocation,
  prepareOperatingSignalBudget,
  prepareEtfSignalBudget,
  type OperatingSignalBudget,
} from "./operatingAllocation";
import {
  projectOperatingAllocationResponse,
  type OperatingAllocationSourceRow,
} from "./operatingAllocation.server";
import { buildOperatingEtfSizingSnapshot } from "./operatingEtfSizing.server";
import {
  previewActualAllocationBatch,
  currencyCashForEstimate,
  actualAllocationLimits,
  isKnownActualSector,
  type ActualBudgetCandidate,
} from "./actualAllocationPreview";
import { hashSeriesValue } from "./ledger/modelSeries";
import { representedLegacyNumber } from "./ledger/decimal";
export async function projectDashboardActualAllocation(input: {
  actual: Awaited<ReturnType<typeof loadActualPositionSnapshotForOwner>>;
  kr: DashboardIndex | null;
  us: DashboardIndex | null;
  markets: DashboardMarketSignals[];
  now?: string;
  /** Reservation writes retain the existing broker-confirmed cash gate. */
  requireConfirmedCash?: boolean;
}) {
  const now = input.now ?? new Date().toISOString();
  const domestic = input.actual.domestic as OperatingAllocationSourceRow | null,
    us = input.actual.us as OperatingAllocationSourceRow | null;
  const plan = readOperatingAllocation(domestic?.payload.operatingAllocation);
  const pools = {
    KRW: projectOperatingAllocationResponse(domestic, plan, "KRW", now),
    USD: projectOperatingAllocationResponse(us, plan, "USD", now),
  };
  const positions = input.actual.context.positions;
  const limits = actualAllocationLimits({
    positions,
    rows: input.kr?.rows.filter((r) => r.date === input.kr?.date) ?? [],
    reservations: Object.values(pools).flatMap((p) => p.authority?.reservations ?? []),
  });
  const {
    slots,
    sectors: sectorCounts,
    sectorsKnown,
    reserved: reservationKeys,
    unknown: pendingUnknown,
  } = limits;
  const candidates: ActualBudgetCandidate[] = [];
  const warnings: string[] = [];
  for (const group of input.markets)
    for (const signal of group.onsets) {
      const asset = signal.market === "US" ? "US" : signal.market === "ETF" ? "ETF" : "KR",
        currency = asset === "US" ? "USD" : "KRW";
      const pool = pools[currency],
        index = asset === "US" ? input.us : input.kr;
      const row = index?.rows.find(
        (r) => r.symbol === signal.symbol && r.market === signal.market && r.date === index.date,
      );
      const id = `actual-s06-20261012-v1:${signal.market}:${signal.symbol}:${signal.signalOriginDate}`;
      let budget: OperatingSignalBudget | null =
        pool.sizing.signalBudgets.find((b) => b.id === id) ?? null;
      if (!budget && plan && row && signal.signalOriginDate && index) {
        const decisionDate =
          signal.market === "KOSPI"
            ? row.kospiEntry?.confirmationDate
            : asset === "ETF"
              ? row.etfEntry?.confirmationDate
              : signal.signalOriginDate;
        try {
          if (!decisionDate) throw new Error("예산 확정일 미확인");
          const sourceFingerprint = await hashSeriesValue({ sourceDate: index.date, row });
          if (asset === "ETF") {
            if (!domestic || row.etfEntry?.entryWeight == null)
              throw new Error("ETF 평가 근거 미확인");
            const snapshot = await buildOperatingEtfSizingSnapshot({
              document: domestic.payload,
              index,
              decisionDate,
            });
            budget = prepareEtfSignalBudget({
              id,
              snapshot,
              signalDate: signal.signalOriginDate,
              decisionDate,
              etfWeight: representedLegacyNumber(row.etfEntry.entryWeight),
              sourceFingerprint,
            });
          } else {
            const snapshot = pool.sizing.annualSnapshots.find(
              (s) => s.market === asset && s.year === Number(decisionDate.slice(0, 4)),
            );
            if (!snapshot) throw new Error("해당 연도 시장 예산 미확정");
            budget = prepareOperatingSignalBudget({
              id,
              snapshot,
              signalDate: signal.signalOriginDate,
              decisionDate,
              sourceFingerprint,
            });
          }
        } catch {
          warnings.push(`${signal.symbol}: 기준일의 시장 예산·평가 근거 확인 필요`);
        }
      }
      const sector = signal.sectorCode,
        known = isKnownActualSector(sector);
      const sectorRemaining =
        asset === "KR" && known && sectorsKnown
          ? Math.max(0, (signal.market === "KOSPI" ? 3 : 6) - (sectorCounts.get(sector!) ?? 0))
          : undefined;
      // Confirmed pending reservations also occupy slots. Their provenance is required
      // before a fresh candidate can be represented as executable.
      const pendingKnown = !pendingUnknown.has(asset);
      const alreadyReserved = reservationKeys.has(`${signal.market}:${signal.symbol}`);
      candidates.push({
        signal,
        budget,
        limitStatus: alreadyReserved
          ? "BLOCKED"
          : pendingKnown && (asset !== "KR" || sectorRemaining !== undefined)
            ? "ROOM"
            : "UNKNOWN",
        ...(alreadyReserved
          ? { limitReason: "기존 미체결 예약 있음 · 중복 매수예산 배정 안 함" }
          : {}),
        ...(sector && sectorRemaining !== undefined ? { sectorKey: sector, sectorRemaining } : {}),
      });
    }
  const previews = previewActualAllocationBatch({
    candidates,
    remainingSlots: slots,
    marketCash: {
      KR: pools.KRW.availability.available.KR,
      ETF: pools.KRW.availability.available.ETF,
      US: pools.USD.availability.available.US,
    },
    currencyCash: {
      KRW: input.requireConfirmedCash
        ? pools.KRW.availability.spendableAvailable
        : currencyCashForEstimate(pools.KRW.availability, "KRW"),
      USD: input.requireConfirmedCash
        ? pools.USD.availability.spendableAvailable
        : currencyCashForEstimate(pools.USD.availability, "USD"),
    },
  });
  return {
    plan,
    previews,
    sectorContext: {
      counts: sectorsKnown ? Object.fromEntries(sectorCounts) : null,
      maxPositions: 30,
      asOfDate: input.kr?.date ?? null,
    },
    warnings,
    funding: { KRW: pools.KRW.availability.status, USD: pools.USD.availability.status },
  };
}
