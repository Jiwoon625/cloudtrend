import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emptyNewActualMetadata } from "./newActualPortfolio";
import { prepareOperatingCapitalPlan } from "./operatingCapitalPlan";
import {
  OPERATING_ALLOCATION_ERRORS as errors,
  prepareOperatingAllocation,
  prepareOperatingSignalBudget,
  type AnnualSizingSnapshot,
  type OperatingAllocationRequest,
} from "./operatingAllocation";
import { loadOperatingAllocation, writeOperatingAllocation } from "./operatingAllocation.server";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, { revision: number; payload: Record<string, unknown> }>,
  reads: [] as string[],
  index: null as import("./dashboardOperations").DashboardIndex | null,
  positions: [] as import("./dashboardOperations").DashboardHolding[],
}));
vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (_: unknown, uid: string, table: string) => {
    state.reads.push(`${uid}:${table}`);
    return structuredClone(state.rows[table] ?? null);
  },
}));
vi.mock("./dashboardOperations.server", () => ({ projection: async () => state.index }));
vi.mock("./websitePositionContext.server", async (original) => ({
  ...(await original<typeof import("./websitePositionContext.server")>()),
  loadActualPositionContextForOwner: async () => ({
    positions: state.positions,
    actualExecutions: [],
  }),
}));
const uid = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-12T15:00:00Z";
type Write = Exclude<OperatingAllocationRequest, { action: "load" }>;
function request(change: Write["change"], overrides: Partial<Write> = {}): Write {
  return {
    action: "save",
    accessToken: "synthetic",
    currency: "KRW",
    expectedRevision: 9,
    requestId: "00000000-0000-4000-8000-000000000010",
    reviewConfirmed: true,
    change,
    ...overrides,
  } as Write;
}
function client(mode: "ok" | "conflict" | "corrupt" | "backend" = "ok") {
  const writes: {
    table: string;
    value: { revision: number; payload: Record<string, unknown> };
    filters: [string, unknown][];
  }[] = [];
  return {
    writes,
    value: {
      from(table: string) {
        let value: { revision: number; payload: Record<string, unknown> };
        const filters: [string, unknown][] = [];
        const q = {
          update(v: typeof value) {
            value = v;
            return q;
          },
          eq(k: string, v: unknown) {
            filters.push([k, v]);
            return q;
          },
          select() {
            return q;
          },
          async maybeSingle() {
            writes.push({ table, value, filters });
            if (mode === "backend") return { data: null, error: { message: "private backend" } };
            if (
              mode === "conflict" ||
              state.rows[table]?.revision !== filters.find(([key]) => key === "revision")?.[1]
            )
              return { data: null, error: null };
            state.rows[table] = structuredClone(value);
            if (mode === "corrupt") state.rows[table]!.payload["corrupted"] = true;
            return { data: { revision: value.revision }, error: null };
          },
        };
        return q;
      },
    } as unknown as SupabaseClient,
  };
}
function funded(table = "portfolio_ledgers") {
  const metadata = emptyNewActualMetadata();
  metadata.cashEvents.push({
    id: "funding-1",
    kind: "DEPOSIT",
    date: "2026-10-12",
    amount: 1000,
    reference: "broker-cash",
  });
  state.rows[table]!.payload["newActualPortfolio"] = metadata;
  if (table === "portfolio_ledgers") {
    state.index = {
      date: "2026-10-12",
      tradeDates: ["2026-10-12"],
      rows: [
        {
          symbol: "123456",
          name: "Test",
          market: "KOSDAQ",
          sector: "Test",
          sectorCode: "G10",
          date: "2026-10-12",
          price: 100,
          score: 8,
          priority: 1,
          onset: true,
          exitReason: null,
        },
      ],
    };
    const snapshot: AnnualSizingSnapshot = {
      id: "kr-2026",
      market: "KR",
      currency: "KRW",
      year: 2026,
      nav: "12000000",
      basis: "APPROVED_INITIAL_NATIVE_ALLOCATION",
      valuationDate: "2026-10-11",
      availableAt: "2026-10-11T12:00:00Z",
      firstSessionAt: "2026-10-12T00:00:00Z",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      valuationComplete: true,
      calendarEvidence: "kr-calendar",
      nativeAllocationEvidence: null,
    };
    state.rows[table]!.payload["operatingSizing"] = {
      version: 1,
      annualSnapshots: [snapshot],
      signalBudgets: [
        prepareOperatingSignalBudget({ id: "budget-1", snapshot, signalDate: "2026-10-12" }),
        prepareOperatingSignalBudget({ id: "budget-2", snapshot, signalDate: "2026-10-12" }),
      ],
    };
    const sizing = state.rows[table]!.payload["operatingSizing"] as {
      signalBudgets: import("./operatingAllocation").OperatingSignalBudget[];
    };
    for (const budget of sizing.signalBudgets)
      budget.security = {
        symbol: budget.id === "budget-1" ? "123456" : "234567",
        venue: "KOSDAQ",
        sector: "Test",
        sectorCode: "G10",
        originDate: budget.signalDate,
        decisionDate: budget.decisionDate!,
        sourceDate: budget.decisionDate!,
        sourceFingerprint: budget.sourceFingerprint!,
      };
  }
}
const claims: Write["change"] = {
  kind: "REVIEW_CLAIMS",
  claims: { KR: "600", ETF: "300", US: "0", UNASSIGNED: "100" },
  spendableCash: { amount: "1000", availableAt: now, reference: "verified-broker-cash" },
};
const reserve: Write["change"] = {
  kind: "RESERVE",
  reservation: {
    id: "order-1",
    signalId: "budget-1",
    market: "KR",
    currency: "KRW",
    amount: "500.75",
    signalBudgetId: "budget-1",
  },
};
beforeEach(() => {
  state.reads = [];
  state.index = null;
  state.positions = [];
  state.rows = {
    portfolio_ledgers: {
      revision: 9,
      payload: {
        executions: [],
        settings: { initialCapital: 111 },
        actualCapital: 999,
        operatingCapitalPlan: prepareOperatingCapitalPlan("12345", "2026-10-09T00:00:00Z"),
        actualPerformance: { baseline: null },
        unknown: { preserve: true },
      },
    },
    us_actual_portfolio_ledgers: {
      revision: 7,
      payload: { executions: [], settings: { initialCapital: 222 }, actualCapital: 777 },
    },
  };
});
describe("same-document actual allocation CAS", () => {
  it("loads no invented cash or allocation and does not create a missing journal", async () => {
    const c = client();
    const result = await loadOperatingAllocation(c.value, uid, "KRW", now);
    expect(result.plan).toBeNull();
    expect(result.cash).toBeNull();
    expect(result.authority).toBeNull();
    delete state.rows["portfolio_ledgers"];
    expect((await loadOperatingAllocation(c.value, uid, "KRW", now)).revision).toBeNull();
    await expect(
      writeOperatingAllocation(c.value, uid, request({ kind: "CONFIRM_PLAN" }), now),
    ).rejects.toThrow(errors.missing);
    expect(c.writes).toHaveLength(0);
  });
  it("saves approved policy without changing the immutable v1 plan, money or any other journal field", async () => {
    const c = client(),
      before = structuredClone(state.rows);
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request({ kind: "CONFIRM_PLAN" }),
      now,
    );
    expect(result.plan?.totalKrw).toBe("30000000");
    expect(result.cash).toBeNull();
    const {
      operatingAllocation: _,
      operatingAllocationAudit: _audit,
      operatingSizing: _sizing,
      ...rest
    } = state.rows["portfolio_ledgers"]!.payload;
    expect(rest).toEqual(before["portfolio_ledgers"]!.payload);
    expect(state.rows["us_actual_portfolio_ledgers"]).toEqual(
      before["us_actual_portfolio_ledgers"],
    );
    expect(c.writes[0]!.filters).toEqual([
      ["user_id", uid],
      ["revision", 9],
    ]);
  });
  it("preview reads the candidate without a write", async () => {
    const c = client(),
      before = structuredClone(state.rows);
    const { reviewConfirmed: _review, ...input } = request({ kind: "CONFIRM_PLAN" }) as Extract<
      Write,
      { action: "save" }
    >;
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      { ...input, action: "preview" },
      now,
    );
    expect(result.plan?.candidateId).toBe("S06");
    expect(result.revision).toBe(9);
    expect(state.rows).toEqual(before);
    expect(c.writes).toEqual([]);
  });
  it("recognizes exact lost-response retry without requiring the outdated revision", async () => {
    const c = client(),
      input = request({ kind: "CONFIRM_PLAN" });
    await writeOperatingAllocation(c.value, uid, input, now);
    expect((await writeOperatingAllocation(c.value, uid, input, now)).reused).toBe(true);
    expect(c.writes).toHaveLength(1);
    await expect(writeOperatingAllocation(c.value, uid, request(claims), now)).rejects.toThrow(
      errors.conflict,
    );
  });
  it("cannot interpret plan approval as a USD funding event", async () => {
    const c = client();
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request({ kind: "CONFIRM_PLAN" }, { currency: "USD", expectedRevision: 7 }),
        now,
      ),
    ).rejects.toThrow(errors.input);
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    await expect(writeOperatingAllocation(c.value, uid, request(claims), now)).rejects.toThrow(
      errors.funding,
    );
    expect(c.writes).toEqual([]);
  });
  it("reviews only confirmed actual cash, then reserves within the same KRW document", async () => {
    const c = client();
    funded();
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    const original = structuredClone(
      state.rows["portfolio_ledgers"]!.payload["newActualPortfolio"],
    );
    const reviewed = await writeOperatingAllocation(c.value, uid, request(claims), now);
    expect(reviewed.availability.status).toBe("CONFIRMED_CASH");
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request(reserve, { expectedRevision: 10, requestId: "00000000-0000-4000-8000-000000000011" }),
      now,
    );
    expect(result.availability.available.KR).toBe("99.25");
    expect(result.authority?.reservations[0]?.security).toMatchObject({
      symbol: "123456",
      venue: "KOSDAQ",
      originDate: "2026-10-12",
    });
    expect(result.availability.available.ETF).toBe("300");
    expect(result.cash).toBe("1000");
    expect(state.rows["portfolio_ledgers"]!.payload["newActualPortfolio"]).toEqual(original);
    expect(c.writes.every((write) => write.table === "portfolio_ledgers")).toBe(true);
  });
  it("does not double-reserve under a same-revision race", async () => {
    const c = client();
    funded();
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    await writeOperatingAllocation(c.value, uid, request(claims), now);
    const results = await Promise.allSettled([
      writeOperatingAllocation(
        c.value,
        uid,
        request(reserve, {
          expectedRevision: 10,
          requestId: "00000000-0000-4000-8000-000000000011",
        }),
        now,
      ),
      writeOperatingAllocation(
        c.value,
        uid,
        request(
          {
            kind: "RESERVE",
            reservation: {
              ...reserve.reservation,
              id: "order-2",
            },
          },
          { expectedRevision: 10, requestId: "00000000-0000-4000-8000-000000000012" },
        ),
        now,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (await loadOperatingAllocation(c.value, uid, "KRW", now)).authority?.reservations,
    ).toHaveLength(1);
  });
  it.each([
    "missing-budget",
    "missing-security",
    "wrong-signal",
    "wrong-amount",
    "stale-candidate",
    "unconfirmed-cash",
  ])("rejects an unverified reservation: %s", async (mode) => {
    const c = client();
    funded();
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    await writeOperatingAllocation(
      c.value,
      uid,
      request(mode === "unconfirmed-cash" ? { ...claims, spendableCash: null } : claims),
      now,
    );
    const change = structuredClone(reserve);
    if (mode === "missing-budget") change.reservation.signalBudgetId = "unverified";
    if (mode === "wrong-signal") change.reservation.signalId = "unverified";
    if (mode === "wrong-amount") change.reservation.amount = "500";
    if (mode === "stale-candidate") state.index!.rows[0]!.onset = false;
    if (mode === "missing-security") {
      const sizing = state.rows["portfolio_ledgers"]!.payload[
        "operatingSizing"
      ] as import("./operatingAllocation").OperatingSizing;
      delete sizing.signalBudgets[0]!.security;
    }
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(change, {
          expectedRevision: 10,
          requestId: "00000000-0000-4000-8000-000000000011",
        }),
        now,
      ),
    ).rejects.toThrow();
    expect(c.writes).toHaveLength(1);
  });
  it("rejects client-supplied reservation security before writing", async () => {
    const c = client();
    funded();
    const raw = structuredClone(request(reserve)) as unknown as {
      change: { reservation: Record<string, unknown> };
    };
    raw.change.reservation["security"] = { symbol: "forged" };
    await expect(
      writeOperatingAllocation(c.value, uid, raw as unknown as Write, now),
    ).rejects.toThrow();
    expect(c.writes).toEqual([]);
  });
  it("blocks reservations after any underlying source correction until claims are reviewed again", async () => {
    const c = client();
    funded();
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    await writeOperatingAllocation(c.value, uid, request(claims), now);
    const metadata = state.rows["portfolio_ledgers"]!.payload["newActualPortfolio"] as ReturnType<
      typeof emptyNewActualMetadata
    >;
    metadata.cashEvents[0]!.reference = "corrected-source-same-amount";
    state.rows["portfolio_ledgers"]!.revision++;
    expect((await loadOperatingAllocation(c.value, uid, "KRW", now)).availability.status).toBe(
      "RECONCILIATION_REQUIRED",
    );
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(reserve, {
          expectedRevision: 11,
          requestId: "00000000-0000-4000-8000-000000000011",
        }),
        now,
      ),
    ).rejects.toThrow(errors.reconcile);
    expect(
      (
        await writeOperatingAllocation(
          c.value,
          uid,
          request(claims, {
            expectedRevision: 11,
            requestId: "00000000-0000-4000-8000-000000000012",
          }),
          now,
        )
      ).availability.status,
    ).toBe("CONFIRMED_CASH");
  });
  it("never uses KRW cash to support a USD reservation", async () => {
    const c = client();
    funded();
    funded("us_actual_portfolio_ledgers");
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    const before = structuredClone(state.rows["portfolio_ledgers"]);
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request(
        {
          kind: "REVIEW_CLAIMS",
          claims: { KR: "0", ETF: "0", US: "800", UNASSIGNED: "200" },
          spendableCash: null,
        },
        { currency: "USD", expectedRevision: 7 },
      ),
      now,
    );
    expect(result.availability.available).toEqual({ KR: null, ETF: null, US: "800" });
    expect(state.rows["portfolio_ledgers"]).toEqual(before);
    expect(c.writes[0]!.table).toBe("us_actual_portfolio_ledgers");
  });
  it.each(["conflict", "corrupt", "backend"] as const)("fails closed on %s", async (mode) => {
    const c = client(mode);
    await expect(
      writeOperatingAllocation(c.value, uid, request({ kind: "CONFIRM_PLAN" }), now),
    ).rejects.toThrow(
      mode === "conflict"
        ? errors.conflict
        : mode === "corrupt"
          ? errors.uncertain
          : errors.generic,
    );
  });
  it("releases an explicit reservation without changing money", async () => {
    const c = client();
    funded();
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation(now);
    await writeOperatingAllocation(c.value, uid, request(claims), now);
    await writeOperatingAllocation(
      c.value,
      uid,
      request(reserve, { expectedRevision: 10, requestId: "00000000-0000-4000-8000-000000000011" }),
      now,
    );
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request(
        { kind: "RELEASE", reservationId: "order-1" },
        { expectedRevision: 11, requestId: "00000000-0000-4000-8000-000000000012" },
      ),
      now,
    );
    expect(result.cash).toBe("1000");
    expect(result.authority?.reservations).toEqual([]);
    expect(result.availability.available.KR).toBe("600");
  });
  it("pins only the approved first-year KR basis and waits for dated ETF NAV without funding either pool", async () => {
    const c = client();
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request({ kind: "CONFIRM_PLAN" }),
      "2026-10-11T12:00:00Z",
    );
    expect(result.sizing.annualSnapshots.map((s) => [s.market, s.nav])).toEqual([
      ["KR", "12000000"],
    ]);
    expect(result.sizing.etfSnapshots).toEqual([]);
    expect(result.sizing.annualSnapshots.every((s) => s.currency === "KRW")).toBe(true);
    expect(result.cash).toBeNull();
    expect(result.authority).toBeNull();
    expect(result.sizing.signalBudgets).toEqual([]);
  });
  it("registers a late first-year KR basis only for subsequent confirmed signals", async () => {
    const c = client();
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request({ kind: "CONFIRM_PLAN" }),
      "2026-10-12T01:00:00Z",
    );
    const snapshot = result.sizing.annualSnapshots[0]!;
    expect(snapshot.firstSessionAt).toBe("2026-10-13T00:00:00Z");
    expect(snapshot.nav).toBe("12000000");
    expect(result.cash).toBeNull();
    expect(() =>
      prepareOperatingSignalBudget({ id: "old", snapshot, signalDate: "2026-10-12" }),
    ).toThrow();
    expect(
      prepareOperatingSignalBudget({
        id: "new",
        snapshot,
        signalDate: "2026-10-12",
        decisionDate: "2026-10-13",
      }).amount,
    ).toBe("400000");
  });
  it("verifies the stored READY signal and derives its budget instead of trusting client sizing", async () => {
    const c = client();
    await writeOperatingAllocation(
      c.value,
      uid,
      request({ kind: "CONFIRM_PLAN" }),
      "2026-10-11T12:00:00Z",
    );
    state.index = {
      date: "2026-10-12",
      tradeDates: ["2026-10-12"],
      rows: [
        {
          symbol: "123456",
          name: "Test",
          market: "KOSDAQ",
          sector: "Test",
          date: "2026-10-12",
          price: 100,
          score: 8,
          priority: 1,
          reason: "onset",
          onset: true,
          exitReason: null,
        } as import("./dashboardOperations").DashboardIndexRow,
      ],
    };
    const change: Write["change"] = {
      kind: "PIN_SIGNAL_BUDGET",
      market: "KOSDAQ",
      symbol: "123456",
      signalOriginDate: "2026-10-12",
      sourceDate: "2026-10-12",
    };
    const preview = await writeOperatingAllocation(
      c.value,
      uid,
      {
        action: "preview",
        accessToken: "synthetic",
        currency: "KRW",
        expectedRevision: 10,
        requestId: "00000000-0000-4000-8000-000000000011",
        change,
      },
      now,
    );
    expect(preview.reviewFingerprint).toMatch(/^sha256:/);
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(change, {
          expectedRevision: 10,
          requestId: "00000000-0000-4000-8000-000000000011",
        }),
        now,
      ),
    ).rejects.toThrow(errors.conflict);
    state.index.rows[0]!.price = 101;
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(
          { ...change, reviewFingerprint: preview.reviewFingerprint! },
          {
            expectedRevision: 10,
            requestId: "00000000-0000-4000-8000-000000000011",
          },
        ),
        now,
      ),
    ).rejects.toThrow(errors.conflict);
    state.index.rows[0]!.price = 100;
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request(
        { ...change, reviewFingerprint: preview.reviewFingerprint! },
        {
          expectedRevision: 10,
          requestId: "00000000-0000-4000-8000-000000000011",
        },
      ),
      now,
    );
    expect(result.sizing.signalBudgets[0]?.amount).toBe("400000");
    expect(result.sizing.signalBudgets[0]?.signalDate).toBe("2026-10-12");
    expect(result.sizing.signalBudgets[0]?.decisionDate).toBe("2026-10-12");
    expect(result.cash).toBeNull();
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(
          { ...change, sourceDate: "2026-10-13" },
          { expectedRevision: 11, requestId: "00000000-0000-4000-8000-000000000012" },
        ),
        now,
      ),
    ).rejects.toThrow();
    state.index.rows[0]!.date = "2026-10-11";
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(change, {
          expectedRevision: 11,
          requestId: "00000000-0000-4000-8000-000000000013",
        }),
        now,
      ),
    ).rejects.toThrow(errors.input);
  });
  it("records real native USD sizing without creating cash or assuming the Shadow FX", async () => {
    const c = client();
    funded("us_actual_portfolio_ledgers");
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation("2026-10-11T12:00:00Z");
    const before = structuredClone(state.rows["us_actual_portfolio_ledgers"]!.payload);
    const change = {
      kind: "CONFIRM_USD_SIZING" as const,
      amountUsd: "900",
      fundingEventIds: ["funding-1"],
      confirmedAt: "2026-10-12T12:00:00Z",
      reference: "reviewed-native-allocation",
    };
    const result = await writeOperatingAllocation(
      c.value,
      uid,
      request(change, { currency: "USD", expectedRevision: 7 }),
      now,
    );
    expect(result.cash).toBe("1000");
    expect(result.usdSizingEvidence?.amountUsd).toBe("900");
    expect(result.usdSizingEvidence?.effectiveSessionDate).toBe("2026-10-13");
    expect(result.sizing.annualSnapshots[0]?.nav).toBe("900");
    expect(result.sizing.annualSnapshots[0]?.currency).toBe("USD");
    expect(state.rows["us_actual_portfolio_ledgers"]!.payload["newActualPortfolio"]).toEqual(
      before["newActualPortfolio"],
    );
    expect(state.rows["us_actual_portfolio_ledgers"]!.payload["executions"]).toEqual(
      before["executions"],
    );
    expect(result.plan?.plannedKrw.US).toBe("12000000");
  });
  it.each([
    { amountUsd: "1001" },
    { fundingEventIds: ["unverified"] },
    { fundingEventIds: ["funding-1", "funding-1"] },
    { confirmedAt: "2026-10-13T12:00:00Z" },
    { confirmedAt: "2026-10-11T12:00:00Z" },
  ])("rejects ungrounded native USD sizing %j", async (override) => {
    const c = client();
    funded("us_actual_portfolio_ledgers");
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation("2026-10-11T12:00:00Z");
    await expect(
      writeOperatingAllocation(
        c.value,
        uid,
        request(
          {
            kind: "CONFIRM_USD_SIZING",
            amountUsd: "900",
            fundingEventIds: ["funding-1"],
            confirmedAt: "2026-10-12T12:00:00Z",
            reference: "native-evidence",
            ...override,
          },
          { currency: "USD", expectedRevision: 7 },
        ),
        now,
      ),
    ).rejects.toThrow();
    expect(c.writes).toEqual([]);
  });
  it("blocks native sizing when its original funding evidence changes", async () => {
    const c = client();
    funded("us_actual_portfolio_ledgers");
    state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] =
      prepareOperatingAllocation("2026-10-11T12:00:00Z");
    await writeOperatingAllocation(
      c.value,
      uid,
      request(
        {
          kind: "CONFIRM_USD_SIZING",
          amountUsd: "900",
          fundingEventIds: ["funding-1"],
          confirmedAt: "2026-10-12T12:00:00Z",
          reference: "native-evidence",
        },
        { currency: "USD", expectedRevision: 7 },
      ),
      now,
    );
    const metadata = state.rows["us_actual_portfolio_ledgers"]!.payload[
      "newActualPortfolio"
    ] as ReturnType<typeof emptyNewActualMetadata>;
    metadata.cashEvents[0]!.amount = 500;
    const result = await loadOperatingAllocation(c.value, uid, "USD", now);
    expect(result.sizingIssues).toEqual(["USD_FUNDING_EVIDENCE_CHANGED"]);
    expect(result.sizing.annualSnapshots).toEqual([]);
    expect(result.cash).toBe("500");
  });
});

it("blocks a reservation after same-date sector classification is corrected", async () => {
  const c = client();
  funded();
  state.rows["portfolio_ledgers"]!.payload["operatingAllocation"] = prepareOperatingAllocation(now);
  await writeOperatingAllocation(c.value, uid, request(claims), now);
  state.index!.rows[0]!.sectorCode = "CORRECTED";
  await expect(
    writeOperatingAllocation(
      c.value,
      uid,
      request(reserve, { expectedRevision: 10, requestId: "00000000-0000-4000-8000-000000000011" }),
      now,
    ),
  ).rejects.toThrow(errors.conflict);
});
