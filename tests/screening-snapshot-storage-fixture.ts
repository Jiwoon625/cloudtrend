import type { ScreeningSnapshot, SnapshotEntry } from "../src/lib/screeningSnapshot";
import { KOSPI_ENTRY_POLICY } from "../src/lib/engine/kospiEntryConfirmation";

/** Synthetic production-scale data only; no private symbols, names, prices, or saved snapshots. */
export function largeScreeningSnapshot(): ScreeningSnapshot {
  const entries = Array.from({ length: 1785 }, (_, index): SnapshotEntry => {
    const etf = index >= 614;
    return {
      symbol: `SYN${String(index).padStart(6, "0")}`,
      name: `합성 검증 종목 ${index}`,
      instrumentType: etf ? "ETF" : "STOCK",
      sectorCode: `SYN_SECTOR_${index % 10}`,
      sectorName: `합성 업종 ${index % 10}`,
      grade: "N",
      status: etf
        ? "ETF KRX 배치 자료 보완 대기 · 시가총액과 거래대금 확인 전 신규 진입 판단 보류"
        : "현재 시가총액 자료 대기 · 계산 가능한 기술점수와 보유 청산 점검은 유지",
      totalScore: (index % 21) * 5,
      scoreDelta1d: index % 3 === 0 ? null : 5,
      technicalPoints: (index % 21) / 2,
      priorityPoints: index % 5,
      hardFilterPassed: false,
      hardFilterStatus: etf ? "FAIL" : "PENDING",
      pendingRules: etf
        ? ["ETF KRX 기준일 시가총액 자료 보완 대기", "ETF KRX 기준일 거래대금 배치 자료 보완 대기"]
        : ["현재 시가총액 자료 대기"],
      kosdaq80Onset: false,
      kospiEightPointEntry: false,
      kospi80Onset: false,
      operationalSignalVersion: KOSPI_ENTRY_POLICY.version,
      ...(index % 3 === 0 ? { exitSignal: null } : {}),
      ...(!etf
        ? {
            kospiEntry: {
              version: KOSPI_ENTRY_POLICY.version,
              state: "unobservable" as const,
              date: "2026-10-07",
              originDate: null,
              confirmationDate: null,
              eligible: false,
              score: (index % 21) / 2,
              originScore: null,
              rsAccel: null,
              issues: ["현재 시가총액 자료 대기"],
            },
          }
        : {}),
    };
  });
  return {
    date: "2026-10-07",
    asOfDate: "2026-10-07",
    savedAt: "2026-10-07T13:00:00Z",
    sourceRegisteredAt: "2026-10-07T12:50:00Z",
    marketGateStatus: "NEUTRAL",
    totalCount: entries.length,
    passedCount: 0,
    gradeACount: 0,
    gradeBCount: 0,
    entries,
    topStocks: entries.slice(0, 50),
    topEtfs: entries.slice(614, 664),
  };
}
