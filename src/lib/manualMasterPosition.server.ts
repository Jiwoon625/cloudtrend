import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManualMaster } from "./manualMaster.server";
import { masterPositionProjection, type MasterSnapshot } from "./manualMaster";
import { activeEntryDecisions, type EntryDecision } from "./actualEntryDecisions";
import { loadActualEntryDecisions } from "./actualEntryDecisions.server";
import type { DomesticPositionContext } from "./positionSignalContext";
import { projection } from "./dashboardOperations.server";

export function projectMasterPositionContext(
  snapshot: MasterSnapshot | null,
  entries: EntryDecision[] | null,
  dates: readonly string[],
): DomesticPositionContext {
  if (!snapshot || snapshot.reviewStatus !== "confirmed")
    throw new Error("종목마스터 미등록 또는 검토 대기");
  if (!dates.length || dates.some((date) => date > snapshot.asOf))
    throw new Error("종목마스터 기준일 확인 필요");
  const { positions, recentSells } = masterPositionProjection(snapshot.rows);
  return {
    masterRevision: snapshot.revision,
    masterAsOf: snapshot.asOf,
    heldSymbols: [...new Set(positions.map((p) => p.symbol))].sort(),
    lastSellDateBySymbol: Object.fromEntries(recentSells.map((p) => [p.symbol, p.date])),
    actualEntryDecisions: entries,
    priceExits: Object.fromEntries(
      positions
        .filter((p) => p.market === "KOSPI" || p.market === "ETF")
        .map((p) => [
          p.symbol,
          {
            status: "K4/E4 보유 원가·고점 근거 확인 대기",
            reason: null,
            signalDate: null,
            threshold: null,
            auditStatus: "PENDING" as const,
          },
        ]),
    ),
  };
}

/** Read only; do not silently substitute a ledger, cached holdings, or zero holdings. */
export async function loadMasterPositionContext(client: SupabaseClient, uid: string) {
  const [snapshot, kr, us, entries] = await Promise.all([
    loadManualMaster(client, uid),
    projection(client, uid, "kr").catch(() => null),
    projection(client, uid, "us").catch(() => null),
    loadActualEntryDecisions(client, uid).then(activeEntryDecisions).catch(() => null),
  ]);
  if (!kr || !us) throw new Error("스크리닝 기준일 확인 필요");
  const after = await loadManualMaster(client, uid);
  if (!snapshot || after?.revision !== snapshot.revision)
    throw new Error("종목마스터 변경 · 다시 조회하세요.");
  return projectMasterPositionContext(snapshot, entries, [kr.date, us.date]);
}
