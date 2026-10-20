import type { ScreeningSnapshot, SnapshotEntry } from "../src/lib/screeningSnapshot";

/** Deterministic synthetic US observations with production-shaped, full per-symbol evidence. */
export function largeUsArchiveSnapshot(count = 5347): ScreeningSnapshot {
  let seed = 20261019;
  const number = (scale = 1) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.round((seed / 2 ** 32) * scale * 1e6) / 1e6;
  };
  const entries = Array.from({ length: count }, (_, index): SnapshotEntry => {
    const symbol = `SYN${index.toString().padStart(5, "0")}`;
    const name = `Synthetic Company ${index}`;
    const coreRank = number();
    const betaRank = number();
    return {
      symbol,
      name,
      market: "US",
      instrumentType: "STOCK",
      sectorCode: `SECTOR${index % 11}`,
      sectorName: `SECTOR${index % 11}`,
      grade: "",
      status: index % 13 === 0 ? "진입 준비" : "관찰",
      totalScore: coreRank,
      scoreDelta1d: null,
      technicalPoints: coreRank,
      priorityPoints: betaRank,
      hardFilterPassed: index % 3 !== 0,
      evidence: {
        date: "2026-10-19",
        symbol,
        name,
        market: index % 2 === 0 ? "NASDAQ" : "NYSE",
        sector: `SECTOR${index % 11}`,
        securityType: "COMMON_STOCK",
        status: "ACTIVE",
        currency: "USD",
        open: number(1000),
        high: number(1000),
        low: number(1000),
        close: number(1000),
        volume: Math.round(number(10_000_000)),
        dollarVolume: number(1e9),
        sharesOutstanding: Math.round(number(1e9)),
        marketCap: number(1e11),
        ret120: number(2),
        ret252: index % 17 === 0 ? null : number(3),
        beta60Spy: number(3),
        ichimokuTkGap: number(),
        relvol1_20: number(10),
        adv20Usd: number(1e8),
        amihud20: number(1e-5),
        active20: true,
        tossTradable: true,
        isCommonShare: true,
        fxUsdKrw: 1370.25,
        previousCoreRank: number(),
        previousCoreDate: "2026-10-16",
        ret120Rank: number(),
        ret252Rank: number(),
        coreScore: number(),
        coreRank,
        betaRank,
        tkRank: number(),
        relvolRank: number(),
        liquidityRank: number(),
        amihudRank: number(),
        eligibleBase: index % 3 !== 0,
        onset80: index % 13 === 0,
        aggressiveConfirm: index % 3 === 0,
        balancedConfirm: index % 4 === 0,
        a0Entry: index % 13 === 0,
        a0Exit: index % 11 === 0,
        a0BetaExit: index % 19 === 0,
        a2Entry: index % 17 === 0,
        a2Exit: index % 23 === 0,
        b3Entry: index % 29 === 0,
        b3BaseExit: index % 7 === 0,
        betaWeakStreak: index % 3,
        b3BetaExit: false,
        b3Exit: index % 7 === 0,
        primarySignal: index % 13 === 0 ? "ENTRY" : "WATCH",
        rawOnset: index % 13 === 0,
      },
    };
  });
  return {
    runId: "us-2026-10-19-sha256:synthetic",
    market: "US",
    strategyVersion: "us-prospective-1.1.0-a0-anchor",
    date: "2026-10-19",
    asOfDate: "2026-10-19",
    savedAt: "2026-10-20T00:14:00.123Z",
    sourceRegisteredAt: "2026-10-19T21:30:00Z",
    marketGateStatus: "US_A0",
    totalCount: entries.length,
    passedCount: entries.filter((entry) => entry.evidence?.["a0Entry"]).length,
    gradeACount: 0,
    gradeBCount: 0,
    entries,
  };
}
