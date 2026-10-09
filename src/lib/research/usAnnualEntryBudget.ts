/** Research-only annual principal reset. Existing holdings and order budgets are not rebalanced. */
import { decimal, divide, format, representedLegacyNumber } from "../ledger/decimal";
import { validDate } from "../ledger/date";

export const US_ANNUAL_ENTRY_BUDGET_POLICY_ID = "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1" as const;

export interface UsAnnualEntryBudgetPolicy {
  policyId: typeof US_ANNUAL_ENTRY_BUDGET_POLICY_ID;
}

export interface UsAnnualEntryBudgetSnapshot {
  year: string;
  effectiveDate: string;
  sourceDate: string | null;
  basis: "INITIAL_CAPITAL" | "PREVIOUS_SESSION_CLOSE_NAV";
  /** Preserve the original previous snapshot observation alongside its decimal representation. */
  referenceNav: number;
  referenceNavUsd: string;
  entryPrincipalUsd: string;
  targetPositions: 20;
  moneyRepresentation: "SNAPSHOT_NAV_8DP_THEN_DIVIDE_20_TRUNCATE_8DP";
}

export interface UsAnnualEntryBudgetState {
  policyId: typeof US_ANNUAL_ENTRY_BUDGET_POLICY_ID;
  currentYear: string;
  byYear: Record<string, UsAnnualEntryBudgetSnapshot>;
}

export function validateUsAnnualEntryBudgetPolicy(policy: UsAnnualEntryBudgetPolicy): void {
  if (policy.policyId !== US_ANNUAL_ENTRY_BUDGET_POLICY_ID)
    throw new Error("Invalid research annual-entry-budget policy");
}

function principal(navUsd: string): string {
  return format(divide(decimal(navUsd), decimal("20")));
}

function validateSnapshot(snapshot: UsAnnualEntryBudgetSnapshot, year: string): void {
  if (
    snapshot.year !== year ||
    !/^\d{4}$/.test(year) ||
    !validDate(snapshot.effectiveDate) ||
    snapshot.effectiveDate.slice(0, 4) !== year ||
    !Number.isFinite(snapshot.referenceNav) ||
    snapshot.referenceNav < 0 ||
    snapshot.referenceNavUsd !== representedLegacyNumber(snapshot.referenceNav) ||
    snapshot.entryPrincipalUsd !== principal(snapshot.referenceNavUsd) ||
    snapshot.targetPositions !== 20 ||
    snapshot.moneyRepresentation !== "SNAPSHOT_NAV_8DP_THEN_DIVIDE_20_TRUNCATE_8DP" ||
    (snapshot.basis === "INITIAL_CAPITAL"
      ? snapshot.sourceDate !== null
      : snapshot.basis !== "PREVIOUS_SESSION_CLOSE_NAV" ||
        !snapshot.sourceDate ||
        !validDate(snapshot.sourceDate) ||
        snapshot.sourceDate >= snapshot.effectiveDate ||
        snapshot.sourceDate.slice(0, 4) >= year)
  )
    throw new Error("Research annual budget snapshot changed or has a future NAV source");
}

/** Called before reading current session prices or executing any current OPEN trade. */
export function advanceUsAnnualEntryBudget(input: {
  policy: UsAnnualEntryBudgetPolicy;
  date: string;
  initialCapitalUsd: string;
  previousState: UsAnnualEntryBudgetState | null;
  previousDate: string | null;
  previousNav: number | null;
}): UsAnnualEntryBudgetState {
  validateUsAnnualEntryBudgetPolicy(input.policy);
  if (!validDate(input.date) || decimal(input.initialCapitalUsd) <= 0n)
    throw new Error("Annual research budget requires valid date and unchanged initial capital");
  const year = input.date.slice(0, 4);
  if (!input.previousState && input.previousDate !== null)
    throw new Error("Annual entry budget cannot activate mid-series");
  const byYear = { ...input.previousState?.byYear };
  if (input.previousState) {
    if (
      input.previousState.policyId !== input.policy.policyId ||
      !input.previousDate ||
      !validDate(input.previousDate) ||
      input.previousDate >= input.date ||
      input.previousState.currentYear !== input.previousDate.slice(0, 4) ||
      !byYear[input.previousState.currentYear] ||
      Object.keys(byYear).some((recordedYear) => recordedYear > input.previousState!.currentYear)
    )
      throw new Error("Annual research budget state/date mismatch");
    for (const [recordedYear, snapshot] of Object.entries(byYear))
      validateSnapshot(snapshot, recordedYear);
    const first = byYear[Object.keys(byYear).sort()[0]!]!;
    if (first.basis !== "INITIAL_CAPITAL" || first.referenceNavUsd !== input.initialCapitalUsd)
      throw new Error("Annual research budget cannot change initial capital");
    if (input.previousState.currentYear === year)
      return { policyId: input.policy.policyId, currentYear: year, byYear };
    if (year <= input.previousState.currentYear || byYear[year])
      throw new Error("Annual research budget cannot rewrite a prior year");
  }
  const initial = !input.previousState;
  const referenceNav = initial ? Number(input.initialCapitalUsd) : input.previousNav;
  if (referenceNav === null || !Number.isFinite(referenceNav) || referenceNav < 0)
    throw new Error("Annual research budget requires the completed previous session NAV");
  const referenceNavUsd = initial ? input.initialCapitalUsd : representedLegacyNumber(referenceNav);
  const snapshot: UsAnnualEntryBudgetSnapshot = {
    year,
    effectiveDate: input.date,
    sourceDate: initial ? null : input.previousDate,
    basis: initial ? "INITIAL_CAPITAL" : "PREVIOUS_SESSION_CLOSE_NAV",
    referenceNav,
    referenceNavUsd,
    entryPrincipalUsd: principal(referenceNavUsd),
    targetPositions: 20,
    moneyRepresentation: "SNAPSHOT_NAV_8DP_THEN_DIVIDE_20_TRUNCATE_8DP",
  };
  validateSnapshot(snapshot, year);
  byYear[year] = snapshot;
  return { policyId: input.policy.policyId, currentYear: year, byYear };
}
