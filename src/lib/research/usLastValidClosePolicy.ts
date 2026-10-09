/** Opt-in US research proxy. No corporate-event inference, market-calendar inference or settlement engine. */
import { validDate } from "../ledger/date";

export const US_LAST_VALID_CLOSE_POLICY_ID = "US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1" as const;

export interface UsResearchSessionClock {
  date: string;
  openAt: string;
  closeAvailableAt: string;
}

export interface UsLastValidClosePolicy {
  policyId: typeof US_LAST_VALID_CLOSE_POLICY_ID;
  /** Last verified source session, not the requested end of a later calendar. */
  sourceCoverageEndDate: string;
  sessionClocks: UsResearchSessionClock[];
}

export interface UsResearchCloseContext extends UsResearchSessionClock {
  policyId: typeof US_LAST_VALID_CLOSE_POLICY_ID;
  /** Asserted only after all declared source partitions and current market coverage verify. */
  marketDataComplete: true;
}

export interface UsLastValidCloseReference {
  date: string;
  availableAt: string;
  price: number;
}

export interface UsLastValidCloseState {
  policyId: typeof US_LAST_VALID_CLOSE_POLICY_ID;
  lastValidCloseBySymbol: Record<string, UsLastValidCloseReference>;
}

export function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function timestamp(value: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("Research proxy requires timezone-aware verified session clocks");
  return Date.parse(value);
}

export function validateUsResearchClock(clock: UsResearchSessionClock): void {
  if (
    !validDate(clock.date) ||
    timestamp(clock.openAt) >= timestamp(clock.closeAvailableAt) ||
    new Date(timestamp(clock.openAt)).toISOString().slice(0, 10) !== clock.date ||
    new Date(timestamp(clock.closeAvailableAt)).toISOString().slice(0, 10) !== clock.date ||
    [0, 6].includes(new Date(`${clock.date}T00:00:00Z`).getUTCDay())
  )
    throw new Error("Invalid verified US research session boundary");
}

export function validateUsLastValidClosePolicy(
  policy: UsLastValidClosePolicy,
  sessions: readonly string[],
): void {
  if (
    policy.policyId !== US_LAST_VALID_CLOSE_POLICY_ID ||
    !validDate(policy.sourceCoverageEndDate) ||
    !Array.isArray(policy.sessionClocks) ||
    policy.sessionClocks.length !== sessions.length ||
    sessions.some((date, i) => policy.sessionClocks[i]?.date !== date) ||
    !sessions.length ||
    sessions.at(-1)! > policy.sourceCoverageEndDate
  )
    throw new Error("Research proxy needs exact verified sessions within source coverage");
  policy.sessionClocks.forEach((clock, i) => {
    validateUsResearchClock(clock);
    if (i && timestamp(clock.openAt) <= timestamp(policy.sessionClocks[i - 1]!.closeAvailableAt))
      throw new Error("Research session clocks must be strictly increasing");
  });
}

export function validateUsResearchCloseContext(
  context: UsResearchCloseContext,
  date: string,
  rows: readonly { symbol: string; close: number | null }[],
): void {
  validateUsResearchClock(context);
  if (context.policyId !== US_LAST_VALID_CLOSE_POLICY_ID || context.date !== date)
    throw new Error("Research missing-close policy/session mismatch");
  if (
    context.marketDataComplete !== true ||
    !rows.some((row) => row.symbol === "SPY" && finitePositive(row.close)) ||
    !rows.some((row) => row.symbol !== "SPY" && finitePositive(row.close))
  )
    throw new Error("Incomplete market source cannot trigger research disappearance exits");
}

export function validateUsLastValidCloseReference(
  reference: UsLastValidCloseReference | undefined,
  context: UsResearchCloseContext,
): asserts reference is UsLastValidCloseReference {
  if (!reference || !validDate(reference.date) || !finitePositive(reference.price))
    throw new Error("NO_PRIOR_VALID_CLOSE_FOR_PROXY");
  if (
    reference.date > context.date ||
    timestamp(reference.availableAt) > timestamp(context.closeAvailableAt)
  )
    throw new Error("Research proxy cannot use a future reference close");
}
