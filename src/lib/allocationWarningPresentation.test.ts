import saved from "../../tests/fixtures/morning-display-synthetic.json";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AllocationRecord, IntegratedAllocationLedger } from "./integratedAllocationShadow";
import {
  allocationWarningGroups,
  type AllocationWarningEvidence,
} from "./allocationWarningPresentation";
import { readAllocationWarningEvidence } from "./allocationWarningPresentation.server";
import { hashSeriesValue } from "./ledger/modelSeries";

const date = "2024-04-15",
  hash = `sha256:${"a".repeat(64)}`,
  code = `sha256:${"b".repeat(64)}`;
const uid = "11111111-2222-4333-8444-555555555555";
const record = {
  id: `session:E:${date}`,
  type: "SESSION",
  date,
  sourceHash: hash,
  fills: [],
  transfers: [],
  cancelledBuys: [],
  issues: [
    "SIGNAL_DATA_UNAVAILABLE:SYN008",
    "SIGNAL_DATA_UNAVAILABLE:SYN006",
    "SIGNAL_DATA_UNAVAILABLE:SYN005",
  ],
} as AllocationRecord;
const evidence: AllocationWarningEvidence = {
  date,
  sourceHash: hash,
  rows: [
    {
      symbol: "SYN008",
      name: "Synthetic ETF 8",
      issues: ["주식형·커버드콜 ETF 전략 대상 아님"],
    },
    { symbol: "SYN006", name: "Synthetic ETF 6", issues: ["검증된 ETF 분류 없음"] },
    { symbol: "SYN005", name: "Synthetic ETF 5", issues: ["기초지수 MA60·추세 이력 부족"] },
  ],
};
// Synthetic category boundaries and large-list stress cases; no production source excerpts.
describe("read-only allocation warning projection", () => {
  it("preserves the synthetic 120/1/9 split and all original 130 receipts", () => {
    const rows = [
      ...Array.from({ length: 120 }, (_, i) => ({ ...evidence.rows[0]!, symbol: `E${i}` })),
      evidence.rows[1]!,
      ...Array.from({ length: 9 }, (_, i) => ({ ...evidence.rows[2]!, symbol: `T${i}` })),
    ];
    const r = { ...record, issues: rows.map((r) => `SIGNAL_DATA_UNAVAILABLE:${r.symbol}`) };
    const before = JSON.stringify(r),
      e = { ...evidence, rows };
    const g = allocationWarningGroups(r, e);
    expect([g.excluded.length, g.unclassified.length, g.unavailable.length]).toEqual([120, 1, 9]);
    expect(JSON.stringify(r)).toBe(before);
  });
  it.each([
    undefined,
    { ...evidence, date: "2024-04-12" },
    { ...evidence, sourceHash: code },
    { ...evidence, rows: [...evidence.rows, evidence.rows[0]!] },
  ])("fails closed for missing, stale, mismatched or duplicated evidence", (e) => {
    expect(allocationWarningGroups(record, e).unverified).toHaveLength(3);
  });
  it("retains unknown future issue codes and duplicate original warnings", () => {
    const g = allocationWarningGroups(
      { ...record, issues: [...record.issues, record.issues[0]!, "NEW_ERROR"] },
      evidence,
    );
    expect(g.excluded).toHaveLength(2);
    expect(g.other).toEqual(["NEW_ERROR"]);
  });
});
function payload() {
  return {
    version: "integrated-kr-daily-evidence-v1",
    date,
    clock: {
      sourceHash: hash,
      codeHash: code,
      openAt: `${date}T00:00:00Z`,
      closeAt: `${date}T06:30:00Z`,
      availableAt: "2024-04-15T07:00:00Z",
      decisionAt: "2024-04-15T07:00:00Z",
      calendar: { sessions: [date] },
    },
    snapshot: {
      asOfDate: date,
      entries: evidence.rows.map((r) => ({ symbol: r.symbol, name: r.name })),
    },
    rows: evidence.rows.map((r) => ({
      instrument: { symbol: r.symbol, instrumentType: "ETF" },
      etfStrategy: {
        date,
        version: "etf-v02-confirm1-liquidity-no-replacement",
        exit: "DATA_UNAVAILABLE",
        issues: r.issues,
      },
    })),
  };
}
function client(value: unknown, error?: object) {
  const download = vi.fn(async (_path: string, _options: unknown, _request: unknown) => ({
    data: value === null ? null : { text: async () => JSON.stringify(value) },
    error,
  }));
  return {
    value: { storage: { from: vi.fn(() => ({ download })) } } as unknown as SupabaseClient,
    download,
  };
}
const ledger = {
  receipts: [{ record }],
  contract: { codeHash: code },
} as unknown as IntegratedAllocationLedger;
it("reads only the explicitly expanded owner/date path and verifies saved hash before annotation", async () => {
  const p = payload(),
    c = client({ hash: await hashSeriesValue(p), payload: p });
  const result = await readAllocationWarningEvidence(c.value, uid, ledger, record.id);
  expect(result[record.id]).toEqual(evidence);
  expect(c.download).toHaveBeenCalledTimes(1);
  expect(c.download.mock.calls[0]?.[0]).toBe(
    `${uid}/staging/integrated-allocation-inputs/v1/KR/${date}.json`,
  );
});
it("does no storage read for a missing receipt and rejects an unverified owner", async () => {
  const c = client(null);
  expect(await readAllocationWarningEvidence(c.value, uid, ledger, "session:E:2024-04-12")).toEqual(
    {},
  );
  expect(c.download).not.toHaveBeenCalled();
  await expect(
    readAllocationWarningEvidence(c.value, "../owner", ledger, record.id),
  ).rejects.toThrow("Verified owner");
});
it("annotation failure never removes the ledger or falls back to today's mapping", async () => {
  const before = JSON.stringify(ledger);
  for (const mutate of [
    (p: ReturnType<typeof payload>) => {
      p.date = "2024-04-12";
    },
    (p: ReturnType<typeof payload>) => {
      p.clock.sourceHash = code;
    },
    (p: ReturnType<typeof payload>) => {
      p.clock.codeHash = hash;
    },
    (p: ReturnType<typeof payload>) => {
      p.rows.push(p.rows[0]!);
    },
  ]) {
    const p = payload();
    mutate(p);
    const c = client({ hash: await hashSeriesValue(p), payload: p });
    expect(await readAllocationWarningEvidence(c.value, uid, ledger, record.id)).toEqual({});
  }
  for (const c of [
    client({ hash: "wrong", payload: payload() }),
    client(null),
    client(null, { statusCode: 403 }),
  ])
    expect(await readAllocationWarningEvidence(c.value, uid, ledger, record.id)).toEqual({});
  expect(JSON.stringify(ledger)).toBe(before);
});

it("rejects ambiguous names and invalid PIT clock/calendar even with a valid envelope hash", async () => {
  for (const mutate of [
    (p: ReturnType<typeof payload>) => {
      p.snapshot.entries.push(p.snapshot.entries[0]!);
    },
    (p: ReturnType<typeof payload>) => {
      p.clock.calendar.sessions = [];
    },
    (p: ReturnType<typeof payload>) => {
      p.clock.availableAt = `${date}T00:00:00Z`;
    },
    (p: ReturnType<typeof payload>) => {
      p.clock.decisionAt = "bad";
    },
  ]) {
    const p = payload();
    mutate(p);
    const c = client({ hash: await hashSeriesValue(p), payload: p });
    expect(await readAllocationWarningEvidence(c.value, uid, ledger, record.id)).toEqual({});
  }
});
it("keeps empty classification evidence unverified", () => {
  expect(
    allocationWarningGroups(record, {
      ...evidence,
      rows: evidence.rows.map((r) => ({ ...r, issues: [] })),
    }).unverified,
  ).toHaveLength(3);
});

it("classifies synthetic archived strategy boundaries rather than current ETF mapping", () => {
  const rows = saved.rows
    .filter((r) => r.strategy.exit === "DATA_UNAVAILABLE")
    .map((r) => ({ symbol: r.symbol, name: r.name, issues: r.strategy.issues }));
  const r = { ...record, issues: rows.map((row) => `SIGNAL_DATA_UNAVAILABLE:${row.symbol}`) };
  const g = allocationWarningGroups(r, { date, sourceHash: hash, rows });
  expect(g.excluded).toEqual(["SYN008 · Synthetic ETF 8"]);
  expect(g.unclassified).toEqual(["SYN006 · Synthetic ETF 6"]);
  expect(g.unavailable).toEqual(["SYN005 · Synthetic ETF 5"]);
});
