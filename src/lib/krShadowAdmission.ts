import { isKrOfficialShadowDecision, nextKrRegularSession } from "./ledger/krShadowDecision";

/**
 * Admission for newly collected live KR input, not historical model replay.
 * KRX's next-session refresh starts at 08:00 KST; a delayed evening upload
 * after midnight is still preview-only, even if calculation finishes later.
 * Keep the frozen model evaluator unchanged so completed history is not reinterpreted.
 * Pass actual collection/decision timestamps, never synthesized replay clocks.
 */
export function isKrLiveShadowDecision(
  sessionDate: string,
  sourceCollectedAt: string,
  decisionAt: string,
): boolean {
  if (!isKrOfficialShadowDecision(sessionDate, sourceCollectedAt, decisionAt)) return false;
  const next = nextKrRegularSession(sessionDate);
  return next !== null && Date.parse(sourceCollectedAt) >= Date.parse(`${next}T08:00:00+09:00`);
}
