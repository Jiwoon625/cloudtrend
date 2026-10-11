import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildOperatingAnnualSizingSnapshot,
  ensureOperatingAnnualSizing,
  loadOperatingAnnualCloseEvidence,
  operatingAnnualWindow,
  type OperatingAnnualCalendar,
  type OperatingAnnualCloseEvidence,
} from "./operatingAnnualSizing.server";
import { datedOperatingSource } from "./operatingEtfSizing.server";
import {
  OPERATING_ALLOCATION_VERSION,
  pinOperatingSignalBudget,
  prepareOperatingSignalBudget,
  readOperatingSizing,
  type OperatingCashAuthority,
} from "./operatingAllocation";
import { emptyNewActualMetadata, type NewActualExecution } from "./newActualPortfolio";
import type { NewActualDocument } from "./newActualPortfolio.server";
import { regularOpenAt, regularCloseAt } from "./ledger/octoberShadowCalendar";
import { hashSeriesValue } from "./ledger/modelSeries";

const hash = `sha256:${"a".repeat(64)}` as const;
const uid = "00000000-0000-4000-8000-000000000001";
const now = "2027-01-04T23:00:00Z";
function calendar(market: "KR" | "US"): OperatingAnnualCalendar {
  return {
    calendar: {
      market,
      sourceHash: hash,
      coverageStart: "2026-12-01",
      coverageEnd: "2027-01-08",
      regularSessions: [
        "2026-12-29",
        "2026-12-30",
        ...(market === "US" ? ["2026-12-31"] : []),
        "2027-01-04",
        "2027-01-05",
      ],
    },
    openAt: regularOpenAt,
    closeAt: regularCloseAt,
  };
}
function fixture(market: "KR" | "US" = "KR") {
  const metadata = emptyNewActualMetadata();
  metadata.cashEvents.push({
    id: "fund",
    date: "2026-12-29",
    kind: "DEPOSIT",
    amount: 1000,
    reference: "fund",
  });
  const document: NewActualDocument = { executions: [], newActualPortfolio: metadata };
  const lastDate = market === "KR" ? "2026-12-30" : "2026-12-31";
  function buy(
    id: string,
    date: string,
    venue: NewActualExecution["market"],
    shares: number,
    symbol: string,
    price = 100,
  ) {
    document.executions.push({
      id,
      date,
      market: venue,
      shares,
      symbol,
      price,
      name: symbol,
      fee: 0,
      side: "BUY",
      order: document.executions.length,
      note: "",
      signalKey: null,
    });
    metadata.assignments[id] = {
      executionId: id,
      quantity: shares,
      gross: shares * price,
      fee: 0,
      brokerReference: id,
    };
  }
  buy(
    "actual-1",
    lastDate,
    market === "KR" ? "KOSPI" : "US",
    2,
    market === "KR" ? "005930" : "AAPL",
  );
  if (market === "KR") buy("actual-etf", lastDate, "ETF", 3, "123456");
  const authority: OperatingCashAuthority = {
    version: 1,
    currency: market === "KR" ? "KRW" : "USD",
    sourceRevision: 8,
    sourceFingerprint: hash,
    cashAtReview: market === "KR" ? "500" : "800",
    claims: {
      KR: market === "KR" ? "300" : "0",
      ETF: market === "KR" ? "200" : "0",
      US: market === "US" ? "800" : "0",
      UNASSIGNED: "0",
    },
    spendableCash: null,
    reservations: [],
    reviewedAt: "2027-01-01T01:00:00Z",
  };
  function review() {
    document["operatingCashHistory"] = [
      {
        authority: structuredClone(authority),
        economicSourceFingerprint: datedOperatingSource(document, "2026-12-31")
          .economicSourceFingerprint,
      },
    ];
  }
  review();
  const closeEvidence: OperatingAnnualCloseEvidence = {
    market,
    date: lastDate,
    availableAt: `${lastDate}T${market === "KR" ? "08" : "22"}:00:00Z`,
    sourceFingerprint: hash,
    prices: [
      {
        market: market === "KR" ? "KOSPI" : "US",
        symbol: market === "KR" ? "005930" : "AAPL",
        date: lastDate,
        close: 150,
      },
    ],
  };
  return {
    document,
    metadata,
    authority,
    review,
    buy,
    closeEvidence,
    market,
    year: 2027,
    now,
    calendar: calendar(market),
  };
}

describe("actual native-currency annual NAV renewal", () => {
  it("uses the KR sleeve's cash and holdings at the final official close, without ETF capital", async () => {
    const f = fixture();
    const before = structuredClone(f.document);
    const snapshot = await buildOperatingAnnualSizingSnapshot(f);
    expect(snapshot).toMatchObject({
      market: "KR",
      currency: "KRW",
      year: 2027,
      nav: "600",
      valuationDate: "2026-12-30",
      firstSessionAt: "2027-01-04T00:00:00Z",
      basis: "PRIOR_YEAR_MARKET_NAV",
    });
    expect(
      prepareOperatingSignalBudget({ id: "new-2027", snapshot, signalDate: "2027-01-04" }).amount,
    ).toBe("20");
    expect(f.document).toEqual(before);
  });
  it("keeps US NAV and NAV/20 in actual dollars with no Shadow or KRW conversion", async () => {
    const f = fixture("US");
    f.document["initialCapital"] = 12_000_000;
    f.document["shadowUsd"] = 999999;
    f.document["usdKrw"] = 1440;
    const snapshot = await buildOperatingAnnualSizingSnapshot(f);
    expect(snapshot).toMatchObject({
      currency: "USD",
      nav: "1100",
      valuationDate: "2026-12-31",
      nativeAllocationEvidence: null,
    });
    expect(
      prepareOperatingSignalBudget({ id: "new-us", snapshot, signalDate: "2027-01-04" }),
    ).toMatchObject({ amount: "55", currency: "USD", feeTreatment: "GROSS_PLUS_FEE" });
  });
  it.each(["KR", "US"] as const)(
    "excludes future %s fills and cash before quantity and cash reconstruction",
    async (market) => {
      const f = fixture(market);
      const baseline = await buildOperatingAnnualSizingSnapshot(f);
      f.buy(
        "new-year-fill",
        "2027-01-04",
        market === "KR" ? "KOSPI" : "US",
        3,
        market === "KR" ? "005930" : "AAPL",
      );
      f.metadata.cashEvents.push({
        id: "future-funding",
        date: "2027-01-04",
        kind: "DEPOSIT",
        amount: 5000,
        reference: "future-funding",
      });
      expect(await buildOperatingAnnualSizingSnapshot(f)).toEqual(baseline);
    },
  );
  it("includes year-end non-session cash using matching dated ownership evidence", async () => {
    const f = fixture();
    f.metadata.cashEvents.push({
      id: "year-end-cash",
      date: "2026-12-31",
      kind: "DEPOSIT",
      amount: 100,
      reference: "year-end-cash",
    });
    f.authority.cashAtReview = "600";
    f.authority.claims.KR = "400";
    f.review();
    expect((await buildOperatingAnnualSizingSnapshot(f)).nav).toBe("700");
  });
  it("does not treat a non-session fill as a valid year-end holding", async () => {
    const f = fixture();
    f.buy("holiday-fill", "2026-12-31", "KOSPI", 1, "005930");
    f.authority.cashAtReview = "400";
    f.authority.claims.KR = "200";
    f.review();
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(
      /after the last market session/,
    );
  });
  it("holds for an old fill entered after the first session, even if its effective date is old", async () => {
    const f = fixture();
    f.buy("late-old-fill", "2026-12-30", "KOSPI", 1, "005930");
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(/ownership evidence/);
    f.authority.cashAtReview = "400";
    f.authority.claims.KR = "200";
    f.authority.reviewedAt = "2027-01-04T00:01:00Z";
    f.review();
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(/ownership evidence/);
  });
  it("does not reuse a pre-opening cash review after a historical fill correction", async () => {
    const f = fixture();
    f.document.executions[0]!.price = 101;
    f.metadata.assignments["actual-1"]!.gross = 202;
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(/ownership evidence/);
  });
  it("never substitutes current claims when historical claims are missing", async () => {
    const f = fixture();
    f.document["operatingCashHistory"] = [];
    f.document["operatingCashAuthority"] = f.authority;
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(/ownership evidence/);
  });
  it("requires cash claims to reconcile to the exact dated actual source", async () => {
    const f = fixture();
    f.authority.cashAtReview = "501";
    f.authority.claims.KR = "301";
    f.review();
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(/does not reconcile/);
  });
  it("rejects cross-currency journal allocations", async () => {
    const f = fixture();
    f.buy("wrong-currency", "2026-12-30", "US", 1, "MSFT");
    f.review();
    await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(
      /outside the owner currency pool/,
    );
  });
  it.each(["missing", "null", "stale", "future", "zero", "duplicate"] as const)(
    "waits when a required final-session price is %s",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.closeEvidence.prices = [];
      if (kind === "null") f.closeEvidence.prices[0]!.close = null;
      if (kind === "stale") f.closeEvidence.prices[0]!.date = "2026-12-29";
      if (kind === "future") f.closeEvidence.prices[0]!.date = "2027-01-04";
      if (kind === "zero") f.closeEvidence.prices[0]!.close = 0;
      if (kind === "duplicate") f.closeEvidence.prices.push({ ...f.closeEvidence.prices[0]! });
      await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(
        /exact final-session close missing/,
      );
    },
  );
  it.each(["2026-12-30T05:00:00Z", "2027-01-04T00:00:00Z", "2027-01-04T01:00:00Z"])(
    "rejects incomplete/late annual price publication at %s",
    async (availableAt) => {
      const f = fixture();
      f.closeEvidence.availableAt = availableAt;
      await expect(buildOperatingAnnualSizingSnapshot(f)).rejects.toThrow(/available completed/);
    },
  );
  it("cannot pre-freeze a year-end NAV before the economic year has ended", async () => {
    const f = fixture();
    await expect(
      buildOperatingAnnualSizingSnapshot({ ...f, now: "2026-12-30T10:00:00Z" }),
    ).rejects.toThrow(/before year end/);
  });
  it("rejects an availableAt in the future relative to the server clock", async () => {
    const f = fixture();
    f.closeEvidence.availableAt = "2027-01-03T10:00:00Z";
    await expect(
      buildOperatingAnnualSizingSnapshot({ ...f, now: "2027-01-02T10:00:00Z" }),
    ).rejects.toThrow(/available completed/);
  });
  it("fails closed with current official calendar coverage, before any source read", async () => {
    const f = fixture();
    const loadCloseEvidence = vi.fn();
    await expect(
      ensureOperatingAnnualSizing(
        { ...f, uid, client: {} as SupabaseClient, sizing: readOperatingSizing(undefined) },
        { loadCloseEvidence },
      ),
    ).rejects.toThrow(/calendar.*cover/);
    expect(loadCloseEvidence).not.toHaveBeenCalled();
  });
  it.each([
    "wrong-market",
    "partial-december",
    "no-first-session",
    "no-final-session",
    "duplicate",
  ] as const)("rejects incomplete or ambiguous calendar evidence: %s", async (kind) => {
    const c = calendar("KR");
    if (kind === "wrong-market") c.calendar.market = "US";
    if (kind === "partial-december") c.calendar.coverageStart = "2026-12-31";
    if (kind === "no-first-session") c.calendar.regularSessions = ["2026-12-30"];
    if (kind === "no-final-session") c.calendar.regularSessions = ["2027-01-04"];
    if (kind === "duplicate") c.calendar.regularSessions.push("2026-12-30");
    await expect(operatingAnnualWindow("KR", 2027, c)).rejects.toThrow(/calendar/);
  });
  it("adds only the new annual snapshot and preserves old pending budgets byte-for-byte", async () => {
    const f = fixture();
    const old = {
      id: `${OPERATING_ALLOCATION_VERSION}:KR:2026`,
      market: "KR" as const,
      currency: "KRW" as const,
      year: 2026,
      nav: "12000000",
      basis: "APPROVED_INITIAL_NATIVE_ALLOCATION" as const,
      valuationDate: "2026-10-11",
      availableAt: "2026-10-11T12:00:00Z",
      firstSessionAt: "2026-10-12T00:00:00Z",
      sourceFingerprint: hash,
      valuationComplete: true as const,
      calendarEvidence: hash,
      nativeAllocationEvidence: null,
    };
    const pending = prepareOperatingSignalBudget({
      id: "old-pending",
      snapshot: old,
      signalDate: "2026-12-29",
    });
    const sizing = pinOperatingSignalBudget(
      readOperatingSizing({
        version: 1,
        annualSnapshots: [old],
        signalBudgets: [],
        etfSnapshots: [],
      }),
      pending,
    );
    const loadCloseEvidence = vi.fn(async () => f.closeEvidence);
    const input = { ...f, uid, client: {} as SupabaseClient, sizing };
    const renewed = await ensureOperatingAnnualSizing(input, {
      calendar: f.calendar,
      loadCloseEvidence,
    });
    expect(renewed.signalBudgets).toEqual(sizing.signalBudgets);
    expect(renewed.annualSnapshots[0]).toEqual(sizing.annualSnapshots[0]);
    expect(renewed.annualSnapshots[1]!.nav).toBe("600");
    expect(sizing.annualSnapshots).toHaveLength(1);
    const neverRead = vi.fn(async () => {
      throw new Error("Do not revalue frozen NAV");
    });
    f.document.executions[0]!.price = 999;
    expect(
      await ensureOperatingAnnualSizing(
        { ...input, sizing: renewed },
        { loadCloseEvidence: neverRead },
      ),
    ).toEqual(renewed);
    expect(neverRead).not.toHaveBeenCalled();
  });
  it("does not create replacement initial capital when a 2026 basis is missing", async () => {
    const f = fixture();
    await expect(
      ensureOperatingAnnualSizing({
        ...f,
        year: 2026,
        uid,
        client: {} as SupabaseClient,
        sizing: readOperatingSizing(undefined),
      }),
    ).rejects.toThrow(/subsequent/);
  });
});

function readClient(rows: Record<string, unknown[]>, objects: Record<string, unknown> = {}) {
  const queries: { table: string; filters: [string, unknown][] }[] = [];
  const downloads: string[] = [];
  const client = {
    from(table: string) {
      const call = { table, filters: [] as [string, unknown][] };
      queries.push(call);
      const result = () => ({ data: structuredClone(rows[table] ?? []), error: null });
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          call.filters.push([key, value]);
          return query;
        },
        like: (key: string, value: unknown) => {
          call.filters.push([key, value]);
          return query;
        },
        lt: (key: string, value: unknown) => {
          call.filters.push([key, value]);
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return query;
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe("cloudtrend-data");
        return {
          download: async (path: string) => {
            downloads.push(path);
            return {
              data: objects[path] ? new Blob([JSON.stringify(objects[path])]) : null,
              error: null,
            };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { client, queries, downloads };
}
async function krRow() {
  const payload = {
    version: "kr-daily-inputs-v1",
    date: "2026-12-30",
    inputs: {
      bars: { "005930": [{ tradeDate: "2026-12-30", close: 150 }] },
      markets: { "005930": "KOSPI" },
    },
  };
  const source_hash = await hashSeriesValue(payload);
  return {
    payload,
    source_hash,
    source_id: `october-input:KR:2026-12-30:${source_hash.slice(7)}`,
    source_revision: "1",
    recorded_at: "2026-12-30T08:00:00Z",
  };
}
function usSource() {
  return {
    marker: {
      date: "2026-12-31",
      rule_version: "same-rule",
      data_hash: hash,
      created_at: "2026-12-31T22:10:00Z",
    },
    result: {
      dataHash: hash,
      generatedAt: "2026-12-31T22:00:00Z",
      source: { collectedAt: "2026-12-31T21:30:00Z" },
      analysis: {
        date: "2026-12-31",
        ruleVersion: "same-rule",
        rows: [{ symbol: "AAPL", date: "2026-12-31", close: 150 }],
      },
    },
  };
}

describe("immutable annual price source adapter", () => {
  it("uses owner-scoped content-addressed KR bars and real recorded_at, without model balances", async () => {
    const row = await krRow();
    const store = readClient({ ledger_provenance_archive: [row] });
    const window = await operatingAnnualWindow("KR", 2027, calendar("KR"));
    const evidence = await loadOperatingAnnualCloseEvidence(store.client, uid, window);
    expect(evidence).toMatchObject({
      market: "KR",
      date: "2026-12-30",
      availableAt: row.recorded_at,
      prices: [{ market: "KOSPI", symbol: "005930", date: "2026-12-30", close: 150 }],
    });
    expect(store.queries).toEqual([
      {
        table: "ledger_provenance_archive",
        filters: [
          ["user_id", uid],
          ["source_revision", "1"],
          ["source_id", "october-input:KR:2026-12-30:%"],
          ["recorded_at", window.firstSessionAt],
        ],
      },
    ]);
    expect(store.downloads).toEqual([]);
    expect(
      (await buildOperatingAnnualSizingSnapshot({ ...fixture(), closeEvidence: evidence })).nav,
    ).toBe("600");
  });
  it.each(["missing", "ambiguous", "hash", "identity", "date", "early", "late"] as const)(
    "rejects KR archive evidence that is %s",
    async (kind) => {
      const row = await krRow();
      if (kind === "hash") row.payload.inputs.bars["005930"][0]!.close = 999;
      if (kind === "identity") row.source_id = "other-owner-result";
      if (kind === "date") {
        row.payload.date = "2026-12-29";
        row.source_hash = await hashSeriesValue(row.payload);
        row.source_id = `october-input:KR:2026-12-30:${row.source_hash.slice(7)}`;
      }
      if (kind === "early") row.recorded_at = "2026-12-30T05:00:00Z";
      if (kind === "late") row.recorded_at = "2027-01-04T00:00:00Z";
      const store = readClient({
        ledger_provenance_archive:
          kind === "missing" ? [] : kind === "ambiguous" ? [row, row] : [row],
      });
      const window = await operatingAnnualWindow("KR", 2027, calendar("KR"));
      await expect(loadOperatingAnnualCloseEvidence(store.client, uid, window)).rejects.toThrow(
        /annual|Annual|Immutable/,
      );
    },
  );
  it("requires the US completion marker and downloads its exact immutable dated result", async () => {
    const { marker, result } = usSource();
    const path = `${uid}/results/us-screening/2026-12-31.json`;
    const store = readClient({ us_screening_history: [marker] }, { [path]: result });
    const window = await operatingAnnualWindow("US", 2027, calendar("US"));
    const evidence = await loadOperatingAnnualCloseEvidence(store.client, uid, window);
    expect(evidence.availableAt).toBe(marker.created_at);
    expect(store.queries).toEqual([
      {
        table: "us_screening_history",
        filters: [
          ["user_id", uid],
          ["date", "2026-12-31"],
        ],
      },
    ]);
    expect(store.downloads).toEqual([path]);
    expect(
      (await buildOperatingAnnualSizingSnapshot({ ...fixture("US"), closeEvidence: evidence })).nav,
    ).toBe("1100");
  });
  it.each([
    "missing-marker",
    "late-marker",
    "missing-file",
    "hash",
    "rule",
    "date",
    "row-date",
    "late-source",
    "late-generated",
  ] as const)("rejects US dated evidence that is %s", async (kind) => {
    const { marker, result } = usSource();
    if (kind === "late-marker") marker.created_at = "2027-01-04T14:30:00Z";
    if (kind === "hash") result.dataHash = `sha256:${"b".repeat(64)}`;
    if (kind === "rule") result.analysis.ruleVersion = "other-rule";
    if (kind === "date") result.analysis.date = "2027-01-04";
    if (kind === "row-date") result.analysis.rows[0]!.date = "2027-01-04";
    if (kind === "late-source") result.source.collectedAt = "2027-01-04T14:30:00Z";
    if (kind === "late-generated") result.generatedAt = "2027-01-04T14:30:00Z";
    const path = `${uid}/results/us-screening/2026-12-31.json`;
    const store = readClient(
      { us_screening_history: kind === "missing-marker" ? [] : [marker] },
      kind === "missing-file" ? {} : { [path]: result },
    );
    const window = await operatingAnnualWindow("US", 2027, calendar("US"));
    await expect(loadOperatingAnnualCloseEvidence(store.client, uid, window)).rejects.toThrow(
      /annual/,
    );
    if (kind === "missing-marker" || kind === "late-marker") expect(store.downloads).toEqual([]);
  });
});
