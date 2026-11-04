import type { ScreeningSnapshot } from "./screeningSnapshot";
export const SIGNAL_JOURNAL_START = "2026-11-04";
export interface SignalRule {
  version: 1;
  id: string;
  codeHash: string;
  strategyVersion: string;
  config: unknown;
  effectiveFrom: string;
  registeredAt: string;
  sourceCommit?: string;
}
export interface SignalEvidence {
  version: 1;
  rule: SignalRule;
  sourceHash: string;
  kind: "OBSERVED" | "RECONSTRUCTED";
  recordedAt: string;
  /** Reconstruction uses later source vintages, never a claim about historical availability. */
  availability: "RECORDED_SOURCE" | "LATER_SOURCE_VINTAGE";
  issues: string[];
}
export type SignalSnapshot = ScreeningSnapshot & { signalJournal: SignalEvidence };
export function ruleAt(rules: SignalRule[], date: string): SignalRule | undefined {
  return rules
    .filter((r) => r.effectiveFrom <= date)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.registeredAt.localeCompare(a.registeredAt),
    )[0];
}
