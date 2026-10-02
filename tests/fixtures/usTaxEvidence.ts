import {
  US_TAX_VERSION,
  type UsTaxEvidence,
  type UsTaxSale,
} from "../../src/lib/engine/usCapitalGainsTax";
export const TAX_DATE = "2026-10-02";
export function taxSale(id = "sale-1", gainKrw = 3_000_000): UsTaxSale {
  return {
    id,
    poolId: "ACTUAL_OWNER",
    accountId: "broker-a",
    accountTaxRegime: "ORDINARY",
    instrumentTaxKind: "FOREIGN_DIRECT_STOCK",
    settlementDate: TAX_DATE,
    grossProceedsUsd: 10000 + gainKrw / 1000,
    sellFx: { date: TAX_DATE, krwPerUsd: 1000, source: "settlement-FX" },
    eligibleDisposalExpenseKrw: 0,
    expenseSource: "broker-expenses-confirmed-zero",
    basisMethod: "BROKER_CONFIRMED",
    basisSource: "broker-tax-statement",
    acquisitionLots: [
      {
        lotId: `lot-${id}`,
        buySettlementDate: "2026-01-02",
        grossCostUsd: 10000,
        buyFx: { date: "2026-01-02", krwPerUsd: 1000, source: "acquisition-FX" },
        eligibleAcquisitionExpenseKrw: 0,
        expenseSource: "broker-expenses-confirmed-zero",
      },
    ],
    taxClass: "STANDARD_20_PERCENT",
  };
}
export function taxEvidence(sales: UsTaxSale[] = [taxSale()]): UsTaxEvidence {
  return {
    version: US_TAX_VERSION,
    scope: { kind: "ACTUAL_OWNER", poolId: "ACTUAL_OWNER", strategyId: null },
    coverage: {
      historyStartYear: 2026,
      throughDate: TAX_DATE,
      transactions: "COMPLETE",
      accounts: "ALL_TAXABLE_ACCOUNTS",
      priorLiabilities: "COMPLETE",
      residency: "CONFIRMED",
      reconciled: true,
      source: "broker annual statement and prior liabilities reconciled",
    },
    sales,
    openingLiabilities: [],
    payments: [],
    valuationFx: { date: TAX_DATE, krwPerUsd: 1100, source: "dated NAV FX" },
  };
}
