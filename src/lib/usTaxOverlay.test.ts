import { describe, expect, it } from "vitest";
import { actualTaxSourceKey, actualUsTaxOverlay, modelUsTaxOverlay } from "./usTaxOverlay";
import type { UsActualDocument } from "./usActualLedger";
import type { UsPortfolioSnapshotRecord } from "./usProspectiveCloud";
import { TAX_DATE, taxEvidence } from "../../tests/fixtures/usTaxEvidence";
const document = (): UsActualDocument => ({
  capital: 100000,
  executions: [],
  excluded: {},
  migratedAt: TAX_DATE,
});
const snapshot = (strategy = "A2_QUARTER_SHADOW"): UsPortfolioSnapshotRecord => ({
  strategy_id: strategy,
  date: TAX_DATE,
  rule_version: "frozen-rule",
  nav_usd: 103000,
  cash_usd: 1000,
  benchmark_nav: 102000,
  daily_return: 0.01,
  cumulative_return: 0.03,
  turnover: 0,
  fees_usd: 12,
  positions_count: 1,
  state: { positions: { ABC: { shares: 10, lastPrice: 20 } } },
});
describe("read-only US tax source adapters", () => {
  it("leaves legacy actual and all three legacy models unavailable rather than zero", () => {
    const r = actualUsTaxOverlay({
      document: document(),
      revision: 1,
      navUsd: 103000,
      capitalUsd: 100000,
      asOf: TAX_DATE,
    });
    expect(r.currentYearTaxKrw).toBeNull();
    for (const strategy of ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW"])
      expect(modelUsTaxOverlay(snapshot(strategy)).currentYearTaxKrw).toBeNull();
    expect(modelUsTaxOverlay(undefined).afterTaxNavUsd).toBeNull();
  });
  it("invalidates actual evidence on revision or execution correction", () => {
    const doc = document();
    doc.taxEvidence = {
      sourceRevision: 1,
      sourceExecutions: actualTaxSourceKey(doc),
      evidence: taxEvidence(),
    };
    const input = {
      document: doc,
      revision: 1,
      navUsd: 103000,
      capitalUsd: 100000,
      asOf: TAX_DATE,
    };
    expect(actualUsTaxOverlay(input).currentYearTaxKrw).toBe(110000);
    expect(actualUsTaxOverlay({ ...input, revision: 2 }).currentYearTaxKrw).toBeNull();
    doc.executions.push({
      id: "fill",
      date: TAX_DATE,
      order: 0,
      symbol: "ABC",
      name: "ABC",
      market: "US",
      signalKey: null,
      side: "BUY",
      shares: 1,
      price: 100,
      fee: 1,
      note: "",
    });
    expect(actualUsTaxOverlay(input).currentYearTaxKrw).toBeNull();
  });
  it("checks model source date/version/NAV/cash and independent strategy scope", () => {
    const s = snapshot();
    const e = taxEvidence();
    e.scope = {
      kind: "COUNTERFACTUAL",
      poolId: `COUNTERFACTUAL:${s.strategy_id}`,
      strategyId: s.strategy_id,
    };
    e.coverage.residency = "MODEL_ASSUMPTION";
    e.sales.forEach((sale) => {
      sale.poolId = e.scope.poolId;
      sale.basisMethod = "FIFO_MODEL";
    });
    s.state["taxSource"] = { ledgerRevision: "1", ledgerDigest: "a".repeat(64) };
    s.state["taxEvidence"] = {
      sourceLedgerRevision: "1",
      sourceLedgerDigest: "a".repeat(64),
      sourceDate: s.date,
      sourceRuleVersion: s.rule_version,
      sourceNavUsd: s.nav_usd,
      sourceCashUsd: s.cash_usd,
      initialCapitalUsd: 100000,
      evidence: e,
    };
    const before = JSON.stringify(s);
    const evidenceSource = s.state["taxEvidence"] as Record<string, unknown>;
    evidenceSource["initialCapitalUsd"] = 1;
    expect(modelUsTaxOverlay(s).preTaxPnlUsd).toBe(3000);
    expect(modelUsTaxOverlay(s).currentYearTaxKrw).toBeNull();
    evidenceSource["initialCapitalUsd"] = 100000;
    expect(modelUsTaxOverlay(s).afterTaxNavUsd).toBe(102900);
    expect(JSON.stringify(s)).toBe(before);
    const oldSource = s.state["taxSource"];
    s.state["taxSource"] = { ledgerRevision: "2", ledgerDigest: "b".repeat(64) };
    expect(modelUsTaxOverlay(s).currentYearTaxKrw).toBeNull();
    s.state["taxSource"] = oldSource;
    for (const patch of [
      { date: "2026-10-01" },
      { rule_version: "new" },
      { nav_usd: 103001 },
      { cash_usd: 1001 },
      { strategy_id: "B3_BETA_SHADOW" },
    ])
      expect(modelUsTaxOverlay({ ...s, ...patch }).currentYearTaxKrw).toBeNull();
  });
});
