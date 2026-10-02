import { describe, expect, it } from "vitest";
import { canonicalJson, correctEvent, normalizeLegacyExecution, planImport } from "./migration";
import { decimal, format, integerBudgetQuantity } from "./decimal";
import { currentEvents, validateEvent, validateSecurity } from "./validation";
import { valueBook } from "./valuation";
import {
  inspectRecordingTargets,
  makeAssistedRecordingTask,
  verifyAssistedRecording,
} from "./assistedRecording";
import type { LedgerEvent, OpeningBalance, Security, SourceRef } from "./types";
const hash = `sha256:${"a".repeat(64)}`;
const source: SourceRef = { system: "broker", recordId: "r1", revision: "1", contentHash: hash };
const security: Security = {
  id: "KR:0167A0",
  symbol: "0167A0",
  name: "Synthetic ETF",
  market: "KOSPI",
  assetType: "ETF",
  currency: "KRW",
  notionPageId: null,
};
function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: "e1",
    revision: 1,
    previousRevision: null,
    correctionReason: null,
    recordedAt: "2026-10-02T12:00:00Z",
    recordedBy: "synthetic-fixture",
    effectiveDate: "2026-10-02",
    effectiveSequence: 1,
    settlementDate: "2026-10-02",
    book: "ACTUAL",
    bookId: "ACTUAL",
    kind: "BUY",
    voided: false,
    securityId: security.id,
    quantity: "2",
    price: "100",
    currency: "KRW",
    gross: "200",
    fee: "1",
    tax: "0",
    cashLegs: [{ accountId: "confirmed-broker-account", currency: "KRW", amount: "-201" }],
    positionLegs: [
      {
        accountId: "confirmed-broker-account",
        securityId: security.id,
        quantity: "2",
        basisAdjustment: null,
      },
    ],
    source,
    evidence: [],
    brokerEventId: null,
    strategyId: null,
    signalId: null,
    orderId: null,
    issues: [],
    ...overrides,
  };
}
const opening: OpeningBalance = {
  book: "ACTUAL",
  bookId: "ACTUAL",
  accountId: "confirmed-broker-account",
  currency: "KRW",
  date: "2026-10-02",
  cash: "1000",
  positions: [],
  source,
  complete: true,
};
const value = (events: LedgerEvent[], openings = [opening]) =>
  valueBook({
    book: "ACTUAL",
    bookId: "ACTUAL",
    asOfDate: "2026-10-02",
    events,
    openings,
    securities: [security],
    marks: [
      {
        securityId: security.id,
        currency: "KRW",
        date: "2026-10-02",
        price: "110",
        sourceHash: hash,
      },
    ],
    fx: [],
    baseCurrency: "KRW",
  });
describe("ledger decimal and identity", () => {
  it("keeps decimal cash exact and target inclusive of fees", () => {
    expect(format(decimal("0.1") + decimal("0.2"))).toBe("0.3");
    expect(integerBudgetQuantity("100", "200", "100")).toBe("0");
    expect(integerBudgetQuantity("1000", "250", "100")).toBe("2");
    expect(() => decimal("NaN")).toThrow();
  });
  it("preserves Korean alphanumeric/leading-zero symbols", () => {
    expect(() => validateSecurity(security)).not.toThrow();
    expect(() => validateSecurity({ ...security, symbol: "010950" })).not.toThrow();
    expect(() => validateSecurity({ ...security, symbol: "10950" })).toThrow();
  });
  it("does not accept model data as actual", () => {
    expect(() => validateEvent(event({ book: "MODEL" }))).toThrow();
    expect(value([event({ book: "MODEL", bookId: "shadow:new" })]).accounts[0]!.cash).toBe("1000");
  });
});
describe("staged migration and correction", () => {
  it("leaves legacy settlement/tax/net cash unknown and preserves source id", () => {
    const normalized = normalizeLegacyExecution({
      execution: {
        id: "old-1",
        symbol: security.symbol,
        name: security.name,
        market: "ETF",
        signalKey: null,
        side: "BUY",
        date: "2026-10-02",
        price: 100,
        shares: 2,
        fee: 1,
        note: "",
        order: 0,
      },
      accountId: "confirmed-broker-account",
      security,
      source: { ...source, system: "portfolio_ledgers", recordId: "old-1" },
      recordedAt: "2026-10-02T12:00:00Z",
    });
    expect(normalized.id).toBe("portfolio_ledgers:old-1");
    expect(normalized.tax).toBeNull();
    expect(normalized.cashLegs[0]!.amount).toBeNull();
    expect(value([normalized]).baseEquity).toBeNull();
  });
  it("is idempotent, quarantines source changes, and quarantines both ambiguous incoming rows", () => {
    const original = event();
    expect(planImport([original], [original])[0]!.status).toBe("NOOP");
    expect(
      planImport(
        [original],
        [event({ source: { ...source, contentHash: `sha256:${"b".repeat(64)}` } })],
      )[0]!.status,
    ).toBe("QUARANTINE");
    const duplicate = event({
      id: "notion:n1",
      source: { ...source, system: "notion", recordId: "n1" },
    });
    expect(planImport([], [original, duplicate]).map((d) => d.status)).toEqual([
      "QUARANTINE",
      "QUARANTINE",
    ]);
  });
  it("replays complete correction chains and never mutates original evidence", () => {
    const original = event();
    const saved = canonicalJson(original);
    const corrected = correctEvent(
      original,
      event({
        cashLegs: [{ accountId: opening.accountId, currency: "KRW", amount: "-202" }],
        fee: "2",
        source: { ...source, revision: "2", contentHash: `sha256:${"b".repeat(64)}` },
      }),
      "Broker fee correction",
    );
    expect(currentEvents([corrected, original])).toEqual([corrected]);
    expect(value([original, corrected]).accounts[0]!.cash).toBe("798");
    expect(canonicalJson(original)).toBe(saved);
    expect(() => currentEvents([corrected])).toThrow();
    expect(
      currentEvents([
        original,
        correctEvent(original, event({ voided: true }), "Duplicate reversed"),
      ]),
    ).toEqual([]);
  });
});
describe("valuation coverage and currency", () => {
  it("derives holdings and net equity with complete evidence", () => {
    const v = value([event()]);
    expect(v.baseEquity).toBe("1019");
    expect(v.accounts[0]!.positions[0]!.costBasis).toBe("201");
  });
  it("requires an audited opening, never promotes configured capital", () => {
    const v = value([event()], []);
    expect(v.baseEquity).toBeNull();
    expect(v.accounts[0]!.cash).toBeNull();
    expect(v.accounts[0]!.knownCashDelta).toBe("-201");
  });
  it("separates unsettled cash and rejects missing settlement", () => {
    const v = value([event({ settlementDate: "2026-10-06" })]);
    expect(v.accounts[0]!.cash).toBe("1000");
    expect(v.accounts[0]!.unsettledCash).toBe("-201");
    expect(v.baseEquity).toBe("1019");
    expect(value([event({ settlementDate: null })]).baseEquity).toBeNull();
  });
  it("records both FX legs without treating conversion as performance", () => {
    const fxEvent = event({
      kind: "FX",
      securityId: null,
      quantity: null,
      price: null,
      gross: null,
      fee: "0",
      cashLegs: [
        { accountId: opening.accountId, currency: "KRW", amount: "-100" },
        { accountId: opening.accountId, currency: "USD", amount: "1" },
      ],
      positionLegs: [],
    });
    const input = {
      book: "ACTUAL" as const,
      bookId: "ACTUAL",
      asOfDate: "2026-10-02",
      events: [fxEvent],
      openings: [opening, { ...opening, currency: "USD" as const, cash: "0" }],
      securities: [security],
      marks: [],
      fx: [],
      baseCurrency: "KRW" as const,
    };
    expect(valueBook(input).baseEquity).toBeNull();
    const v = valueBook({
      ...input,
      fx: [
        {
          base: "USD",
          quote: "KRW",
          rate: "100",
          date: "2026-10-02",
          source: "verified-fixture",
          verified: true,
        },
      ],
    });
    expect(v.baseEquity).toBe("1000");
    expect(v.performanceStatus).toContain("REQUIRES_COMPLETE_FLOWS");
    expect(() => validateEvent({ ...fxEvent, cashLegs: [fxEvent.cashLegs[0]!] })).toThrow();
  });
  it("never uses future marks or current-date FX for a historical date", () => {
    const v = valueBook({
      book: "ACTUAL",
      bookId: "ACTUAL",
      asOfDate: "2026-10-02",
      events: [event()],
      openings: [opening],
      securities: [security],
      marks: [
        {
          securityId: security.id,
          currency: "KRW",
          date: "2026-10-05",
          price: "999",
          sourceHash: hash,
        },
      ],
      fx: [],
      baseCurrency: "KRW",
    });
    expect(v.baseEquity).toBeNull();
  });
});
describe("requested receipt recording on both destinations", () => {
  const task = makeAssistedRecordingTask(event(), "synthetic-user-request", {
    notionPageId: "notion-1",
    expectedNotionHash: hash,
    expectedLedgerRevision: 1,
  });
  const readback = { eventId: task.eventId, eventRevision: task.eventRevision, sourceHash: hash };
  it("needs no runtime bridge and keeps concurrent edits for review", () => {
    expect(inspectRecordingTargets(task, { ledgerRevision: 1, notionHash: hash }).status).toBe(
      "PENDING",
    );
    expect(inspectRecordingTargets(task, { ledgerRevision: 2, notionHash: hash }).status).toBe(
      "CONFLICT",
    );
  });
  it("marks one-sided recording partial and verifies only two matching readbacks", () => {
    expect(verifyAssistedRecording(task, { ledger: readback, notion: null }).status).toBe(
      "PARTIAL",
    );
    expect(
      verifyAssistedRecording(task, { ledger: null, notion: { ...readback, pageId: "notion-1" } })
        .status,
    ).toBe("PARTIAL");
    expect(verifyAssistedRecording(task, { ledger: null, notion: null }).status).toBe("PENDING");
    const complete = { ledger: readback, notion: { ...readback, pageId: "notion-1" } };
    expect(verifyAssistedRecording(task, complete).status).toBe("VERIFIED");
    expect(verifyAssistedRecording(verifyAssistedRecording(task, complete), complete).status).toBe(
      "VERIFIED",
    );
  });
  it("blocks wrong pages, mismatched facts, missing requests and model-as-actual records", () => {
    expect(
      verifyAssistedRecording(task, {
        ledger: readback,
        notion: { ...readback, pageId: "other-page" },
      }).status,
    ).toBe("CONFLICT");
    expect(
      verifyAssistedRecording(task, {
        ledger: { ...readback, sourceHash: `sha256:${"b".repeat(64)}` },
        notion: { ...readback, pageId: "notion-1" },
      }).status,
    ).toBe("CONFLICT");
    expect(() =>
      makeAssistedRecordingTask(event(), "", {
        notionPageId: null,
        expectedNotionHash: null,
        expectedLedgerRevision: null,
      }),
    ).toThrow("request");
    expect(() =>
      makeAssistedRecordingTask(event({ book: "MODEL", bookId: "test-model" }), "request", {
        notionPageId: null,
        expectedNotionHash: null,
        expectedLedgerRevision: null,
      }),
    ).toThrow("actual");
  });
});
describe("audit regression invariants", () => {
  it("rejects wrong-currency fills and fabricated buy credits", () => {
    expect(() =>
      value([
        event({
          currency: "USD",
          cashLegs: [{ accountId: opening.accountId, currency: "USD", amount: "-201" }],
        }),
      ]),
    ).toThrow("currency");
    expect(() =>
      validateEvent(
        event({
          gross: null,
          cashLegs: [{ accountId: opening.accountId, currency: "KRW", amount: "999999" }],
        }),
      ),
    ).toThrow();
    expect(() =>
      validateEvent(
        event({
          cashLegs: [{ accountId: opening.accountId, currency: "KRW", amount: "999999" }],
          fee: null,
          tax: null,
        }),
      ),
    ).toThrow("direction");
  });
  it("rejects duplicate source identities under different canonical ids", () => {
    expect(() => currentEvents([event(), event({ id: "duplicated" })])).toThrow(
      "Duplicate canonical",
    );
  });
});
describe("reviewed reconciliation and point-in-time behavior", () => {
  it("quarantines both conflicting incoming source revisions regardless of order", () => {
    const a = event(),
      b = event({ source: { ...source, contentHash: `sha256:${"b".repeat(64)}` } });
    expect(planImport([], [a, b]).map((d) => d.status)).toEqual(["QUARANTINE", "QUARANTINE"]);
    expect(planImport([], [b, a]).map((d) => d.status)).toEqual(["QUARANTINE", "QUARANTINE"]);
  });
  it("does not value unknown holdings or choose among conflicting same-date prices", () => {
    expect(value([event()], []).accounts[0]!.positions[0]!.marketValue).toBeNull();
    const input = {
      book: "ACTUAL" as const,
      bookId: "ACTUAL",
      asOfDate: "2026-10-02",
      events: [event()],
      openings: [opening],
      securities: [security],
      marks: [1, 110].map((price) => ({
        securityId: security.id,
        currency: "KRW" as const,
        date: "2026-10-02",
        price: String(price),
        sourceHash: hash,
      })),
      fx: [],
      baseCurrency: "KRW" as const,
    };
    expect(valueBook(input).baseEquity).toBeNull();
    expect(valueBook({ ...input, marks: [...input.marks].reverse() }).baseEquity).toBeNull();
  });
  it("distinguishes historical knowledge from restated corrections", () => {
    const original = event(),
      correction = correctEvent(
        original,
        event({
          recordedAt: "2026-10-10T12:00:00Z",
          fee: "2",
          cashLegs: [{ accountId: opening.accountId, currency: "KRW", amount: "-202" }],
        }),
        "Late broker correction",
      );
    const input = {
      book: "ACTUAL" as const,
      bookId: "ACTUAL",
      asOfDate: "2026-10-02",
      events: [original, correction],
      openings: [{ ...opening, recordedAt: "2026-10-02T00:00:00Z" }],
      securities: [security],
      marks: [
        {
          securityId: security.id,
          currency: "KRW" as const,
          date: "2026-10-02",
          price: "110",
          sourceHash: hash,
          availableAt: "2026-10-02T12:00:00Z",
        },
      ],
      fx: [],
      baseCurrency: "KRW" as const,
    };
    expect(valueBook(input).baseEquity).toBe("1018");
    expect(valueBook(input).revisionMode).toBe("RESTATED");
    const frozen = valueBook({ ...input, knownAt: "2026-10-02T23:00:00Z" });
    expect(frozen.baseEquity).toBe("1019");
    expect(frozen.revisionMode).toBe("AS_KNOWN");
  });
});
it("settles pre-opening trades after opening without adding their holdings twice", () => {
  const purchase = event({ effectiveDate: "2026-10-01", settlementDate: "2026-10-06" });
  const v = valueBook({
    book: "ACTUAL",
    bookId: "ACTUAL",
    asOfDate: "2026-10-06",
    events: [purchase],
    openings: [
      { ...opening, positions: [{ securityId: security.id, quantity: "2", costBasis: "201" }] },
    ],
    securities: [security],
    marks: [
      {
        securityId: security.id,
        currency: "KRW",
        date: "2026-10-06",
        price: "110",
        sourceHash: hash,
      },
    ],
    fx: [],
    baseCurrency: "KRW",
  });
  expect(v.accounts[0]!.cash).toBe("799");
  expect(v.accounts[0]!.positions[0]!.quantity).toBe("2");
  expect(v.baseEquity).toBe("1019");
});
it("normalizes decimal duplicate keys and detects changed confirmed account mapping", () => {
  const original = event();
  const copy = event({
    id: "notion:n1",
    source: { ...source, system: "notion", recordId: "n1" },
    quantity: "2.0",
    price: "100.00",
    positionLegs: [{ ...original.positionLegs[0]!, quantity: "2.0" }],
  });
  expect(planImport([], [original, copy]).map((d) => d.status)).toEqual([
    "QUARANTINE",
    "QUARANTINE",
  ]);
  const remapped = event({
    cashLegs: [{ ...original.cashLegs[0]!, accountId: "other-confirmed-account" }],
    positionLegs: [{ ...original.positionLegs[0]!, accountId: "other-confirmed-account" }],
  });
  expect(planImport([original], [remapped])[0]!.status).toBe("QUARANTINE");
});
it("rejects cash implying negative missing fees or taxes", () => {
  expect(() =>
    validateEvent(
      event({
        tax: null,
        cashLegs: [{ accountId: opening.accountId, currency: "KRW", amount: "-1" }],
      }),
    ),
  ).toThrow("nonnegative unknown costs");
  expect(() =>
    validateEvent(
      event({
        kind: "SELL",
        tax: null,
        cashLegs: [{ accountId: opening.accountId, currency: "KRW", amount: "999" }],
        positionLegs: [
          {
            accountId: opening.accountId,
            securityId: security.id,
            quantity: "-2",
            basisAdjustment: null,
          },
        ],
      }),
    ),
  ).toThrow("nonnegative unknown costs");
});
