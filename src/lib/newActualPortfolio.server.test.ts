import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadNewActualPortfolio,
  saveNewActualPortfolio,
  type NewActualDocument,
} from "./newActualPortfolio.server";
import type { NewActualPortfolioWrite } from "./newActualPortfolioInput";
import type { NewActualExecution } from "./newActualPortfolio";
const state = vi.hoisted(() => ({
  rows: {} as Record<string, { revision: number; payload: NewActualDocument }>,
  reads: [] as string[],
  quotes: {} as Record<string, { price: number; date: string; exitSignal: null }>,
  quoteError: false,
}));
vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (_: unknown, uid: string, table: string) => {
    state.reads.push(`${uid}:${table}`);
    return structuredClone(state.rows[table] ?? null);
  },
}));
vi.mock("./portfolioLedgers.server", () => ({
  loadNewActualDomesticQuotes: async () => {
    if (state.quoteError) throw Error("private source detail");
    return state.quotes;
  },
}));
vi.mock("./usActualLedger.server", () => ({
  quotesFor: async () => {
    if (state.quoteError) throw Error("private source detail");
    return state.quotes;
  },
}));
const uid = "11111111-1111-4111-8111-111111111111",
  kr = "portfolio_ledgers",
  us = "us_actual_portfolio_ledgers",
  now = "2026-10-14T23:00:00Z";
function legacy(market: "KOSPI" | "US" = "KOSPI"): NewActualExecution {
  return {
    id: `legacy-${market}`,
    symbol: market === "US" ? "AAPL" : "005930",
    name: "Synthetic old security",
    market,
    signalKey: "old-signal",
    side: "BUY",
    date: "2026-09-01",
    price: 10,
    shares: 100,
    fee: 1,
    note: "legacy untouched",
    order: 0,
  };
}
function client(options: { conflict?: boolean; corrupt?: boolean; failure?: boolean } = {}) {
  const writes: unknown[] = [];
  return {
    writes,
    value: {
      from: (table: string) => {
        let value: { revision: number; payload: NewActualDocument };
        const filters: unknown[] = [];
        const q = {
          update: (v: typeof value) => {
            value = v;
            return q;
          },
          eq: (key: string, v: unknown) => {
            filters.push([key, v]);
            return q;
          },
          select: () => q,
          maybeSingle: async () => {
            writes.push({ table, value, filters });
            if (options.failure) return { error: { message: "secret SQL" }, data: null };
            if (options.conflict) return { error: null, data: null };
            state.rows[table] = structuredClone(value);
            if (options.corrupt) state.rows[table]!.revision++;
            return { error: null, data: { revision: value.revision } };
          },
        };
        return q;
      },
    } as unknown as SupabaseClient,
  };
}
let sequence = 1;
type ExecutionWrite = Extract<NewActualPortfolioWrite, { action: "execution" }>;
function buy(overrides: Partial<ExecutionWrite> = {}): ExecutionWrite {
  return {
    accessToken: "synthetic",
    action: "execution",
    expectedRevision: state.rows[kr]!.revision,
    requestId: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    asset: "KR",
    execution: {
      id: "",
      symbol: "005930",
      name: "Synthetic new security",
      market: "KOSPI",
      side: "BUY",
      date: "2026-10-12",
      price: 100,
      shares: 10,
      fee: 1,
      note: "actual fill",
    },
    allocation: { quantity: 10, gross: 1000, fee: 1, brokerReference: `fill-${sequence}` },
    confirmed: true,
    ...overrides,
  } as ExecutionWrite;
}
beforeEach(() => {
  sequence = 1;
  state.reads = [];
  state.quoteError = false;
  state.quotes = { "005930": { price: 110, date: "2026-10-14", exitSignal: null } };
  state.rows = {
    [kr]: {
      revision: 4,
      payload: {
        executions: [legacy()],
        actualCapital: 98765,
        etfCapital: 12345,
        strategy: { preserve: true },
        operatingCapitalPlan: { totalKrw: 12345678 },
        unknownFutureMetadata: { untouched: true },
      },
    },
    [us]: { revision: 7, payload: { executions: [legacy("US")], capital: 100000 } },
  };
});
describe("new-only portfolio persistence", () => {
  it("reads no historical holdings or fictitious capital into the new series and does not write", async () => {
    const db = client();
    const loaded = await loadNewActualPortfolio(db.value, uid, now);
    expect(loaded.pools.KRW.positions).toEqual([]);
    expect(loaded.pools.USD.trades).toEqual([]);
    expect(loaded.pools.KRW.cash).toBeNull();
    expect(loaded.pools.KRW.fundingStatus).toBe("PENDING");
    expect(db.writes).toEqual([]);
  });
  it("saves real fill plus explicit assignment in one owner CAS and preserves legacy/settings/model", async () => {
    const db = client(),
      original = structuredClone(state.rows[kr]!.payload),
      other = structuredClone(state.rows[us]);
    const request = buy();
    const saved = await saveNewActualPortfolio(db.value, uid, request, now);
    expect(saved.revision).toBe(5);
    const doc = state.rows[kr]!.payload;
    expect(doc.executions[0]).toEqual(original.executions[0]);
    for (const [key, value] of Object.entries(original))
      if (key !== "executions") expect(doc[key]).toEqual(value);
    expect(state.rows[us]).toEqual(other);
    expect(doc.executions[1]!.signalKey).toBeNull();
    expect(doc.executions[1]!.shares).toBe(10);
    expect(doc.newActualPortfolio!.assignments[doc.executions[1]!.id]!.quantity).toBe(10);
    expect(db.writes).toEqual([
      expect.objectContaining({
        table: kr,
        filters: [
          ["user_id", uid],
          ["revision", 4],
        ],
      }),
    ]);
    const view = await loadNewActualPortfolio(db.value, uid, now);
    expect(view.pools.KRW.positions[0]!.quantity).toBe("10");
    expect(view.pools.KRW.cash).toBeNull();
    expect(view.pools.KRW.trades).toHaveLength(1);
  });
  it("reuses stable request identity after lost response without appending again", async () => {
    const db = client(),
      request = buy();
    await saveNewActualPortfolio(db.value, uid, request, now);
    expect((await saveNewActualPortfolio(db.value, uid, request, now)).reused).toBe(true);
    expect(db.writes).toHaveLength(1);
    if (request.action !== "execution") throw Error();
    request.execution.price = 101;
    await expect(saveNewActualPortfolio(db.value, uid, request, now)).rejects.toThrow(
      /같은 저장 식별자/,
    );
  });
  it("rejects old adoption, prestart/future, wrong asset and duplicate broker reference before writing", async () => {
    for (const change of [
      { execution: { ...buy().execution, id: "legacy-KOSPI" } },
      { execution: { ...buy().execution, date: "2026-10-09" } },
      { execution: { ...buy().execution, date: "2026-10-20" } },
      { asset: "ETF" },
    ]) {
      const db = client();
      await expect(
        saveNewActualPortfolio(db.value, uid, buy(change as Partial<ExecutionWrite>), now),
      ).rejects.toThrow();
      expect(db.writes).toHaveLength(0);
    }
    const db = client(),
      first = buy();
    await saveNewActualPortfolio(db.value, uid, first, now);
    if (first.action !== "execution") throw Error();
    await expect(
      saveNewActualPortfolio(db.value, uid, buy({ allocation: first.allocation }), now),
    ).rejects.toThrow();
    expect(db.writes).toHaveLength(1);
  });
  it("prevents new sale using legacy same-ticker holdings", async () => {
    const db = client();
    await saveNewActualPortfolio(db.value, uid, buy(), now);
    const sale = buy();
    if (sale.action !== "execution") throw Error();
    sale.execution.side = "SELL";
    sale.execution.shares = 11;
    sale.allocation.quantity = 11;
    sale.allocation.gross = 1100;
    await expect(saveNewActualPortfolio(db.value, uid, sale, now)).rejects.toThrow();
    expect(state.rows[kr]!.payload.executions).toHaveLength(2);
  });
  it("corrects and cancels new fills with before snapshots, leaving original old fill unchanged", async () => {
    const db = client();
    await saveNewActualPortfolio(db.value, uid, buy(), now);
    const id = state.rows[kr]!.payload.executions[1]!.id;
    const correction = buy();
    if (correction.action !== "execution") throw Error();
    correction.execution.id = id;
    correction.execution.shares = 5;
    correction.allocation.quantity = 5;
    correction.allocation.gross = 500;
    await saveNewActualPortfolio(db.value, uid, correction, now);
    expect(state.rows[kr]!.payload.newActualPortfolio!.audit[1]!.before!.execution!.shares).toBe(
      10,
    );
    const cancellation = {
      accessToken: "synthetic",
      action: "cancelExecution",
      asset: "KR",
      executionId: id,
      expectedRevision: 6,
      requestId: "00000000-0000-4000-8000-000000000090",
      reason: "입력 중복 정정",
    } as const;
    await saveNewActualPortfolio(db.value, uid, cancellation, now);
    expect(state.rows[kr]!.payload.executions).toEqual([legacy()]);
    expect(state.rows[kr]!.payload.newActualPortfolio!.audit).toHaveLength(3);
    expect((await loadNewActualPortfolio(db.value, uid, now)).pools.KRW.positions).toEqual([]);
  });
  it("rejects cancelling buy required by a later new sell", async () => {
    const db = client();
    await saveNewActualPortfolio(db.value, uid, buy(), now);
    const id = state.rows[kr]!.payload.executions[1]!.id;
    const sale = buy();
    if (sale.action !== "execution") throw Error();
    sale.execution.side = "SELL";
    sale.execution.date = "2026-10-13";
    await saveNewActualPortfolio(db.value, uid, sale, now);
    await expect(
      saveNewActualPortfolio(
        db.value,
        uid,
        {
          accessToken: "synthetic",
          action: "cancelExecution",
          asset: "KR",
          executionId: id,
          expectedRevision: 6,
          requestId: "00000000-0000-4000-8000-000000000090",
          reason: "wrong order",
        },
        now,
      ),
    ).rejects.toThrow();
    expect(db.writes).toHaveLength(2);
  });
  it("preserves mixed raw originals and requires explicit new-slice amounts", async () => {
    const db = client();
    const mixed = buy();
    if (mixed.action !== "execution") throw Error();
    mixed.execution.shares = 20;
    mixed.execution.fee = 2;
    await saveNewActualPortfolio(db.value, uid, mixed, now);
    const id = state.rows[kr]!.payload.executions[1]!.id;
    expect(
      (await loadNewActualPortfolio(db.value, uid, now)).pools.KRW.positions[0]!.quantity,
    ).toBe("10");
    await expect(
      saveNewActualPortfolio(
        db.value,
        uid,
        {
          accessToken: "synthetic",
          action: "cancelExecution",
          asset: "KR",
          executionId: id,
          expectedRevision: 5,
          requestId: "00000000-0000-4000-8000-000000000091",
          reason: "mixed cancellation",
        },
        now,
      ),
    ).rejects.toThrow(/혼합/);
    const correction = buy();
    if (correction.action !== "execution") throw Error();
    correction.execution.id = id;
    await expect(saveNewActualPortfolio(db.value, uid, correction, now)).rejects.toThrow(
      /혼합 체결의 원본/,
    );
    expect(state.rows[kr]!.payload.executions[1]!.shares).toBe(20);
  });
  it("keeps mixed protection after allocation-only promotion and refuses later raw cancellation", async () => {
    const db = client(),
      mixed = buy();
    mixed.execution.shares = 20;
    mixed.execution.fee = 2;
    await saveNewActualPortfolio(db.value, uid, mixed, now);
    const id = state.rows[kr]!.payload.executions[1]!.id;
    const promoted = buy({
      execution: { ...mixed.execution, id },
      allocation: { ...mixed.allocation, quantity: 20, gross: 2000, fee: 2 },
    });
    await saveNewActualPortfolio(db.value, uid, promoted, now);
    const view = await loadNewActualPortfolio(db.value, uid, now);
    expect(view.pools.KRW.trades[0]!.rawProtected).toBe(true);
    await expect(
      saveNewActualPortfolio(
        db.value,
        uid,
        {
          accessToken: "synthetic",
          action: "cancelExecution",
          asset: "KR",
          executionId: id,
          expectedRevision: 6,
          requestId: "00000000-0000-4000-8000-000000000094",
          reason: "mixed promoted",
        },
        now,
      ),
    ).rejects.toThrow(/혼합/);
    const changed = buy({
      execution: { ...promoted.execution, shares: 10, fee: 1 },
      allocation: { ...promoted.allocation, quantity: 10, gross: 1000, fee: 1 },
    });
    await expect(saveNewActualPortfolio(db.value, uid, changed, now)).rejects.toThrow(/혼합/);
    expect(state.rows[kr]!.payload.executions[1]!.shares).toBe(20);
  });
  it("records KR+ETF shared cash only once, treats old sale proceeds as contribution, keeps correction/cancel history", async () => {
    const db = client();
    const cash = {
      accessToken: "synthetic",
      action: "cash",
      expectedRevision: 4,
      requestId: "00000000-0000-4000-8000-000000000070",
      currency: "KRW",
      event: {
        id: "",
        date: "2026-10-12",
        kind: "DEPOSIT",
        amount: 2000,
        reference: "old holding proceeds actually reassigned",
      },
      confirmed: true,
    } as const;
    await saveNewActualPortfolio(db.value, uid, cash, now);
    let view = await loadNewActualPortfolio(db.value, uid, now);
    expect(view.pools.KRW.netContributions).toBe("2000");
    expect(view.pools.KRW.cash).toBe("2000");
    expect(view.pools.KRW.totalPnl).toBe("0");
    const eventId = state.rows[kr]!.payload.newActualPortfolio!.cashEvents[0]!.id;
    await saveNewActualPortfolio(
      db.value,
      uid,
      {
        ...cash,
        expectedRevision: 5,
        requestId: "00000000-0000-4000-8000-000000000071",
        event: { ...cash.event, id: eventId, amount: 2500 },
      },
      now,
    );
    expect(state.rows[kr]!.payload.newActualPortfolio!.audit[1]!.before!.cashEvent!.amount).toBe(
      2000,
    );
    await saveNewActualPortfolio(
      db.value,
      uid,
      {
        accessToken: "synthetic",
        action: "cancelCash",
        expectedRevision: 6,
        requestId: "00000000-0000-4000-8000-000000000072",
        currency: "KRW",
        eventId,
        reason: "입금 자료 정정",
      },
      now,
    );
    view = await loadNewActualPortfolio(db.value, uid, now);
    expect(view.pools.KRW.cash).toBeNull();
    expect(state.rows[kr]!.payload.newActualPortfolio!.cashEvents[0]!.voided).toBe(true);
  });
  it("retains actual fill on price outages and leaves valuations unavailable", async () => {
    const db = client();
    await saveNewActualPortfolio(db.value, uid, buy(), now);
    state.quoteError = true;
    const view = await loadNewActualPortfolio(db.value, uid, now);
    expect(view.pools.KRW.trades).toHaveLength(1);
    expect(view.pools.KRW.nav).toBeNull();
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).not.toContain("private");
  });
  it("rejects uniformly stale marks even when no held ticker has a newer quote", async () => {
    const db = client();
    await saveNewActualPortfolio(db.value, uid, buy(), now);
    await saveNewActualPortfolio(
      db.value,
      uid,
      {
        accessToken: "synthetic",
        action: "cash",
        expectedRevision: 5,
        requestId: "00000000-0000-4000-8000-000000000099",
        currency: "KRW",
        event: {
          id: "",
          date: "2026-10-12",
          kind: "DEPOSIT",
          amount: 2000,
          reference: "funding-stale-test",
        },
        confirmed: true,
      },
      now,
    );
    state.quotes = { "005930": { price: 110, date: "2026-10-12", exitSignal: null } };
    const view = await loadNewActualPortfolio(db.value, uid, "2026-10-20T08:00:00Z");
    expect(view.pools.KRW.nav).toBeNull();
    expect(view.pools.KRW.returnPercent).toBeNull();
    expect(view.pools.KRW.issues).toContain("stale_price");
    expect(view.pools.KRW.cash).toBe("999");
    expect(view.pools.KRW.positions[0]!.quantity).toBe("10");
  });
  it("sends US fills to USD owner table and keeps KR/ETF untouched", async () => {
    const before = structuredClone(state.rows[kr]),
      db = client();
    const request = buy({ asset: "US", expectedRevision: 7 });
    if (request.action !== "execution") throw Error();
    request.execution.market = "US";
    request.execution.symbol = "AAPL";
    await saveNewActualPortfolio(db.value, uid, request, now);
    expect(state.rows[kr]).toEqual(before);
    const view = await loadNewActualPortfolio(db.value, uid, now);
    expect(view.pools.USD.positions[0]!.quantity).toBe("10");
    expect(view.pools.USD.cash).toBeNull();
  });
  it("rejects stale CAS, conflicts and unverifiable acknowledgement with no auto retry", async () => {
    let db = client();
    await expect(
      saveNewActualPortfolio(db.value, uid, buy({ expectedRevision: 3 }), now),
    ).rejects.toThrow(/버전/);
    expect(db.writes).toHaveLength(0);
    db = client({ conflict: true });
    await expect(saveNewActualPortfolio(db.value, uid, buy(), now)).rejects.toThrow(/동시에/);
    expect(db.writes).toHaveLength(1);
    db = client({ corrupt: true });
    await expect(saveNewActualPortfolio(db.value, uid, buy(), now)).rejects.toThrow(/재입력하지/);
    expect(db.writes).toHaveLength(1);
  });
});
