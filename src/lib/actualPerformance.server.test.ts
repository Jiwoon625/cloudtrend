import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActualPerformanceSeries, PerformanceBaseline } from "./ledger/actualPerformance";
import {
  previewReviewedActualPerformance,
  saveReviewedActualPerformance,
} from "./actualPerformance.server";

interface FakePayload {
  version?: number;
  actualCapital?: number;
  capital?: number;
  settings?: unknown;
  executions?: unknown[];
  excluded?: unknown;
  strategy?: unknown;
  unknownFutureField?: unknown;
  actualPerformance?: ActualPerformanceSeries;
}
interface FakeRow {
  revision: number;
  payload: FakePayload;
}
const state = vi.hoisted(() => ({
  domestic: null as FakeRow | null,
  us: null as FakeRow | null,
  reads: [] as { uid: string; source: string }[],
}));
vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (_: unknown, uid: string, source: string) => {
    state.reads.push({ uid, source });
    return structuredClone(source === "portfolio_ledgers" ? state.domestic : state.us);
  },
}));
const uid = "00000000-0000-4000-8000-000000000001";
const source = {
  system: "notion" as const,
  recordId: "synthetic-reconciliation",
  revision: "1",
  contentHash: `sha256:${"a".repeat(64)}`,
};
function baseline(): PerformanceBaseline {
  return {
    scope: "POST_START_ALLOCATED_CAPITAL",
    baseCurrency: "KRW",
    scopeConfirmed: true,
    accountScope: [{ accountId: "synthetic-account", currency: "KRW" }],
    pricePolicy: "EXPLICIT_DATED_MARKS_BEFORE_START",
    valuation: {
      date: "2026-10-12",
      recordedAt: "2026-10-11T12:00:00Z",
      source,
      complete: true,
      fx: [],
      accounts: [
        {
          accountId: "synthetic-account",
          currency: "KRW",
          cash: "100",
          unsettledCash: "0",
          knownCashDelta: "0",
          positions: [],
          equity: "100",
          issues: [],
        },
      ],
    },
    confirmedAt: "2026-10-11T12:00:00Z",
    sourceRevisions: { domestic: 8, us: 5 },
    betaArchive: { asOfDate: "2026-10-09", source, summaries: { syntheticLegacyPnl: "7" } },
  };
}
function client(conflict = false, corruptReadback = false) {
  const writes: { table: string; update: FakeRow; filters: [string, unknown][] }[] = [];
  return {
    writes,
    value: {
      from: (table: string) => {
        const filters: [string, unknown][] = [];
        let update: FakeRow;
        const q = {
          update: (value: FakeRow) => {
            update = value;
            return q;
          },
          eq: (field: string, value: unknown) => {
            filters.push([field, value]);
            return q;
          },
          select: () => q,
          maybeSingle: async () => {
            writes.push({ table, update, filters });
            if (conflict) return { data: null, error: null };
            state.domestic = structuredClone({
              revision: update.revision,
              payload: update.payload,
            });
            if (corruptReadback)
              (state.domestic!.payload.actualPerformance! as { startDate: string }).startDate =
                "2026-10-13";
            return { data: { revision: update.revision }, error: null };
          },
        };
        return q;
      },
    } as unknown as SupabaseClient,
  };
}
beforeEach(() => {
  state.reads = [];
  state.domestic = {
    revision: 8,
    payload: {
      version: 3,
      actualCapital: 1234,
      settings: { initialCapital: 9999 },
      executions: [{ id: "synthetic-existing-fill", price: 17, shares: 3 }],
      excluded: { unused: "keep" },
      strategy: { frozen: "unchanged" },
      unknownFutureField: { preserve: true },
    },
  };
  state.us = { revision: 5, payload: { capital: 5678, executions: [{ id: "synthetic-us-fill" }] } };
});
describe("reviewed actual performance metadata persistence", () => {
  it("changes only performance metadata, scopes CAS to owner, and verifies readback", async () => {
    const original = structuredClone(state.domestic!.payload),
      usBefore = structuredClone(state.us);
    const db = client();
    const saved = await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
      "2026-10-11T13:00:00Z",
    );
    const { actualPerformance, ...after } = state.domestic!.payload;
    expect(after).toEqual(original);
    expect(actualPerformance!.baseline!.valuation.accounts[0]!.cash).toBe("100");
    expect(state.us).toEqual(usBefore);
    expect(saved.revision).toBe(9);
    expect(saved.view.status).toBe("WAITING_OBSERVATION");
    expect(db.writes[0]!.filters).toEqual([
      ["user_id", uid],
      ["revision", 8],
    ]);
    expect(state.reads.every((r) => r.uid === uid)).toBe(true);
  });
  it("reuses an identical baseline without a second write", async () => {
    const db = client();
    const original = baseline();
    await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: original },
      "2026-10-11T13:00:00Z",
    );
    const again = await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 9, baseline: original },
      "2026-10-11T13:00:00Z",
    );
    expect(again.reused).toBe(true);
    expect(db.writes).toHaveLength(1);
  });
  it("rejects stale document revisions and mismatched reconciliation sources before writing", async () => {
    const db = client();
    await expect(
      saveReviewedActualPerformance(db.value, uid, {
        action: "confirmBaseline",
        expectedRevision: 7,
        baseline: baseline(),
      }),
    ).rejects.toThrow(/revision changed/);
    const b = baseline();
    b.sourceRevisions.us = 4;
    await expect(
      saveReviewedActualPerformance(db.value, uid, {
        action: "confirmBaseline",
        expectedRevision: 8,
        baseline: b,
      }),
    ).rejects.toThrow(/source revisions/);
    expect(db.writes).toHaveLength(0);
  });
  it("does not retry or overwrite a concurrent change", async () => {
    const original = structuredClone(state.domestic);
    const db = client(true);
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
        "2026-10-11T13:00:00Z",
      ),
    ).rejects.toThrow(/concurrently/);
    expect(state.domestic).toEqual(original);
    expect(db.writes).toHaveLength(1);
  });
  it("reports uncertain readback instead of claiming success or repeating the write", async () => {
    const db = client(false, true);
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
        "2026-10-11T13:00:00Z",
      ),
    ).rejects.toThrow(/acknowledgement/);
    expect(db.writes).toHaveLength(1);
  });
  it("rejects future reconciliation evidence without changing records", async () => {
    const db = client();
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
        "2026-10-09T13:00:00Z",
      ),
    ).rejects.toThrow(/Future reconciliation/);
    expect(db.writes).toHaveLength(0);
  });
});

describe("reviewed daily observation admission", () => {
  it("does not freeze missing-flow days, and accepts the completed retry without altering source documents", async () => {
    const db = client();
    await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
      "2026-10-11T13:00:00Z",
    );
    const before = structuredClone(state.domestic);
    const observation = {
      valuation: { ...baseline().valuation, recordedAt: "2026-10-12T23:00:00Z" },
      allocationConfirmed: true,
      tradeAllocations: [],
      cashAdjustments: [],
      previousDate: "2026-10-12",
      intervalComplete: true,
      flowsComplete: false,
      flows: [],
    };
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 9, observation },
        "2026-10-13T01:00:00Z",
      ),
    ).rejects.toThrow(/nothing was frozen/);
    expect(state.domestic).toEqual(before);
    expect(db.writes).toHaveLength(1);
    const result = await saveReviewedActualPerformance(
      db.value,
      uid,
      {
        action: "appendObservation",
        expectedRevision: 9,
        observation: { ...observation, flowsComplete: true },
      },
      "2026-10-13T01:00:00Z",
    );
    expect(result.view).toMatchObject({ status: "RECORDED", totalPnl: "0", returnPercent: "0" });
    expect(result.series.observations).toHaveLength(1);
    expect(db.writes).toHaveLength(2);
  });
  it("normalizes an offset clock before rejecting future observations", async () => {
    const db = client();
    await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
      "2026-10-11T13:00:00Z",
    );
    const observation = {
      valuation: { ...baseline().valuation, recordedAt: "2026-10-12T01:00:00Z" },
      allocationConfirmed: true,
      tradeAllocations: [],
      cashAdjustments: [],
      previousDate: "2026-10-12",
      intervalComplete: true,
      flowsComplete: true,
      flows: [],
    };
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 9, observation },
        "2026-10-12T01:00:00+09:00",
      ),
    ).rejects.toThrow(/future/);
    expect(db.writes).toHaveLength(1);
  });
  it("rejects an unknown action before reading or writing", async () => {
    const db = client();
    await expect(
      saveReviewedActualPerformance(db.value, uid, {
        action: "reset",
        expectedRevision: 8,
      } as unknown as Parameters<typeof saveReviewedActualPerformance>[2]),
    ).rejects.toThrow(/Unsupported/);
    expect(state.reads).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });
});

describe("read-only preview shares the persistence gates", () => {
  it("validates a baseline without changing either ledger or revision", async () => {
    const before = structuredClone({ domestic: state.domestic, us: state.us });
    const db = client();
    const preview = await previewReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
      "2026-10-11T13:00:00Z",
    );
    expect(preview.view.status).toBe("WAITING_OBSERVATION");
    expect(preview.revision).toBe(8);
    expect({ domestic: state.domestic, us: state.us }).toEqual(before);
    expect(db.writes).toHaveLength(0);
  });
  it("rejects bad evidence without previewing or writing an apparently valid result", async () => {
    const db = client();
    const value = baseline();
    value.valuation.complete = false;
    await expect(
      previewReviewedActualPerformance(
        db.value,
        uid,
        { action: "confirmBaseline", expectedRevision: 8, baseline: value },
        "2026-10-11T13:00:00Z",
      ),
    ).rejects.toThrow(/Complete positive/);
    expect(db.writes).toHaveLength(0);
  });
  it("rejects a KRW cash observation recorded before its valuation date without writing", async () => {
    const db = client();
    const value = baseline();
    await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: value },
      "2026-10-11T13:00:00Z",
    );
    const observation = {
      valuation: { ...value.valuation, recordedAt: "2020-01-01T00:00:00Z" },
      allocationConfirmed: true,
      tradeAllocations: [],
      cashAdjustments: [],
      previousDate: "2026-10-12",
      flowsComplete: true,
      intervalComplete: true,
      flows: [],
    };
    await expect(
      previewReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 9, observation },
        "2026-10-12T23:00:00Z",
      ),
    ).rejects.toThrow(/recording cutoff/);
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 9, observation },
        "2026-10-12T23:00:00Z",
      ),
    ).rejects.toThrow(/recording cutoff/);
    expect(db.writes).toHaveLength(1);
  });
});

describe("new-capital allocations bind to existing real fills", () => {
  const existingBuy = {
    id: "new-buy",
    symbol: "SYNTH",
    name: "Synthetic",
    market: "KOSPI",
    signalKey: null,
    side: "BUY",
    date: "2026-10-12",
    price: 10,
    shares: 2,
    fee: 1,
    note: "",
    order: 2,
  };
  const existingSell = {
    ...existingBuy,
    id: "mixed-sell",
    side: "SELL",
    date: "2026-10-13",
    price: 12,
    shares: 3,
    fee: 3,
    order: 3,
  };
  function allocation() {
    return {
      sourceSystem: "portfolio_ledgers" as const,
      executionId: "new-buy",
      date: "2026-10-12",
      order: 2,
      accountId: "synthetic-account",
      currency: "KRW" as const,
      securityId: "KOSPI:SYNTH",
      side: "BUY" as const,
      quantity: "2",
      price: "10",
      gross: "20",
      fee: "1",
      source,
    };
  }
  function buyObservation() {
    return {
      valuation: {
        ...baseline().valuation,
        recordedAt: "2026-10-12T23:00:00Z",
        accounts: [
          {
            ...baseline().valuation.accounts[0]!,
            cash: "79",
            equity: "101",
            positions: [
              {
                securityId: "KOSPI:SYNTH",
                quantity: "2",
                knownQuantityDelta: "2",
                costBasis: "21",
                marketValue: "22",
                priceDate: "2026-10-12",
              },
            ],
          },
        ],
      },
      previousDate: "2026-10-12",
      flowsComplete: true,
      intervalComplete: true,
      allocationConfirmed: true,
      tradeAllocations: [allocation()],
      cashAdjustments: [],
      flows: [],
    };
  }
  async function opened() {
    state.domestic!.payload.executions = [
      { ...existingBuy, id: "legacy-buy", date: "2026-10-08", shares: 5, price: 4, order: 1 },
      existingBuy,
      existingSell,
    ];
    const db = client();
    await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: baseline() },
      "2026-10-11T13:00:00Z",
    );
    return db;
  }
  it("records only explicitly allocated new shares, preserves the original legacy and mixed fills", async () => {
    const db = await opened();
    const fills = structuredClone(state.domestic!.payload.executions);
    const first = await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "appendObservation", expectedRevision: 9, observation: buyObservation() },
      "2026-10-12T23:30:00Z",
    );
    expect(first.view.totalPnl).toBe("1");
    const second = buyObservation();
    second.previousDate = "2026-10-12";
    second.valuation.date = "2026-10-13";
    second.valuation.recordedAt = "2026-10-13T23:00:00Z";
    second.valuation.accounts[0]!.cash = "90";
    second.valuation.accounts[0]!.equity = "102";
    Object.assign(second.valuation.accounts[0]!.positions[0]!, {
      quantity: "1",
      marketValue: "12",
      priceDate: "2026-10-13",
    });
    Object.assign(second.tradeAllocations[0]!, {
      executionId: "mixed-sell",
      date: "2026-10-13",
      order: 3,
      side: "SELL",
      quantity: "1",
      price: "12",
      gross: "12",
      fee: "1",
    });
    const result = await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "appendObservation", expectedRevision: 10, observation: second },
      "2026-10-13T23:30:00Z",
    );
    expect(result.view.totalPnl).toBe("2");
    expect(result.series.observations.at(-1)!.valuation.accounts[0]!.positions[0]!.quantity).toBe(
      "1",
    );
    expect(state.domestic!.payload.executions).toEqual(fills);
  });
  it("can explicitly allocate whole shares from a preserved fractional original fill", async () => {
    const db = await opened();
    const original = { ...existingBuy, shares: 3.5 };
    state.domestic!.payload.executions = [original];
    const result = await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "appendObservation", expectedRevision: 9, observation: buyObservation() },
      "2026-10-12T23:30:00Z",
    );
    expect(result.view.totalPnl).toBe("1");
    expect(state.domestic!.payload.executions).toEqual([original]);
  });
  it("preserves original high-precision average price and the separate full-fill gross", async () => {
    const db = await opened();
    const original = { ...existingBuy, price: 100 / 3, shares: 3, fee: 0 };
    state.domestic!.payload.executions = [original];
    const observation = buyObservation();
    Object.assign(observation.tradeAllocations[0]!, {
      quantity: "3",
      price: "33.33333333",
      gross: "100",
      fee: "0",
    });
    Object.assign(observation.valuation.accounts[0]!, { cash: "0", equity: "100" });
    Object.assign(observation.valuation.accounts[0]!.positions[0]!, {
      quantity: "3",
      costBasis: "100",
      marketValue: "100",
    });
    const result = await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "appendObservation", expectedRevision: 9, observation },
      "2026-10-12T23:30:00Z",
    );
    expect(result.view.totalPnl).toBe("0");
    expect(state.domestic!.payload.executions).toEqual([original]);
  });
  it("rejects an invented full-fill gross even if submitted cash balances to it", async () => {
    const db = await opened();
    const observation = buyObservation();
    observation.tradeAllocations[0]!.gross = "19";
    Object.assign(observation.valuation.accounts[0]!, { cash: "80", equity: "102" });
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 9, observation },
        "2026-10-12T23:30:00Z",
      ),
    ).rejects.toThrow(/gross|fill/i);
    expect(db.writes).toHaveLength(1);
  });
  it.each(["missing", "legacy-buy"])("rejects an absent or pre-start execution %s", async (id) => {
    const db = await opened();
    const observation = buyObservation();
    observation.tradeAllocations[0]!.executionId = id;
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 9, observation },
        "2026-10-12T23:30:00Z",
      ),
    ).rejects.toThrow(/execution|fill/i);
    expect(db.writes).toHaveLength(1);
  });
  it("rejects wrong original facts or unreviewed fees before any metadata write", async () => {
    const db = await opened();
    for (const altered of [
      { order: 999 },
      { price: 11 },
      { shares: 1 },
      { fee: 2 },
      { side: "SELL" },
      { market: "US" },
      { symbol: "OTHER" },
    ]) {
      state.domestic!.payload.executions = [{ ...existingBuy, ...altered }];
      await expect(
        saveReviewedActualPerformance(
          db.value,
          uid,
          { action: "appendObservation", expectedRevision: 9, observation: buyObservation() },
          "2026-10-12T23:30:00Z",
        ),
      ).rejects.toThrow(/execution|fill/i);
    }
    expect(db.writes).toHaveLength(1);
  });
  it("rechecks referenced past fills and blocks a later silent source edit", async () => {
    const db = await opened();
    await saveReviewedActualPerformance(
      db.value,
      uid,
      { action: "appendObservation", expectedRevision: 9, observation: buyObservation() },
      "2026-10-12T23:30:00Z",
    );
    state.domestic!.payload.executions = [{ ...existingBuy, price: 99 }];
    const later = buyObservation();
    later.tradeAllocations = [];
    later.valuation.date = "2026-10-13";
    later.valuation.recordedAt = "2026-10-13T23:00:00Z";
    later.valuation.accounts[0]!.positions[0]!.priceDate = "2026-10-13";
    await expect(
      saveReviewedActualPerformance(
        db.value,
        uid,
        { action: "appendObservation", expectedRevision: 10, observation: later },
        "2026-10-13T23:30:00Z",
      ),
    ).rejects.toThrow(/execution|fill/i);
    expect(db.writes).toHaveLength(2);
  });
});

it("rejects beta dates beyond evidence/current Korean day but accepts a Saturday review of Friday", async () => {
  const db = client();
  const b = baseline();
  b.confirmedAt = "2026-10-09T09:00:00Z";
  b.valuation.recordedAt = b.confirmedAt;
  b.betaArchive.asOfDate = "2026-10-11";
  await expect(
    previewReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: b },
      "2026-10-09T10:00:00Z",
    ),
  ).rejects.toThrow(/Future|boundary/);
  b.betaArchive.asOfDate = "2026-10-10";
  // The same instant with an offset must use the Korean date, not the textual prefix.
  b.confirmedAt = "2026-10-09T16:00:00Z";
  b.valuation.recordedAt = "2026-10-10T01:00:00+09:00";
  await expect(
    previewReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: b },
      "2026-10-09T17:00:00Z",
    ),
  ).resolves.toBeDefined();
  b.betaArchive.asOfDate = "2026-10-09";
  await expect(
    previewReviewedActualPerformance(
      db.value,
      uid,
      { action: "confirmBaseline", expectedRevision: 8, baseline: b },
      "2026-10-10T10:00:00Z",
    ),
  ).resolves.toBeDefined();
  expect(db.writes).toEqual([]);
});
