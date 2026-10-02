import { z } from "zod";
import {
  estimateUsTaxOverlay,
  usTaxEvidenceSchema,
  type UsTaxOverlayResult,
} from "./engine/usCapitalGainsTax";
import type { UsActualDocument } from "./usActualLedger";
import type { UsPortfolioSnapshotRecord } from "./usProspectiveCloud";

/** Optional, separately sourced projection. Legacy execution fields cannot establish tax basis. */
export const actualTaxEvidenceSchema = z.object({
  sourceRevision: z.number().int().positive(),
  sourceExecutions: z.string(),
  evidence: usTaxEvidenceSchema,
});
export type ActualTaxEvidence = z.infer<typeof actualTaxEvidenceSchema>;
export const modelTaxSourceSchema = z.object({
  ledgerRevision: z.string().min(1),
  ledgerDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const modelTaxEvidenceSchema = z.object({
  sourceLedgerRevision: z.string().min(1),
  sourceLedgerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDate: z.string(),
  sourceRuleVersion: z.string(),
  sourceNavUsd: z.number().finite(),
  sourceCashUsd: z.number().finite(),
  initialCapitalUsd: z.number().finite().positive(),
  evidence: usTaxEvidenceSchema,
});
/** Exact canonical source comparison, not a lossy hash; no external transmission. */
export function actualTaxSourceKey(document: UsActualDocument): string {
  return JSON.stringify(
    [...document.executions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, date, order, symbol, side, shares, price, fee }) => [
        id,
        date,
        order,
        symbol,
        side,
        shares,
        price,
        fee,
      ]),
  );
}
export function actualUsTaxOverlay(input: {
  document: UsActualDocument | undefined;
  revision: number | undefined;
  navUsd: number | undefined;
  capitalUsd: number | undefined;
  asOf: string;
}): UsTaxOverlayResult {
  const parsed = actualTaxEvidenceSchema.safeParse(input.document?.taxEvidence);
  const matches =
    parsed.success &&
    parsed.data.sourceRevision === input.revision &&
    !!input.document &&
    parsed.data.sourceExecutions === actualTaxSourceKey(input.document);
  return estimateUsTaxOverlay({
    asOf: input.asOf,
    preTaxNavUsd: input.navUsd ?? null,
    initialCapitalUsd: input.capitalUsd ?? null,
    kind: "ACTUAL_OWNER",
    poolId: "ACTUAL_OWNER",
    strategyId: null,
    evidence: matches ? parsed.data.evidence : null,
  });
}
export function modelUsTaxOverlay(
  snapshot: UsPortfolioSnapshotRecord | undefined,
): UsTaxOverlayResult {
  const parsed = modelTaxEvidenceSchema.safeParse(snapshot?.state["taxEvidence"]);
  const source = modelTaxSourceSchema.safeParse(snapshot?.state["taxSource"]);
  const frozenLegacy = [
    "A0_QUARTER_PRIMARY",
    "A2_QUARTER_SHADOW",
    "B3_BETA_SHADOW",
    "SPY_BENCHMARK",
  ].includes(snapshot?.strategy_id ?? "");
  const stateCapital = snapshot?.state["initialCapital"];
  // Evidence may never redefine a pre-tax baseline. New versions require the saved model capital.
  const initialCapital = frozenLegacy
    ? 100_000
    : typeof stateCapital === "number" && Number.isFinite(stateCapital) && stateCapital > 0
      ? stateCapital
      : null;
  const matches =
    parsed.success &&
    source.success &&
    parsed.data.sourceLedgerRevision === source.data.ledgerRevision &&
    parsed.data.sourceLedgerDigest === source.data.ledgerDigest &&
    parsed.data.initialCapitalUsd === initialCapital &&
    !!snapshot &&
    parsed.data.sourceDate === snapshot.date &&
    parsed.data.sourceRuleVersion === snapshot.rule_version &&
    parsed.data.sourceNavUsd === snapshot.nav_usd &&
    parsed.data.sourceCashUsd === snapshot.cash_usd;
  const result = estimateUsTaxOverlay({
    asOf:
      snapshot?.date ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    preTaxNavUsd: snapshot?.nav_usd ?? null,
    initialCapitalUsd: initialCapital,
    kind: "COUNTERFACTUAL",
    poolId: `COUNTERFACTUAL:${snapshot?.strategy_id ?? "UNKNOWN"}`,
    strategyId: snapshot?.strategy_id ?? null,
    evidence: matches ? parsed.data.evidence : null,
  });
  const sourceMissing = snapshot?.state["taxProjectionMissing"];
  if (
    Array.isArray(sourceMissing) &&
    sourceMissing.every((v) => typeof v === "string") &&
    sourceMissing.length
  ) {
    result.missingFields = [...new Set([...sourceMissing, ...result.missingFields])];
  }
  return result;
}
