import { expect, it } from "vitest";
import {
  membershipImpactAudit,
  syntheticMembershipComparison,
} from "./audit-verified-index-membership";
import { preservePreAdoptionSnapshot, buildSnapshot } from "../src/lib/screeningSnapshot";

it("changes only priority membership in synthetic full analysis, retaining technical 10-point and Onset/exit signals", () => {
  const report = membershipImpactAudit();
  expect(report.codeOnlyScope.codes).toBe(627);
  expect(report.syntheticAnalysis.changedTechnicalOrSignals).toBe(0);
  expect(report.syntheticAnalysis.losesTwoPoints).toBeGreaterThan(0);
  expect(report.syntheticAnalysis.unchangedPriority).toBeGreaterThan(0);
  expect(report.syntheticAnalysis.deltas.every((row) => row.delta === 0 || row.delta === -2)).toBe(
    true,
  );
  expect(report.syntheticAnalysis.priorityOnlyOrderMovedPositions).toBeGreaterThan(0);
});

it("does not replace a stored pre-adoption day snapshot when current reference changes the priority", () => {
  const result = syntheticMembershipComparison();
  const stored = { ...buildSnapshot(result.before), asOfDate: "2026-10-01", date: "2026-10-01" },
    fresh = { ...buildSnapshot(result.after), asOfDate: "2026-10-01", date: "2026-10-01" };
  expect(stored.entries.map((row) => row.priorityPoints)).not.toEqual(
    fresh.entries.map((row) => row.priorityPoints),
  );
  expect(preservePreAdoptionSnapshot(fresh, stored)).toBe(stored);
});
