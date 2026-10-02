import { describe, expect, it } from "vitest";
import { estimateAnnualUsTax, estimateUsTaxOverlay, type UsTaxEvidence } from "./usCapitalGainsTax";
import { TAX_DATE, taxEvidence, taxSale } from "../../../tests/fixtures/usTaxEvidence";

function estimate(evidence: unknown = taxEvidence(), asOf = TAX_DATE) {
  return estimateUsTaxOverlay({
    asOf,
    kind: "ACTUAL_OWNER",
    poolId: "ACTUAL_OWNER",
    strategyId: null,
    preTaxNavUsd: 103000,
    initialCapitalUsd: 100000,
    evidence,
  });
}
function counterfactual(strategyId: string, evidence = taxEvidence()) {
  const e = structuredClone(evidence);
  e.scope = { kind: "COUNTERFACTUAL", poolId: `MODEL:${strategyId}`, strategyId };
  e.sales.forEach((s) => {
    s.poolId = e.scope.poolId;
    s.basisMethod = "FIFO_MODEL";
  });
  e.coverage.residency = "MODEL_ASSUMPTION";
  return estimateUsTaxOverlay({
    asOf: TAX_DATE,
    ...e.scope,
    preTaxNavUsd: 103000,
    initialCapitalUsd: 100000,
    evidence: e,
  });
}
describe("Korean resident US realized capital gains estimate", () => {
  it.each([
    [-100000, 0],
    [0, 0],
    [2499999, 0],
    [2500000, 0],
    [2500001, 0.22],
    [3000000, 110000],
  ])("taxes only annual gain %s above the deduction", (gain, tax) => {
    expect(estimateAnnualUsTax(gain).liabilityKrw).toBe(tax);
  });
  it("splits national 20% and local 2%, after the annual deduction", () => {
    expect(estimateAnnualUsTax(3000000)).toEqual({
      taxableKrw: 500000,
      nationalTaxKrw: 100000,
      localTaxKrw: 10000,
      liabilityKrw: 110000,
    });
  });
  it("nets gains and losses across accounts; one owner gets one deduction", () => {
    const a = taxSale("a", 5_000_000),
      b = taxSale("b", -2_000_000);
    b.accountId = "broker-b";
    expect(estimate(taxEvidence([a, b])).currentYearTaxKrw).toBe(110000);
    a.grossProceedsUsd = b.grossProceedsUsd = 12000;
    expect(estimate(taxEvidence([a, b])).currentYearTaxKrw).toBe(330000);
  });
  it("can reverse the current-year reserve after a realized loss", () => {
    const e = taxEvidence([taxSale("profit", 5_000_000)]);
    expect(estimate(e).unpaidReserveKrw).toBe(550000);
    e.sales.push(taxSale("loss", -4_000_000));
    expect(estimate(e).unpaidReserveKrw).toBe(0);
  });
  it("keeps prior-year unpaid liability on January 1 and does not carry capital losses", () => {
    const e = taxEvidence([taxSale("last-year", 3_000_000)]);
    e.coverage.throughDate = "2027-01-01";
    e.valuationFx!.date = "2027-01-01";
    const result = estimate(e, "2027-01-01");
    expect(result.currentYearTaxKrw).toBe(0);
    expect(result.priorYearUnpaidKrw).toBe(110000);
    expect(result.unpaidReserveKrw).toBe(110000);
    e.sales = [taxSale("loss", -5000000)];
    const next = taxSale("next-year", 3000000);
    next.settlementDate = next.sellFx.date = "2027-01-01";
    e.sales.push(next);
    expect(estimate(e, "2027-01-01").currentYearTaxKrw).toBe(110000);
  });
  it("allocates a late-December trade settling in January to the next year", () => {
    const e = taxEvidence();
    e.sales[0]!.settlementDate = e.sales[0]!.sellFx.date = "2027-01-04";
    e.coverage.throughDate = e.valuationFx!.date = "2026-12-31";
    expect(estimate(e, "2026-12-31").currentYearTaxKrw).toBe(0);
    e.coverage.throughDate = e.valuationFx!.date = "2027-01-04";
    expect(estimate(e, "2027-01-04").currentYearTaxKrw).toBe(110000);
  });
  it("can produce a taxable KRW gain despite a USD loss using each settlement's FX", () => {
    const e = taxEvidence();
    const s = e.sales[0]!;
    s.grossProceedsUsd = 9000;
    s.sellFx.krwPerUsd = 1500; // $9k proceeds = KRW13.5m, $10k basis = KRW10m
    const result = estimate(e);
    expect(result.currentYearRealizedKrw).toBe(3500000);
    expect(result.currentYearTaxKrw).toBe(220000);
    expect(result.afterTaxNavUsd).toBe(102800); // NAV valuation FX=1100, not settlement FX
  });
  it("deducts explicit eligible expenses once and does not read model fees/slippage", () => {
    const e = taxEvidence();
    e.sales[0]!.eligibleDisposalExpenseKrw = 100000;
    e.sales[0]!.acquisitionLots[0]!.eligibleAcquisitionExpenseKrw = 100000;
    const withModelCost = {
      ...e,
      modelRoundTripCost: 0.003,
      modelFeeUsd: 999999,
      dividends: 9999999,
      unrealizedPnl: 999999,
    };
    expect(estimate(withModelCost).currentYearRealizedKrw).toBe(2800000);
    expect(estimate(withModelCost).currentYearTaxKrw).toBe(66000);
  });
  it("excludes explicitly non-taxable transactions and blocks unsupported mixed-rate assets", () => {
    const e = taxEvidence([
      taxSale("ordinary"),
      { ...taxSale("domestic-exempt", 9000000), taxClass: "EXCLUDED" },
    ]);
    expect(estimate(e).currentYearTaxKrw).toBe(110000);
    e.sales[1]!.taxClass = "UNSUPPORTED";
    expect(estimate(e).currentYearTaxKrw).toBeNull();
    expect(estimate(e).missingFields.join(" ")).toContain("다른 세율");
  });
  it.each([
    (e: UsTaxEvidence) => {
      e.coverage.reconciled = false;
    },
    (e: UsTaxEvidence) => {
      e.coverage.accounts = "UNKNOWN";
    },
    (e: UsTaxEvidence) => {
      e.coverage.transactions = "UNKNOWN";
    },
    (e: UsTaxEvidence) => {
      e.coverage.residency = "MODEL_ASSUMPTION";
    },
    (e: UsTaxEvidence) => {
      e.coverage.throughDate = "2026-10-01";
    },
    (e: UsTaxEvidence) => {
      e.sales[0]!.sellFx.date = "2026-10-01";
    },
    (e: UsTaxEvidence) => {
      e.sales[0]!.acquisitionLots[0]!.buyFx.date = TAX_DATE;
    },
    (e: UsTaxEvidence) => {
      e.sales[0]!.basisMethod = "FIFO_MODEL";
    },
    (e: UsTaxEvidence) => {
      e.sales.push(structuredClone(e.sales[0]!));
    },
    (e: UsTaxEvidence) => {
      e.sales[0]!.poolId = "OTHER_OWNER";
    },
    (e: UsTaxEvidence) => {
      e.scope.kind = "COUNTERFACTUAL";
    },
  ])("fails closed for inconsistent or unverified tax evidence %#", (change) => {
    const e = taxEvidence();
    change(e);
    const r = estimate(e);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.currentYearTaxKrw).toBeNull();
    expect(r.afterTaxNavUsd).toBeNull();
    expect(r.preTaxNavUsd).toBe(103000);
  });
  it("missing FX or missing cost/expenses stays null, never zero", () => {
    for (const key of ["sellFx", "acquisitionLots", "eligibleDisposalExpenseKrw"]) {
      const e = taxEvidence();
      delete (e.sales[0] as unknown as Record<string, unknown>)[key];
      expect(estimate(e).currentYearTaxKrw).toBeNull();
    }
    expect(estimate(null).currentYearTaxKrw).toBeNull();
  });
  it("reports a registered-only estimate without claiming the owner's total tax", () => {
    const e = taxEvidence();
    e.coverage.accounts = "REGISTERED_ONLY";
    const r = estimate(e);
    expect(r.status).toBe("PARTIAL");
    expect(r.scopeLabel).toContain("등록 거래 기준");
    expect(r.currentYearTaxKrw).toBe(110000);
  });
  it("permits verified zero sales but never infers completeness from absence of sales", () => {
    expect(estimate(taxEvidence([])).currentYearTaxKrw).toBe(0);
    const e = taxEvidence([]);
    e.coverage.transactions = "UNKNOWN";
    expect(estimate(e).currentYearTaxKrw).toBeNull();
  });
  it("keeps annual KRW estimate visible when separate NAV FX is missing/stale", () => {
    const e = taxEvidence();
    e.valuationFx = null;
    expect(estimate(e).currentYearTaxKrw).toBe(110000);
    expect(estimate(e).afterTaxNavUsd).toBeNull();
    e.valuationFx = { date: "2026-10-01", krwPerUsd: 1359.6, source: "initial-capital-only" };
    expect(estimate(e).afterTaxNavUsd).toBeNull();
  });
  it("assigns each counterfactual an independent deduction, even future integer versions", () => {
    const e = taxEvidence([taxSale("p", 2000000)]);
    for (const strategy of [
      "A0_QUARTER_PRIMARY",
      "A2_QUARTER_SHADOW",
      "B3_BETA_SHADOW",
      "A0_INTEGER_V173",
    ])
      expect(counterfactual(strategy, e).currentYearTaxKrw).toBe(0);
    const combined = taxEvidence([taxSale("a", 2000000), taxSale("b", 2000000)]);
    expect(estimate(combined).currentYearTaxKrw).toBe(330000);
  });
  it("carries sourced opening liabilities without deducting payments twice", () => {
    const e = taxEvidence();
    e.openingLiabilities = [
      { taxYear: 2025, liabilityKrw: 220000, source: "prior tax assessment" },
    ];
    e.payments = [
      {
        id: "tax-paid",
        poolId: "ACTUAL_OWNER",
        taxYear: 2025,
        paidDate: "2026-05-31",
        amountKrw: 220000,
        source: "receipt",
        navTreatment: "ALREADY_INCLUDED",
        paidUsd: null,
      },
    ];
    const r = estimate(e);
    expect(r.priorYearUnpaidKrw).toBe(0);
    expect(r.afterTaxNavUsd).toBe(102900);
    e.payments[0]!.navTreatment = "OUTSIDE_NAV";
    e.payments[0]!.paidUsd = 200;
    expect(estimate(e).afterTaxNavUsd).toBe(102700);
    e.payments[0]!.paidUsd = null;
    expect(estimate(e).afterTaxNavUsd).toBeNull();
  });
  it("rejects contradictory zero and positive KRW/USD tax payment amounts", () => {
    for (const [amountKrw, paidUsd] of [
      [110000, 0],
      [0, 100],
    ]) {
      const e = taxEvidence();
      e.payments = [
        {
          id: "payment",
          poolId: "ACTUAL_OWNER",
          taxYear: 2026,
          paidDate: TAX_DATE,
          amountKrw: amountKrw!,
          source: "receipt",
          navTreatment: "OUTSIDE_NAV",
          paidUsd: paidUsd!,
        },
      ];
      expect(estimate(e).afterTaxNavUsd).toBeNull();
      expect(estimate(e).missingFields.join(" ")).toContain("0 여부 불일치");
    }
  });
  it("rejects duplicate/overpaid payments and opening-year overlap", () => {
    const e = taxEvidence();
    e.payments = [
      {
        id: "x",
        poolId: "ACTUAL_OWNER",
        taxYear: 2026,
        paidDate: TAX_DATE,
        amountKrw: 110000,
        source: "receipt",
        navTreatment: "ALREADY_INCLUDED",
        paidUsd: null,
      },
    ];
    e.payments.push(structuredClone(e.payments[0]!));
    expect(estimate(e).status).toBe("UNAVAILABLE");
    e.payments = [];
    e.openingLiabilities = [{ taxYear: 2026, liabilityKrw: 1, source: "overlap" }];
    expect(estimate(e).status).toBe("UNAVAILABLE");
  });
  it("does not infer broker tax status or combine ISA with the ordinary annual pool", () => {
    for (const regime of ["ISA", "UNKNOWN"] as const) {
      const e = taxEvidence();
      e.sales[0]!.accountTaxRegime = regime;
      expect(estimate(e).status).toBe("UNAVAILABLE");
    }
    const e = taxEvidence();
    e.sales[0]!.instrumentTaxKind = "OTHER";
    expect(estimate(e).currentYearTaxKrw).toBeNull();
    e.sales[0]!.instrumentTaxKind = "DOMESTIC_TAXABLE_STOCK";
    expect(estimate(e).currentYearTaxKrw).toBeNull();
  });
  it("shows known current-year tax while earlier unpaid liability remains unknown", () => {
    const e = taxEvidence();
    e.coverage.priorLiabilities = "UNKNOWN";
    const r = estimate(e);
    expect(r.currentYearTaxKrw).toBe(110000);
    expect(r.priorYearUnpaidKrw).toBeNull();
    expect(r.unpaidReserveKrw).toBeNull();
    expect(r.afterTaxNavUsd).toBeNull();
  });
  it("does not need valuation FX to convert a verified zero reserve", () => {
    const e = taxEvidence([]);
    e.valuationFx = null;
    expect(estimate(e).afterTaxNavUsd).toBe(103000);
    expect(estimate(e).missingFields).toEqual([]);
    e.coverage.transactions = "UNKNOWN";
    expect(estimate(e).afterTaxNavUsd).toBeNull();
  });
  it("is deterministic and does not mutate source records or pre-tax inputs", () => {
    const e = taxEvidence();
    const before = JSON.stringify(e);
    expect(estimate(e)).toEqual(estimate(e));
    expect(JSON.stringify(e)).toBe(before);
    expect(estimate(e).preTaxPnlUsd).toBe(3000);
  });
});
