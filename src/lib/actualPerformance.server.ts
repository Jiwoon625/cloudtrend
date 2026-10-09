import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActualExecution, LedgerDocument } from "./portfolioLedgers";
import type { UsActualDocument } from "./usActualLedger";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import { decimal, fromLegacyNumber, representedLegacyNumber } from "./ledger/decimal";
import { canonicalJson } from "./ledger/migration";
import {
  actualPerformanceView,
  appendActualPerformanceObservation,
  confirmActualPerformanceBaseline,
  reconciliationDate,
  pendingActualPerformance,
  type ActualPerformanceSeries,
  type PerformanceBaseline,
  type PerformanceObservation,
} from "./ledger/actualPerformance";

export type ActualPerformanceDocument = LedgerDocument & {
  /** Newly allocated actual capital only; legacy holdings and unallocated shared cash stay outside. */
  actualPerformance?: ActualPerformanceSeries;
};
export type ReviewedPerformanceWrite = {
  expectedRevision: number;
} & (
  | { action: "confirmBaseline"; baseline: PerformanceBaseline }
  | { action: "appendObservation"; observation: PerformanceObservation }
);

/** Verify allocations against existing owner-scoped fills. Never create or change an actual fill. */
export function validateAllocatedExecutions(
  series: ActualPerformanceSeries,
  domestic: LedgerDocument,
  us: UsActualDocument | null,
) {
  for (const observation of series.observations) {
    for (const allocation of observation.tradeAllocations) {
      const document = allocation.sourceSystem === "portfolio_ledgers" ? domestic : us;
      const matches = document?.executions.filter((e) => e.id === allocation.executionId) ?? [];
      if (matches.length !== 1)
        throw new Error(
          "Allocated actual execution is missing or ambiguous; reconcile the original journal",
        );
      const execution = matches[0]! as ActualExecution<string>;
      const executionCurrency = execution.market === "US" ? "USD" : "KRW";
      if (
        !["KOSPI", "KOSDAQ", "ETF", "US"].includes(execution.market) ||
        (allocation.sourceSystem === "us_actual_portfolio_ledgers") !==
          (execution.market === "US") ||
        execution.date < series.startDate ||
        execution.date !== allocation.date ||
        execution.order !== allocation.order ||
        execution.side !== allocation.side ||
        `${execution.market}:${execution.symbol}` !== allocation.securityId ||
        executionCurrency !== allocation.currency ||
        decimal(representedLegacyNumber(execution.price)) !== decimal(allocation.price)
      )
        throw new Error(
          "Allocated execution facts differ from the original post-start actual fill",
        );
      const quantity = decimal(allocation.quantity),
        total = decimal(fromLegacyNumber(execution.shares));
      const fee = decimal(allocation.fee),
        originalFee = decimal(representedLegacyNumber(execution.fee));
      const gross = decimal(allocation.gross),
        originalGross = decimal(representedLegacyNumber(execution.price * execution.shares));
      if (
        quantity <= 0n ||
        quantity % decimal("1") !== 0n ||
        quantity > total ||
        gross <= 0n ||
        gross > originalGross ||
        (quantity === total && gross !== originalGross) ||
        fee < 0n ||
        fee > originalFee ||
        (quantity === total && fee !== originalFee)
      )
        throw new Error(
          "Allocated execution quantity, gross or reviewed fee exceeds or contradicts the original fill",
        );
    }
  }
}

/** Shared read-only validation for preview and the reviewed metadata writer. */
async function prepareReviewedActualPerformance(
  client: SupabaseClient,
  userId: string,
  input: ReviewedPerformanceWrite,
  now = new Date().toISOString(),
) {
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid recording time");
  now = new Date(now).toISOString();
  if (!["confirmBaseline", "appendObservation"].includes(input.action))
    throw new Error("Unsupported reviewed performance action");
  const row = await readWebsiteDocument<ActualPerformanceDocument>(
    client,
    userId,
    "portfolio_ledgers",
  );
  if (!row)
    throw new Error("Reconcile the existing actual ledger before setting a performance baseline");
  if (!Number.isSafeInteger(input.expectedRevision) || row.revision !== input.expectedRevision)
    throw new Error("Actual ledger revision changed; re-read and reconcile before retrying");
  const us = await readWebsiteDocument<UsActualDocument>(
    client,
    userId,
    "us_actual_portfolio_ledgers",
  );
  const previous = row.payload.actualPerformance ?? pendingActualPerformance();
  let next: ActualPerformanceSeries;
  if (input.action === "confirmBaseline") {
    if (!previous.baseline) {
      if (
        !us ||
        input.baseline.sourceRevisions.domestic !== row.revision ||
        input.baseline.sourceRevisions.us !== us.revision
      )
        throw new Error("Baseline source revisions no longer match the reconciled KR/US ledgers");
    }
    if (
      input.baseline.betaArchive.asOfDate > reconciliationDate(now) ||
      Date.parse(input.baseline.confirmedAt) > Date.parse(now) ||
      Date.parse(input.baseline.valuation.recordedAt) > Date.parse(now)
    )
      throw new Error("Future reconciliation evidence cannot confirm a baseline");
    next = confirmActualPerformanceBaseline(previous, input.baseline);
  } else {
    if (
      input.observation.valuation.date > now.slice(0, 10) ||
      Date.parse(input.observation.valuation.recordedAt) > Date.parse(now)
    )
      throw new Error("Cannot record future observed performance");
    next = appendActualPerformanceObservation(previous, input.observation);
  }
  validateAllocatedExecutions(next, row.payload, us?.payload ?? null);
  const view = actualPerformanceView(next);
  if (
    input.action === "appendObservation" &&
    view.points
      .at(-1)
      ?.issues.some(
        (issue) =>
          !["intraday_flow_timing_unverified", "return_denominator_unavailable"].includes(issue),
      )
  )
    throw new Error(
      "Reconcile missing valuation, FX, account coverage and external flows before persisting the day; nothing was frozen",
    );
  return { row, previous, next, view, now };
}

export async function previewReviewedActualPerformance(
  client: SupabaseClient,
  userId: string,
  input: ReviewedPerformanceWrite,
  now = new Date().toISOString(),
) {
  const prepared = await prepareReviewedActualPerformance(client, userId, input, now);
  return { revision: prepared.row.revision, series: prepared.next, view: prepared.view };
}

/** Changes only reviewed reporting metadata; original actual journal and cost basis stay intact. */
export async function saveReviewedActualPerformance(
  client: SupabaseClient,
  userId: string,
  input: ReviewedPerformanceWrite,
  now = new Date().toISOString(),
) {
  const {
    row,
    previous,
    next,
    view,
    now: checkedNow,
  } = await prepareReviewedActualPerformance(client, userId, input, now);
  if (canonicalJson(previous) === canonicalJson(next))
    return { revision: row.revision, series: previous, view, reused: true };
  const payload = { ...row.payload, actualPerformance: next };
  const saved = await client
    .from("portfolio_ledgers")
    .update({ payload, revision: row.revision + 1, updated_at: checkedNow })
    .eq("user_id", userId)
    .eq("revision", row.revision)
    .select("revision")
    .maybeSingle();
  if (saved.error) throw new Error(saved.error.message);
  if (!saved.data)
    throw new Error("Actual ledger changed concurrently; no performance metadata was overwritten");
  const checked = await readWebsiteDocument<ActualPerformanceDocument>(
    client,
    userId,
    "portfolio_ledgers",
  );
  if (
    !checked ||
    checked.revision !== row.revision + 1 ||
    canonicalJson(checked.payload) !== canonicalJson(payload)
  )
    throw new Error(
      "Performance write acknowledgement could not be verified; re-read before retrying",
    );
  return { revision: checked.revision, series: next, view, reused: false };
}
