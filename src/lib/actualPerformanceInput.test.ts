import { describe, expect, it } from "vitest";
import {
  actualPerformanceErrorMessage,
  MAX_REVIEWED_PERFORMANCE_BYTES,
  parseActualPerformanceRequest,
  parseReviewedPerformanceInput,
  type ReviewedPerformanceInput,
} from "./actualPerformanceInput";

// Synthetic reviewed evidence only; no real balances, identities, or credentials.
function input(): ReviewedPerformanceInput {
  const source = {
    system: "broker" as const,
    recordId: "synthetic-review",
    revision: "1",
    contentHash: `sha256:${"a".repeat(64)}`,
  };
  return {
    action: "confirmBaseline",
    baseline: {
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
    },
  };
}
function baseline() {
  const value = input();
  if (value.action !== "confirmBaseline") throw new Error("Synthetic baseline expected");
  return value.baseline;
}

function observationInput() {
  return {
    action: "appendObservation" as const,
    observation: {
      valuation: { ...baseline().valuation, recordedAt: "2026-10-12T23:00:00Z" },
      previousDate: "2026-10-12",
      flowsComplete: true,
      intervalComplete: true,
      allocationConfirmed: true,
      tradeAllocations: [],
      cashAdjustments: [],
      flows: [],
    },
  };
}
function allocation() {
  return {
    sourceSystem: "portfolio_ledgers" as const,
    executionId: "synthetic-execution",
    date: "2026-10-12",
    order: 0,
    accountId: "synthetic-account",
    currency: "KRW" as const,
    securityId: "KOSPI:SYNTHETIC",
    side: "BUY" as const,
    quantity: "1",
    price: "10",
    gross: "10",
    fee: "0.1",
    source: baseline().valuation.source,
  };
}
function adjustment() {
  return {
    id: "synthetic-cash-adjustment",
    date: "2026-10-12",
    accountId: "synthetic-account",
    currency: "KRW" as const,
    amount: "1",
    kind: "INTEREST" as const,
    source: baseline().valuation.source,
  };
}

describe("strict reviewed performance input boundary", () => {
  it("accepts full reviewed baseline and observation shapes without coercing decimal strings", () => {
    const value = input();
    expect(parseReviewedPerformanceInput(value)).toEqual(value);
    const observation = {
      action: "appendObservation",
      observation: {
        valuation: baseline().valuation,
        previousDate: "2026-10-12",
        flowsComplete: true,
        intervalComplete: true,
        allocationConfirmed: true,
        tradeAllocations: [],
        cashAdjustments: [],
        flows: [],
      },
    };
    expect(parseReviewedPerformanceInput(observation)).toEqual(observation);
  });
  it.each([100, "1e2", "NaN", "Infinity", "1.123456789", "9".repeat(25), " 100", "", null])(
    "rejects invalid known cash deltas: %s",
    (value) => {
      const b = baseline();
      const bad = {
        ...b,
        valuation: {
          ...b.valuation,
          accounts: [{ ...b.valuation.accounts[0], knownCashDelta: value }],
        },
      };
      expect(() =>
        parseReviewedPerformanceInput({ action: "confirmBaseline", baseline: bad }),
      ).toThrow("입력 형식");
    },
  );
  it("retains unknown observed cash as null but rejects an unknown opening allocation", () => {
    const b = baseline();
    b.valuation.accounts[0]!.cash = null;
    expect(() => parseReviewedPerformanceInput({ action: "confirmBaseline", baseline: b })).toThrow(
      "입력 형식",
    );
    const observed = observationInput();
    observed.observation.valuation.accounts[0]!.cash = null;
    const parsed = parseReviewedPerformanceInput(observed);
    expect(
      parsed.action === "appendObservation" && parsed.observation.valuation.accounts[0]!.cash,
    ).toBeNull();
  });
  it.each(["2026-02-30", "2026-13-01", "2026-1-01", "2026-10-12<script>"])(
    "rejects invalid date %s",
    (date) => {
      const b = baseline();
      b.valuation.date = date;
      expect(() =>
        parseReviewedPerformanceInput({ action: "confirmBaseline", baseline: b }),
      ).toThrow("입력 형식");
    },
  );
  it.each(["2026-02-30T00:00:00Z", "2026-10-11", "2026-10-11T12:00:00", "2026-10-11T25:00:00Z"])(
    "rejects invalid timestamp %s",
    (timestamp) => {
      const b = baseline();
      b.confirmedAt = timestamp;
      expect(() =>
        parseReviewedPerformanceInput({ action: "confirmBaseline", baseline: b }),
      ).toThrow("입력 형식");
    },
  );
  it("rejects unsupported or incomplete source evidence", () => {
    for (const source of [
      { ...baseline().valuation.source, system: "model" },
      { ...baseline().valuation.source, contentHash: "sha256:unverified" },
      { ...baseline().valuation.source, recordId: " " },
    ]) {
      const b = baseline();
      expect(() =>
        parseReviewedPerformanceInput({
          action: "confirmBaseline",
          baseline: { ...b, valuation: { ...b.valuation, source } },
        }),
      ).toThrow("입력 형식");
    }
  });
  it("rejects unknown keys at the outer, action, evidence, valuation and account boundaries", () => {
    const b = baseline();
    const examples = [
      { ...input(), userId: "spoofed-owner" },
      { ...input(), expectedRevision: 8 },
      { action: "confirmBaseline", baseline: { ...b, admin: true } },
      {
        action: "confirmBaseline",
        baseline: { ...b, valuation: { ...b.valuation, command: "reset" } },
      },
      {
        action: "confirmBaseline",
        baseline: {
          ...b,
          valuation: {
            ...b.valuation,
            accounts: [{ ...b.valuation.accounts[0], userId: "spoofed-owner" }],
          },
        },
      },
      {
        action: "confirmBaseline",
        baseline: {
          ...b,
          betaArchive: {
            ...b.betaArchive,
            source: { ...b.betaArchive.source, accessToken: "synthetic-token" },
          },
        },
      },
      {
        action: "confirmBaseline",
        baseline: {
          ...b,
          valuation: { ...b.valuation, requiredPriceDates: { EUR: "2026-10-09" } },
        },
      },
    ];
    for (const value of examples)
      expect(() => parseReviewedPerformanceInput(value)).toThrow("입력 형식");
  });
  it.each(["__proto__", "prototype", "constructor"])("rejects dangerous summary key %s", (key) => {
    const b = baseline();
    b.betaArchive.summaries = JSON.parse(`{"${key}":"synthetic"}`);
    expect(() => parseReviewedPerformanceInput({ action: "confirmBaseline", baseline: b })).toThrow(
      "입력 형식",
    );
  });
  it("bounds account, position, flow, FX and summary arrays", () => {
    const b = baseline();
    const tooManyAccounts = {
      ...b.valuation,
      accounts: Array.from({ length: 101 }, () => b.valuation.accounts[0]),
    };
    const tooManyPositions = {
      ...b.valuation,
      accounts: [
        {
          ...b.valuation.accounts[0],
          positions: Array.from({ length: 501 }, () => ({
            securityId: "synthetic-security",
            quantity: "1",
            knownQuantityDelta: "0",
            costBasis: "1",
            marketValue: "1",
            priceDate: "2026-10-09",
          })),
        },
      ],
    };
    const fx = {
      base: "USD",
      quote: "KRW",
      date: "2026-10-09",
      rate: "1",
      source: "synthetic-fx",
      verified: true,
    };
    for (const valuation of [
      tooManyAccounts,
      tooManyPositions,
      { ...b.valuation, fx: Array.from({ length: 101 }, () => fx) },
    ]) {
      expect(() =>
        parseReviewedPerformanceInput({ action: "confirmBaseline", baseline: { ...b, valuation } }),
      ).toThrow("입력 형식");
    }
    expect(() =>
      parseReviewedPerformanceInput({
        action: "confirmBaseline",
        baseline: {
          ...b,
          betaArchive: {
            ...b.betaArchive,
            summaries: Object.fromEntries(
              Array.from({ length: 51 }, (_, index) => [`summary${index}`, "synthetic"]),
            ),
          },
        },
      }),
    ).toThrow("입력 형식");
    const observation = {
      valuation: b.valuation,
      previousDate: "2026-10-12",
      flowsComplete: true,
      intervalComplete: true,
      allocationConfirmed: true,
      tradeAllocations: [],
      cashAdjustments: [],
      flows: Array.from({ length: 501 }, () => ({
        id: "synthetic-flow",
        date: "2026-10-12",
        kind: "DEPOSIT",
        timing: "END",
        legs: [{ accountId: "synthetic-account", currency: "KRW", amount: "1" }],
        fx: [],
        source: b.valuation.source,
      })),
    };
    expect(() =>
      parseReviewedPerformanceInput({ action: "appendObservation", observation }),
    ).toThrow("입력 형식");
  });
  it("rejects non-JSON and oversized inputs before schema parsing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    for (const value of [
      undefined,
      null,
      5n,
      circular,
      { data: "x".repeat(MAX_REVIEWED_PERFORMANCE_BYTES) },
    ])
      expect(() => parseReviewedPerformanceInput(value)).toThrow("입력 형식");
  });
  it("requires an explicit safe revision and boolean true confirmation only for save", () => {
    const common = { accessToken: "synthetic-token", expectedRevision: 8, input: input() };
    expect(parseActualPerformanceRequest({ ...common, action: "preview" }).action).toBe("preview");
    expect(
      parseActualPerformanceRequest({ ...common, action: "save", reviewConfirmed: true }).action,
    ).toBe("save");
    for (const reviewConfirmed of [undefined, false, "true", 1])
      expect(() =>
        parseActualPerformanceRequest({ ...common, action: "save", reviewConfirmed }),
      ).toThrow("입력 형식");
    for (const expectedRevision of [undefined, 0, -1, 1.5, "8", Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        parseActualPerformanceRequest({ ...common, action: "preview", expectedRevision }),
      ).toThrow("입력 형식");
    for (const extra of [
      { userId: "spoofed-owner" },
      { uid: "spoofed-owner" },
      { expectedRevision: 8 },
    ])
      expect(() =>
        parseActualPerformanceRequest({ action: "load", accessToken: "synthetic-token", ...extra }),
      ).toThrow("입력 형식");
  });
});

describe("safe Korean review errors", () => {
  it("never reflects raw secrets, SQL errors or unknown evidence text", () => {
    const errors = [
      new Error("private token synthetic-secret"),
      new Error("Database failure: private SQL"),
      new SyntaxError("JSON contains synthetic-private-input"),
      { message: "private" },
      undefined,
    ];
    for (const error of errors)
      expect(actualPerformanceErrorMessage(error)).toBe(
        "실제 성과 자료를 처리하지 못했습니다. 입력과 최신 원장을 확인한 뒤 다시 시도해 주세요.",
      );
  });
  it("maps conflicts, uncertain acknowledgement, and incomplete evidence to actionable errors", () => {
    expect(
      actualPerformanceErrorMessage(
        new Error("Actual ledger changed concurrently; no performance metadata was overwritten"),
      ),
    ).toContain("최신 자료");
    expect(
      actualPerformanceErrorMessage(
        new Error(
          "Performance write acknowledgement could not be verified; re-read before retrying",
        ),
      ),
    ).toContain("중복 저장하지 말고");
    expect(
      actualPerformanceErrorMessage(
        new Error(
          "Reconcile missing valuation, FX, account coverage and external flows before persisting the day; nothing was frozen",
        ),
      ),
    ).toContain("입출금 누락");
    const safe = actualPerformanceErrorMessage(
      new Error("Future reconciliation evidence cannot confirm a baseline"),
    );
    expect(actualPerformanceErrorMessage(new Error(safe))).toBe(safe);
  });
});

describe("explicit post-start allocated-capital boundary", () => {
  it.each([undefined, null, "ALL_ACTUAL", "POST_START_TRADES", "MODEL"])(
    "rejects missing or unsupported baseline scope %s",
    (scope) => {
      expect(() =>
        parseReviewedPerformanceInput({
          action: "confirmBaseline",
          baseline: { ...baseline(), scope },
        }),
      ).toThrow("입력 형식");
    },
  );
  it("accepts only explicitly provided opening cash, no unsettled cash or legacy holdings", () => {
    const b = baseline();
    const openingAccount = b.valuation.accounts[0]!;
    const positions = [
      {
        securityId: "KOSPI:SYNTHETIC",
        quantity: "1",
        knownQuantityDelta: "0",
        costBasis: "1",
        marketValue: "1",
        priceDate: "2026-10-09",
      },
    ];
    const invalid = [
      { ...openingAccount, cash: undefined },
      { ...openingAccount, cash: "-1" },
      { ...openingAccount, cash: 100 },
      { ...openingAccount, cash: null },
      { ...openingAccount, unsettledCash: "1" },
      { ...openingAccount, unsettledCash: "-1" },
      { ...openingAccount, unsettledCash: null },
      { ...openingAccount, unsettledCash: undefined },
      { ...openingAccount, positions },
      { ...openingAccount, positions: undefined },
    ];
    for (const account of invalid)
      expect(() =>
        parseReviewedPerformanceInput({
          action: "confirmBaseline",
          baseline: { ...b, valuation: { ...b.valuation, accounts: [account] } },
        }),
      ).toThrow("입력 형식");
    const explicit = {
      action: "confirmBaseline",
      baseline: {
        ...b,
        valuation: {
          ...b.valuation,
          accounts: [{ ...openingAccount, cash: "0", equity: "0", unsettledCash: "0.00000000" }],
        },
      },
    };
    expect(parseReviewedPerformanceInput(explicit)).toEqual(explicit);
  });
  it("requires explicit allocation confirmation and both reviewed arrays even when empty", () => {
    const value = observationInput();
    expect(parseReviewedPerformanceInput(value)).toEqual(value);
    for (const allocationConfirmed of [undefined, null, false, "true", 1])
      expect(() =>
        parseReviewedPerformanceInput({
          ...value,
          observation: { ...value.observation, allocationConfirmed },
        }),
      ).toThrow("입력 형식");
    for (const field of ["tradeAllocations", "cashAdjustments"]) {
      for (const missing of [undefined, null, {}, "[]"])
        expect(() =>
          parseReviewedPerformanceInput({
            ...value,
            observation: { ...value.observation, [field]: missing },
          }),
        ).toThrow("입력 형식");
    }
  });
  it("accepts fully specified reviewed trades and cash adjustments without allocation or fee estimates", () => {
    const value = observationInput();
    const supplied = {
      ...value,
      observation: {
        ...value.observation,
        tradeAllocations: [allocation()],
        cashAdjustments: [adjustment()],
      },
    };
    expect(parseReviewedPerformanceInput(supplied)).toEqual(supplied);
    const trade = { ...allocation(), quantity: "2.00000000", gross: "20", fee: "0" };
    const exact = { ...value, observation: { ...value.observation, tradeAllocations: [trade] } };
    expect(parseReviewedPerformanceInput(exact)).toEqual(exact);
  });
  it("preserves reviewed gross instead of multiplying an eight-decimal average price", () => {
    const value = observationInput();
    const trade = { ...allocation(), quantity: "3", price: "33.33333333", gross: "100" };
    const supplied = { ...value, observation: { ...value.observation, tradeAllocations: [trade] } };
    const parsed = parseReviewedPerformanceInput(supplied);
    expect(parsed).toEqual(supplied);
    expect(
      parsed.action === "appendObservation" && parsed.observation.tradeAllocations[0]!.gross,
    ).toBe("100");
  });
  it.each([
    { sourceSystem: "model" },
    { executionId: undefined },
    { executionId: " " },
    { executionId: "x".repeat(201) },
    { date: "2026-02-30" },
    { order: -1 },
    { order: 1.5 },
    { order: "0" },
    { order: Number.MAX_SAFE_INTEGER + 1 },
    { accountId: " " },
    { currency: "EUR" },
    { securityId: "" },
    { side: "TRANSFER" },
    { quantity: 1 },
    { quantity: "0" },
    { quantity: "-1" },
    { quantity: "0.5" },
    { quantity: "1.000000001" },
    { quantity: "1e2" },
    { quantity: "9".repeat(25) },
    { price: "0" },
    { price: "-1" },
    { price: "Infinity" },
    { gross: undefined },
    { gross: null },
    { gross: 10 },
    { gross: "0" },
    { gross: "-1" },
    { gross: "1e2" },
    { gross: "NaN" },
    { gross: "1.123456789" },
    { gross: "9".repeat(25) },
    { fee: "-0.1" },
    { fee: null },
    { fee: undefined },
    { source: undefined },
    { ownerId: "spoofed-owner" },
    { allocationRule: "AUTO_FIFO" },
  ])("rejects malformed or implicit trade allocation %#", (badFields) => {
    const value = observationInput();
    expect(() =>
      parseReviewedPerformanceInput({
        ...value,
        observation: {
          ...value.observation,
          tradeAllocations: [{ ...allocation(), ...badFields }],
        },
      }),
    ).toThrow("입력 형식");
  });
  it.each([
    { id: "" },
    { id: "x".repeat(201) },
    { date: "2026-02-30" },
    { accountId: " " },
    { currency: "EUR" },
    { amount: null },
    { amount: 1 },
    { amount: "1e2" },
    { amount: "1.123456789" },
    { amount: "9".repeat(25) },
    { kind: "DEPOSIT" },
    { source: undefined },
    { automatic: true },
  ])("rejects malformed or implicit cash adjustment %#", (badFields) => {
    const value = observationInput();
    expect(() =>
      parseReviewedPerformanceInput({
        ...value,
        observation: { ...value.observation, cashAdjustments: [{ ...adjustment(), ...badFields }] },
      }),
    ).toThrow("입력 형식");
  });
  it("bounds both allocation arrays and rejects nested unreviewed source fields", () => {
    const value = observationInput();
    for (const [field, item] of [
      ["tradeAllocations", allocation()],
      ["cashAdjustments", adjustment()],
    ] as const) {
      expect(() =>
        parseReviewedPerformanceInput({
          ...value,
          observation: { ...value.observation, [field]: Array.from({ length: 501 }, () => item) },
        }),
      ).toThrow("입력 형식");
      expect(() =>
        parseReviewedPerformanceInput({
          ...value,
          observation: {
            ...value.observation,
            [field]: [{ ...item, source: { ...item.source, userId: "spoofed-owner" } }],
          },
        }),
      ).toThrow("입력 형식");
    }
  });
});

describe("safe new-capital reconciliation errors", () => {
  it.each([
    ["allocated_cash_overdrawn", "현금과 미결제현금의 합계가 음수"],
    ["Invalid allocated trade quantity, price, gross or fee", "체결 총액"],
    [
      "Allocated opening requires nonnegative cash only; legacy positions and unsettled cash are excluded",
      "실제 배정한 현금",
    ],
    ["Invalid post-start source execution allocation evidence", "체결 ID"],
    ["Trade allocation account is outside the confirmed scope", "매매 배정 계좌"],
    ["Source execution allocation cannot be reused", "중복 배정"],
    ["Invalid allocated trade quantity, price or fee", "양수 정수"],
    [
      "Allocated sell exceeds new-slice holdings; legacy holdings cannot cover it",
      "신규 운용분의 보유 수량",
    ],
    ["Duplicate or missing cash adjustment identity", "고유 ID"],
    ["Invalid dated allocated cash adjustment", "현금 조정 날짜"],
    ["Cash adjustment account is outside the confirmed scope", "현금 조정 계좌"],
    ["Cash adjustment direction mismatch", "수수료·세금은 음수"],
    [
      "Allocated actual execution is missing or ambiguous; reconcile the original journal",
      "원본 체결",
    ],
    ["Allocated execution facts differ from the original post-start actual fill", "최신 체결 자료"],
    [
      "Allocated execution quantity or reviewed fee exceeds or contradicts the original fill",
      "전체 수량",
    ],
  ])("maps %s to a safe, actionable review message", (message, expected) => {
    const safe = actualPerformanceErrorMessage(new Error(message));
    expect(safe).toContain(expected);
    expect(actualPerformanceErrorMessage(new Error(safe))).toBe(safe);
    expect(
      actualPerformanceErrorMessage(new Error(`${message}: synthetic-private-evidence`)),
    ).not.toContain("synthetic-private-evidence");
  });
});

describe("insufficient allocated cash guidance", () => {
  it("includes insufficient funding in the shared incomplete-money save guard", () => {
    expect(
      actualPerformanceErrorMessage(
        new Error(
          "Reconcile missing valuation, FX, account coverage and external flows before persisting the day; nothing was frozen",
        ),
      ),
    ).toContain("배정 현금이 부족");
  });
});
