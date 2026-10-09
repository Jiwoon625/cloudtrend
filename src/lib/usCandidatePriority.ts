/** Display the same signal-time priority used to allocate US model entries. */
export interface UsCandidatePriority {
  symbol: string;
  coreRank: number | null;
  betaRank: number | null;
  tkRank: number | null;
  relvolRank: number | null;
}
export function compareUsCandidates(
  a: UsCandidatePriority,
  b: UsCandidatePriority,
  balanced = false,
) {
  return (
    (b.coreRank ?? -1) - (a.coreRank ?? -1) ||
    (b.betaRank ?? -1) - (a.betaRank ?? -1) ||
    ((balanced ? b.relvolRank : b.tkRank) ?? -1) - ((balanced ? a.relvolRank : a.tkRank) ?? -1) ||
    a.symbol.localeCompare(b.symbol)
  );
}
