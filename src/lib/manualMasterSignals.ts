import {
  DASHBOARD_MARKETS,
  marketSignals,
  type DashboardIndex,
  type DashboardMarket,
} from "./dashboardOperations";
import { masterPositionProjection, type MasterSnapshot } from "./manualMaster";
import { OPERATIONAL_SIGNAL_START } from "./operationalSignalStart";
import { projectActualEntryDecisions } from "./actualEntryDecisionProjection";
import type { EntryDecision } from "./actualEntryDecisions";
import { applyMasterPriceExits, type MasterExit } from "./manualMasterPriceExit";

export function projectManualMasterSignals(
  snapshot: MasterSnapshot | null,
  kr: DashboardIndex | null,
  us: DashboardIndex | null,
  entries: EntryDecision[] | null,
  priceExits: Record<string, MasterExit> = {},
) {
  const confirmed = snapshot?.reviewStatus === "confirmed" ? snapshot : null;
  const { positions, recentSells } = masterPositionProjection(confirmed?.rows ?? []);
  const sectorCounts = new Map<string, number>();
  // asOf is the last holdings change date, not a freshness deadline.
  let sectorsKnown = !!kr && !!confirmed;
  for (const p of positions) {
    if (p.market !== "KOSPI" && p.market !== "KOSDAQ") continue;
    const code = kr?.rows.find(
      (r) => r.market === p.market && r.symbol === p.symbol && r.date === kr.date,
    )?.sectorCode;
    if (!code || ["UNKNOWN", "ETC", "OTHER", "-"].includes(code)) sectorsKnown = false;
    else sectorCounts.set(code, (sectorCounts.get(code) ?? 0) + 1);
  }
  const markets = DASHBOARD_MARKETS.map((market) => {
    const index = market === "US" ? us : kr;
    const holdings = index && confirmed ? positions.filter((p) => p.market === market) : null;
    return marketSignals(
      index,
      market,
      holdings,
      [],
      {
        counts: sectorsKnown ? sectorCounts : null,
        maxPositions: 30,
        asOfDate: kr?.date ?? null,
        issue: sectorsKnown ? null : "실제 보유 섹터 미확인",
      },
      OPERATIONAL_SIGNAL_START,
      recentSells.map((r) => ({ ...r, market: r.market as DashboardMarket })),
    );
  });
  return {
    revision: snapshot?.revision ?? null,
    asOf: snapshot?.asOf ?? null,
    markets: applyMasterPriceExits(
      projectActualEntryDecisions(markets, entries),
      confirmed?.rows ?? [],
      priceExits,
    ),
    warnings: [
      "종목마스터 기준: 기존 스크리닝 조건·확인·H60·실보유·최근매도일을 결합합니다.",
      ...(!confirmed ? ["종목마스터 미확인 또는 검토 대기 · 실제 진입·청산 판단 보류"] : []),
      "K4: 현재 원화 평단가 -8%. E4: 보유시작일 이후 최고 종가 -10%. 확인된 종가 신호는 전량매도 전까지 유지합니다.",
      ...Object.values(priceExits)
        .filter((e) => e.auditStatus === "PENDING" || e.auditStatus === "MISMATCH")
        .map((e) => e.symbol + " 가격청산 근거 확인 대기"),
      "매매가 없으면 마지막 저장 보유현황을 계속 사용합니다. 종목마스터 변경일은 유효기간이 아닙니다.",
      ...(confirmed?.rows.some((r) => !r.lastSell)
        ? [
            "최근매도일 공란은 확인된 매도 이력이 없다는 의미입니다. 재진입 조건은 별도 확인이 필요합니다.",
          ]
        : []),
    ],
  };
}
