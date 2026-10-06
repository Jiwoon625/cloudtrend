function usMarketDate(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) throw new Error("Explicit US decision timestamp required");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}

export type UsDecisionEvidence = "CURRENT_ATTEMPT" | "LOCKED_SAME_SESSION_MANIFEST";

/**
 * A late retry may recover the original decision clock only from an immutable manifest
 * that was itself written after the source became available and during the same US session.
 * This preserves the no-retrospective-trades guard instead of weakening it.
 */
export function resolveUsProspectiveDecisionAt(input: {
  analysisDate: string;
  availableAt: string;
  attemptedAt: string;
  lockedManifestLastModified?: string | null;
}): { decisionAt: string; evidence: UsDecisionEvidence } {
  const availableMs = Date.parse(input.availableAt);
  const attemptedMs = Date.parse(input.attemptedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.analysisDate))
    throw new Error("US analysis date is invalid");
  if (!Number.isFinite(availableMs) || !Number.isFinite(attemptedMs))
    throw new Error("US recovery timestamps are invalid");
  if (usMarketDate(input.availableAt) !== input.analysisDate)
    throw new Error("US source availability does not belong to the analysis session");

  if (attemptedMs >= availableMs && usMarketDate(input.attemptedAt) === input.analysisDate)
    return { decisionAt: input.attemptedAt, evidence: "CURRENT_ATTEMPT" };

  const locked = input.lockedManifestLastModified;
  if (!locked)
    throw new Error("Late US recovery requires an immutable same-session manifest timestamp");
  const lockedMs = Date.parse(locked);
  if (
    !Number.isFinite(lockedMs) ||
    lockedMs < availableMs ||
    usMarketDate(locked) !== input.analysisDate
  )
    throw new Error("Locked US manifest cannot prove a same-session decision");
  return { decisionAt: locked, evidence: "LOCKED_SAME_SESSION_MANIFEST" };
}
