import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManualMaster } from "./manualMaster.server";
import { masterPositionProjection, type MasterSnapshot } from "./manualMaster";
import { activeEntryDecisions, type EntryDecision } from "./actualEntryDecisions";
import { loadActualEntryDecisions } from "./actualEntryDecisions.server";
import type { DomesticPositionContext } from "./positionSignalContext";
import { projection } from "./dashboardOperations.server";
import { loadMasterPriceExits } from "./manualMasterPriceExit.server";

export function projectMasterPositionContext(
  snapshot: MasterSnapshot | null,
  entries: EntryDecision[] | null,
): DomesticPositionContext {
  if (!snapshot || snapshot.reviewStatus !== "confirmed")
    throw new Error("종목마스터 미등록 또는 검토 대기");
  const { positions, recentSells } = masterPositionProjection(snapshot.rows);
  const symbols = snapshot.rows.map((r) => r.symbol);
  if (new Set(symbols).size !== symbols.length)
    throw new Error("시장 간 동일 종목코드 · 상세 보유 조회 확인 필요");
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

/** Read holdings without a ledger fallback; only derived exit evidence may be persisted. */
export async function loadMasterPositionContext(client: SupabaseClient, uid: string) {
  const [snapshot, entries] = await Promise.all([
    loadManualMaster(client, uid),
    loadActualEntryDecisions(client, uid)
      .then(activeEntryDecisions)
      .catch(() => null),
  ]);
  const after = await loadManualMaster(client, uid);
  if (!snapshot || after?.revision !== snapshot.revision)
    throw new Error("종목마스터 변경 · 다시 조회하세요.");
  const context = projectMasterPositionContext(snapshot, entries);
  const kr = await projection(client, uid, "kr").catch(() => null);
  const priceExits = await loadMasterPriceExits(client, uid, snapshot, kr);
  const final = await loadManualMaster(client, uid);
  if (final?.revision !== snapshot.revision) throw new Error("종목마스터 변경 · 다시 조회하세요.");
  return { ...context, priceExits: { ...context.priceExits, ...priceExits } };
}
