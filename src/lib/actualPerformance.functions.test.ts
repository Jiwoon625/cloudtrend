import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActualPerformanceSeries,
  PerformanceBaseline,
  PerformanceObservation,
} from "./ledger/actualPerformance";
import {
  actualPerformanceServer,
  type ActualPerformanceResponse,
} from "./actualPerformance.functions";
import {
  previewReviewedActualPerformance,
  saveReviewedActualPerformance,
} from "./actualPerformance.server";

interface FakeRow {
  revision: number;
  payload: {
    executions: unknown[];
    actualCapital?: number;
    immutableFixture?: { preserve: true };
    actualPerformance?: ActualPerformanceSeries;
  };
}
const state = vi.hoisted(() => ({
  domestic: null as FakeRow | null,
  us: null as FakeRow | null,
  authError: false,
  missingUser: false,
  conflict: false,
  corruptReadback: false,
  backendError: false,
  uid: "00000000-0000-4000-8000-000000000001",
  clients: [] as unknown[],
  authTokens: [] as string[],
  reads: [] as { name: string; args: { p_user_id: string; p_source_system: string } }[],
  writes: [] as { table: string; update: FakeRow; filters: [string, unknown][] }[],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (input: unknown) => unknown) => ({
      handler: (handle: (args: { data: unknown }) => unknown) => async (args: { data: unknown }) =>
        handle({ data: validate(args.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    state.clients.push(options);
    return {
      auth: {
        getUser: async (token: string) => {
          state.authTokens.push(token);
          return {
            data: {
              user: state.missingUser
                ? null
                : { id: state.uid, user_metadata: { userId: "spoofed-owner" } },
            },
            error: state.authError ? { message: "synthetic sensitive auth detail" } : null,
          };
        },
      },
      rpc: async (name: string, args: { p_user_id: string; p_source_system: string }) => {
        state.reads.push({ name, args });
        const row = args.p_source_system === "portfolio_ledgers" ? state.domestic : state.us;
        return {
          error: null,
          data: row
            ? structuredClone({
                ...row,
                integrityValid: true,
                events: [],
                sourceIdentities: [],
                securities: [],
              })
            : null,
        };
      },
      from: (table: string) => {
        let update: FakeRow;
        const filters: [string, unknown][] = [];
        const query = {
          update: (value: FakeRow) => {
            update = value;
            return query;
          },
          eq: (field: string, value: unknown) => {
            filters.push([field, value]);
            return query;
          },
          select: () => query,
          maybeSingle: async () => {
            state.writes.push({ table, update, filters });
            if (state.backendError)
              return {
                data: null,
                error: { message: "synthetic private SQL and credential detail" },
              };
            if (state.conflict) return { data: null, error: null };
            state.domestic = structuredClone({
              revision: update.revision,
              payload: update.payload,
            });
            if (state.corruptReadback) state.domestic.revision += 1;
            return { data: { revision: update.revision }, error: null };
          },
        };
        return query;
      },
    };
  },
}));
vi.mock("./actualPerformance.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("./actualPerformance.server")>();
  return {
    ...original,
    previewReviewedActualPerformance: vi.fn(original.previewReviewedActualPerformance),
    saveReviewedActualPerformance: vi.fn(original.saveReviewedActualPerformance),
  };
});
const call = (data: unknown) =>
  (
    actualPerformanceServer as unknown as (options: {
      data: unknown;
    }) => Promise<ActualPerformanceResponse>
  )({ data });
const accessToken = "synthetic-token-not-a-real-credential";
function baseline(): PerformanceBaseline {
  const source = {
    system: "broker" as const,
    recordId: "synthetic-review",
    revision: "1",
    contentHash: `sha256:${"a".repeat(64)}`,
  };
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
      accounts: [
        {
          accountId: "synthetic-account",
          currency: "KRW",
          cash: "100",
          knownCashDelta: "0",
          unsettledCash: "0",
          equity: "100",
          positions: [],
          issues: [],
        },
      ],
      fx: [],
    },
    confirmedAt: "2026-10-11T12:00:00Z",
    sourceRevisions: { domestic: 8, us: 5 },
    betaArchive: { asOfDate: "2026-10-09", source, summaries: { syntheticSummary: "reviewed" } },
  };
}
function request(action: "preview" | "save", expectedRevision = 8) {
  return {
    accessToken,
    action,
    expectedRevision,
    input: { action: "confirmBaseline", baseline: baseline() },
    ...(action === "save" ? { reviewConfirmed: true } : {}),
  };
}
function observation(): PerformanceObservation {
  return {
    valuation: { ...baseline().valuation, recordedAt: "2026-10-12T23:00:00Z" },
    previousDate: "2026-10-12",
    flowsComplete: true,
    intervalComplete: true,
    allocationConfirmed: true,
    tradeAllocations: [],
    cashAdjustments: [],
    flows: [],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T01:00:00Z"));
  state.domestic = {
    revision: 8,
    payload: { executions: [], actualCapital: 321, immutableFixture: { preserve: true } },
  };
  state.us = { revision: 5, payload: { executions: [] } };
  state.authError =
    state.missingUser =
    state.conflict =
    state.corruptReadback =
    state.backendError =
      false;
  state.clients = [];
  state.authTokens = [];
  state.reads = [];
  state.writes = [];
});
afterEach(() => vi.useRealTimers());

describe("authenticated reviewed performance endpoint", () => {
  it.each(["load", "preview", "save"] as const)(
    "rejects invalid auth before %s reads or writes",
    async (action) => {
      state.authError = true;
      await expect(
        call(action === "load" ? { action, accessToken } : request(action)),
      ).rejects.toThrow("로그인 세션을 확인하세요.");
      expect(state.reads).toHaveLength(0);
      expect(state.writes).toHaveLength(0);
      expect(previewReviewedActualPerformance).not.toHaveBeenCalled();
      expect(saveReviewedActualPerformance).not.toHaveBeenCalled();
    },
  );
  it("rejects missing authenticated user and never trusts user metadata", async () => {
    state.missingUser = true;
    await expect(call({ action: "load", accessToken })).rejects.toThrow("로그인 세션");
    expect(state.reads).toHaveLength(0);
    state.missingUser = false;
    await call({ action: "load", accessToken });
    expect(state.reads.every(({ args }) => args.p_user_id === state.uid)).toBe(true);
  });
  it("loads both canonical owner revisions through the bearer-scoped client without writes", async () => {
    const result = await call({ action: "load", accessToken });
    expect(result).toMatchObject({
      action: "load",
      revision: 8,
      usRevision: 5,
      view: { status: "PENDING_BASELINE" },
    });
    expect(state.clients[0]).toEqual({
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect(state.authTokens).toEqual([accessToken]);
    expect(state.reads).toEqual([
      {
        name: "ledger_read_website_document",
        args: { p_user_id: state.uid, p_source_system: "portfolio_ledgers" },
      },
      {
        name: "ledger_read_website_document",
        args: { p_user_id: state.uid, p_source_system: "us_actual_portfolio_ledgers" },
      },
    ]);
    expect(state.writes).toHaveLength(0);
  });
  it("blocks a stored allocation whose original execution was removed without changing confirmed history", async () => {
    await call(request("save"));
    const recorded = observation();
    recorded.tradeAllocations = [
      {
        sourceSystem: "portfolio_ledgers",
        executionId: "synthetic-original-now-missing",
        date: "2026-10-12",
        order: 0,
        accountId: "synthetic-account",
        currency: "KRW",
        securityId: "KOSPI:SYNTHETIC",
        side: "BUY",
        quantity: "1",
        price: "10",
        gross: "10",
        fee: "0",
        source: baseline().valuation.source,
      },
    ];
    recorded.valuation.accounts[0]!.cash = "90";
    recorded.valuation.accounts[0]!.positions = [
      {
        securityId: "KOSPI:SYNTHETIC",
        quantity: "1",
        knownQuantityDelta: "1",
        costBasis: "10",
        marketValue: "10",
        priceDate: "2026-10-12",
      },
    ];
    state.domestic!.payload.actualPerformance!.observations = [recorded];
    const before = structuredClone(state.domestic);
    state.writes = [];
    await expect(call({ action: "load", accessToken })).rejects.toThrow("원본 체결을 다시 대조");
    expect(state.domestic).toEqual(before);
    expect(state.writes).toHaveLength(0);
  });
  it("does not initialize absent canonical ledgers during load", async () => {
    state.domestic = state.us = null;
    expect(await call({ action: "load", accessToken })).toMatchObject({
      revision: null,
      usRevision: null,
      view: { status: "PENDING_BASELINE" },
    });
    expect(state.writes).toHaveLength(0);
  });
  it("rejects spoofed owner IDs and malformed inputs before authentication or database access", async () => {
    for (const data of [
      { action: "load", accessToken, userId: "spoofed-owner" },
      { ...request("preview"), uid: state.uid },
      { ...request("preview"), input: { ...request("preview").input, user_id: state.uid } },
      { ...request("preview"), input: { action: "reset", baseline: baseline() } },
      {
        ...request("preview"),
        input: {
          action: "confirmBaseline",
          baseline: {
            ...baseline(),
            valuation: { ...baseline().valuation, accounts: "malicious" },
          },
        },
      },
      { ...request("preview"), accessToken: "bad\nAuthorization: spoofed" },
    ])
      await expect(call(data)).rejects.toThrow("입력 형식");
    expect(state.clients).toHaveLength(0);
    expect(state.authTokens).toHaveLength(0);
    expect(state.reads).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });
  it("rejects unsupported reporting scopes and unconfirmed allocation data before authentication", async () => {
    const observed = observation();
    const common = { action: "preview", accessToken, expectedRevision: 8 };
    const invalid = [
      {
        ...common,
        input: { action: "confirmBaseline", baseline: { ...baseline(), scope: "ALL_ACTUAL" } },
      },
      {
        ...common,
        input: { action: "confirmBaseline", baseline: { ...baseline(), scope: undefined } },
      },
      {
        ...common,
        input: {
          action: "appendObservation",
          observation: { ...observed, allocationConfirmed: false },
        },
      },
      {
        ...common,
        input: {
          action: "appendObservation",
          observation: { ...observed, allocationConfirmed: undefined },
        },
      },
      {
        ...common,
        input: {
          action: "appendObservation",
          observation: { ...observed, tradeAllocations: undefined },
        },
      },
      {
        ...common,
        input: {
          action: "appendObservation",
          observation: { ...observed, cashAdjustments: undefined },
        },
      },
      {
        ...common,
        input: {
          action: "appendObservation",
          observation: { ...observed, allocationRule: "AUTOMATIC_FIFO" },
        },
      },
    ];
    for (const data of invalid) await expect(call(data)).rejects.toThrow("입력 형식");
    expect(state.clients).toHaveLength(0);
    expect(state.authTokens).toHaveLength(0);
    expect(state.reads).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });
  it("previews with the same preparation path but never calls the writer or changes records", async () => {
    const before = structuredClone(state.domestic);
    const result = await call(request("preview"));
    expect(result).toMatchObject({
      action: "preview",
      revision: 8,
      view: { status: "WAITING_OBSERVATION", baselineNav: "100" },
    });
    expect(previewReviewedActualPerformance).toHaveBeenCalledOnce();
    expect(saveReviewedActualPerformance).not.toHaveBeenCalled();
    expect(state.domestic).toEqual(before);
    expect(state.writes).toHaveLength(0);
  });
  it("requires both exact revision and explicit review confirmation for save", async () => {
    for (const data of [
      { ...request("save"), expectedRevision: undefined },
      { ...request("save"), reviewConfirmed: undefined },
      { ...request("save"), reviewConfirmed: false },
      { ...request("save"), reviewConfirmed: "true" },
    ])
      await expect(call(data)).rejects.toThrow("입력 형식");
    expect(saveReviewedActualPerformance).not.toHaveBeenCalled();
    expect(state.clients).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });
  it("delegates confirmed save once, preserves unrelated data, and uses owner/revision CAS", async () => {
    const original = structuredClone(state.domestic!.payload);
    const usBefore = structuredClone(state.us);
    expect(await call(request("save"))).toMatchObject({
      action: "save",
      revision: 9,
      reused: false,
    });
    expect(saveReviewedActualPerformance).toHaveBeenCalledOnce();
    expect(saveReviewedActualPerformance).toHaveBeenCalledWith(expect.anything(), state.uid, {
      action: "confirmBaseline",
      expectedRevision: 8,
      baseline: baseline(),
    });
    expect(state.writes[0]!.filters).toEqual([
      ["user_id", state.uid],
      ["revision", 8],
    ]);
    const { actualPerformance, ...payload } = state.domestic!.payload;
    expect(payload).toEqual(original);
    expect(actualPerformance!.baseline).toEqual(baseline());
    expect(state.us).toEqual(usBefore);
  });
  it("delegates identical retries and concurrent conflicts to the writer without a blind retry", async () => {
    await call(request("save"));
    expect(await call(request("save", 9))).toMatchObject({ reused: true, revision: 9 });
    expect(state.writes).toHaveLength(1);
    await expect(call(request("save", 8))).rejects.toThrow("원장이 변경되었습니다");
    expect(state.writes).toHaveLength(1);
    state.conflict = true;
    await expect(
      call({
        action: "save",
        accessToken,
        expectedRevision: 9,
        reviewConfirmed: true,
        input: { action: "appendObservation", observation: observation() },
      }),
    ).rejects.toThrow("원장이 변경되었습니다");
    expect(state.writes).toHaveLength(2);
    expect(state.domestic!.revision).toBe(9);
    expect(saveReviewedActualPerformance).toHaveBeenCalledTimes(4);
  });
  it("reports uncertain acknowledgement without repeating the write", async () => {
    state.corruptReadback = true;
    await expect(call(request("save"))).rejects.toThrow("중복 저장하지 말고");
    expect(saveReviewedActualPerformance).toHaveBeenCalledOnce();
    expect(state.writes).toHaveLength(1);
  });
  it("does not leak backend details to the client", async () => {
    state.backendError = true;
    await expect(call(request("save"))).rejects.toThrow("실제 성과 자료를 처리하지 못했습니다");
    expect(state.writes).toHaveLength(1);
  });
});

describe("preview/save shared admission guards", () => {
  it.each(["preview", "save"] as const)(
    "%s rejects stale evidence revisions and future confirmation before writes",
    async (action) => {
      const original = baseline();
      original.sourceRevisions.us = 4;
      await expect(
        call({ ...request(action), input: { action: "confirmBaseline", baseline: original } }),
      ).rejects.toThrow("원장이 변경되었습니다");
      vi.setSystemTime(new Date("2026-10-09T01:00:00Z"));
      await expect(call(request(action))).rejects.toThrow("미래 시점");
      expect(state.writes).toHaveLength(0);
    },
  );
  it.each(["preview", "save"] as const)(
    "%s rejects incomplete observations and future observation timestamps",
    async (action) => {
      await call(request("save"));
      const before = structuredClone(state.domestic);
      const common = {
        action,
        accessToken,
        expectedRevision: 9,
        ...(action === "save" ? { reviewConfirmed: true } : {}),
      };
      await expect(
        call({
          ...common,
          input: {
            action: "appendObservation",
            observation: { ...observation(), flowsComplete: false },
          },
        }),
      ).rejects.toThrow("입출금 누락");
      const future = observation();
      future.valuation.recordedAt = "2026-10-14T00:00:00Z";
      await expect(
        call({ ...common, input: { action: "appendObservation", observation: future } }),
      ).rejects.toThrow("미래 시점");
      expect(state.domestic).toEqual(before);
      expect(state.writes).toHaveLength(1);
    },
  );
  it("requires explicit reviewed cash income before a higher cash balance can contribute to returns", async () => {
    await call(request("save"));
    const observed = observation();
    observed.valuation.accounts[0]!.cash = "105";
    observed.valuation.accounts[0]!.equity = "105";
    const common = {
      accessToken,
      expectedRevision: 9,
      input: { action: "appendObservation", observation: observed },
    };
    await expect(call({ ...common, action: "preview" })).rejects.toThrow("입출금 누락");
    expect(state.writes).toHaveLength(1);
    observed.cashAdjustments = [
      {
        id: "synthetic-reviewed-interest",
        date: "2026-10-12",
        accountId: "synthetic-account",
        currency: "KRW",
        kind: "INTEREST",
        amount: "5",
        source: baseline().valuation.source,
      },
    ];
    expect(await call({ ...common, action: "preview" })).toMatchObject({
      action: "preview",
      view: { status: "RECORDED", totalPnl: "5", returnPercent: "5" },
    });
    expect(state.writes).toHaveLength(1);
    expect(await call({ ...common, action: "save", reviewConfirmed: true })).toMatchObject({
      action: "save",
      revision: 10,
      reused: false,
      view: { totalPnl: "5" },
    });
    expect(state.writes).toHaveLength(2);
    expect(state.domestic!.payload.actualPerformance!.observations[0]!.cashAdjustments).toEqual(
      observed.cashAdjustments,
    );
  });
  it("shows validated observation returns without freezing the preview", async () => {
    await call(request("save"));
    const before = structuredClone(state.domestic);
    const result = await call({
      action: "preview",
      accessToken,
      expectedRevision: 9,
      input: { action: "appendObservation", observation: observation() },
    });
    expect(result).toMatchObject({
      action: "preview",
      revision: 9,
      view: { status: "RECORDED", totalPnl: "0", returnPercent: "0" },
    });
    expect(state.domestic).toEqual(before);
    expect(state.writes).toHaveLength(1);
  });
});
