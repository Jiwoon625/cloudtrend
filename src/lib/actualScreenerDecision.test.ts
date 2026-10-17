import { it, expect } from "vitest";
import { actualCompactStockStatus, isActualOperationalEntry } from "./actualScreenerDecision";
import {
  applyEntryCommand,
  activeEntryDecisions,
  emptyEntryDecisions,
} from "./actualEntryDecisions";
import type { ScreeningRow } from "./engine/pipeline";
import { getCompactStockStatus } from "./stockCompactStatus";
const entries = activeEntryDecisions(
  applyEntryCommand(
    emptyEntryDecisions(),
    {
      action: "set",
      id: "11111111-1111-4111-8111-111111111111",
      market: "KOSDAQ",
      symbol: "TEST",
      name: "Synthetic",
      signalOriginDate: "2026-10-16",
      scope: "symbol",
      reason: "독립성 제한",
      note: "",
    },
    0,
    "2026-10-17T01:00:00.000Z",
  ),
);
const row = {
  instrument: { market: "KOSDAQ", symbol: "TEST", instrumentType: "STOCK" },
  snapshot: { tradeDate: "2026-10-19" },
  hardFilterStatus: "PASS",
  failedRules: [],
  pendingRules: [],
  operatingScore10: 8.2,
  previousOperatingScore10: 7.8,
  scoreDelta1d: 4,
  operationalOnset: true,
} as unknown as ScreeningRow;
it("actual restrictions override entry presentation without changing stored screening evidence", () => {
  const before = JSON.stringify(row);
  const context = { heldSymbols: [], lastSellDateBySymbol: {}, actualEntryDecisions: entries };
  expect(actualCompactStockStatus(row, context, "2026-10-19").primary).toContain("독립성 제한");
  expect(isActualOperationalEntry(row, context, "2026-10-19")).toBe(false);
  expect(JSON.stringify(row)).toBe(before);
});
it("actual held exits keep the same status with or without a restriction", () => {
  const context = {
    heldSymbols: ["TEST"],
    lastSellDateBySymbol: {},
    actualEntryDecisions: entries,
  };
  expect(actualCompactStockStatus(row, context, "2026-10-19")).toEqual(
    getCompactStockStatus(row, context, "2026-10-19"),
  );
});
it("unknown decision reads fail closed for actual entry eligibility", () => {
  expect(
    isActualOperationalEntry(
      row,
      { heldSymbols: [], lastSellDateBySymbol: {}, actualEntryDecisions: null },
      "2026-10-19",
    ),
  ).toBe(false);
});
