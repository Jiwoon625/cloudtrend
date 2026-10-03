import { describe, expect, it } from "vitest";
import type { ActualExecution } from "../portfolioLedgers";
import { correctEvent, normalizeLegacyExecution } from "./migration";
import type { LedgerEvent, Security, SourceRef } from "./types";
import { validateEvent } from "./validation";
import { projectWebsiteExecutions } from "./websiteProjection";

const system = "portfolio_ledgers";
const security: Security = {
  id: "KR:0123A0",
  symbol: "0123A0",
  name: "Synthetic ETF current listing name",
  market: "KOSPI",
  assetType: "ETF",
  currency: "KRW",
  notionPageId: null,
};
const source: SourceRef = {
  system,
  recordId: "synthetic-average",
  revision: "8",
  contentHash: `sha256:${"a".repeat(64)}`,
};
const execution: ActualExecution<string> = {
  id: source.recordId,
  symbol: security.symbol,
  name: "Synthetic ETF at execution",
  market: "ETF",
  signalKey: "synthetic|2026-09-01",
  side: "BUY",
  date: "2026-09-02",
  shares: 3,
  price: 100 / 3,
  fee: 0,
  order: 7,
  note: "Synthetic full-precision aggregate\nOriginal observation",
};
const make = (fill = execution, identity = security, origin = source) =>
  normalizeLegacyExecution({
    execution: fill,
    security: identity,
    source: origin,
    accountId: `UNASSIGNED:${origin.system}`,
    recordedAt: "2026-10-03T00:00:00Z",
  });
function appEvent(fill = execution, identity = security, origin = source): LedgerEvent {
  const { legacyExecution: _, ...event } = make(fill, identity, origin);
  return { ...event, appExecution: { ...fill } };
}
function correction(previous: LedgerEvent, patch: Partial<ActualExecution<string>>) {
  const next = appEvent({ ...(previous.appExecution ?? previous.legacyExecution)!, ...patch });
  if (previous.legacyExecution) next.legacyExecution = { ...previous.legacyExecution };
  return correctEvent(previous, next, "Synthetic website correction");
}
const project = (events: LedgerEvent[], identities = [security]) =>
  projectWebsiteExecutions(events, system, identities);

describe("website canonical projection", () => {
  it("retains source precision, source display name, note, ID, and order without aliasing", () => {
    const original = make();
    const before = structuredClone(original);
    const result = project([original]);
    expect(original.price).toBe("33.33333333");
    expect(original.gross).toBe("100");
    expect(result).toEqual([execution]);
    expect(result[0]).not.toBe(original.legacyExecution);
    result[0]!.note = "Unrelated UI draft";
    expect(original).toEqual(before);
  });

  it("projects app-created fills without inventing retained legacy observations", () => {
    const event = appEvent();
    expect(event.legacyExecution).toBeUndefined();
    expect(() => validateEvent(event)).not.toThrow();
    expect(project([event])).toEqual([execution]);
  });

  it("replays shuffled corrections using the latest snapshot while preserving original metadata", () => {
    const original = make();
    const second = correction(original, { price: 200 / 3, note: "Updated average" });
    const third = correction(second, {
      fee: 0.5,
      side: "SELL",
      date: "2026-09-03",
      order: 9,
      signalKey: null,
      note: "Latest source snapshot",
    });
    expect(project([third, original, second])).toEqual([third.appExecution]);
    expect(second.price).toBe("66.66666667");
    expect(second.gross).toBe("200");
    expect(third.legacyExecution).toEqual(execution);
    expect(original.legacyExecution).toEqual(execution);
  });

  it("preserves ordinary correctEvent behavior but refuses a stale legacy website projection", () => {
    const original = make();
    const reviewed = correctEvent(original, { ...original, fee: "1" }, "Reviewed commission");
    expect(() => validateEvent(reviewed)).not.toThrow();
    expect(reviewed.legacyExecution).toEqual(execution);
    expect(() => project([original, reviewed])).toThrow(/snapshot disagrees/i);
  });

  it("omits the latest void, validates its history, and supports a later explicit revival", () => {
    const original = make();
    const edited = correction(original, { note: "Edited before removal" });
    const voided = correctEvent(edited, { ...edited, voided: true }, "Removed through website");
    expect(project([voided, original, edited], [])).toEqual([]);
    const revived = correctEvent(voided, { ...voided, voided: false }, "Explicit restored fill");
    expect(project([original, edited, voided, revived])).toEqual([edited.appExecution]);
    expect(() => project([voided, edited])).toThrow(/revision/i);
    expect(() =>
      project([
        { ...voided, appExecution: { ...edited.appExecution!, fee: 12 } },
        original,
        edited,
      ]),
    ).toThrow(/snapshot disagrees/i);
  });

  it("sorts deterministically by source order and ID, independent of event arrival/date", () => {
    const first = make({ ...execution, id: "a", order: 2, date: "2026-09-04" }, security, {
      ...source,
      recordId: "a",
    });
    const second = make({ ...execution, id: "b", order: 2, date: "2026-09-01" }, security, {
      ...source,
      recordId: "b",
    });
    const last = make();
    expect(project([last, second, first]).map((e) => e.id)).toEqual(["a", "b", execution.id]);
    expect(project([first, last, second])).toEqual(project([last, second, first]));
  });

  it("projects US shares at full representable precision and binary gross artifacts", () => {
    const us: Security = {
      ...security,
      id: "US:SYNTH",
      symbol: "SYNTH",
      market: "US",
      currency: "USD",
      assetType: "STOCK",
    };
    const origin: SourceRef = { ...source, system: "us_actual_portfolio_ledgers" };
    const fill = {
      ...execution,
      symbol: us.symbol,
      market: "US",
      price: 0.1,
      shares: 0.12345678,
      fee: 0.00000001,
    };
    const event = appEvent(fill, us, origin);
    expect(
      projectWebsiteExecutions([event], origin.system as "us_actual_portfolio_ledgers", [us]),
    ).toEqual([fill]);
  });

  it.each([
    ["quantity", "4"],
    ["price", "33"],
    ["gross", "99"],
    ["fee", "1"],
    ["effectiveSequence", 2],
    ["effectiveDate", "2026-09-03"],
    ["signalId", null],
    ["kind", "SELL"],
  ] as const)("rejects a mismatched app snapshot canonical %s on any revision", (field, value) => {
    const original = appEvent();
    expect(() => validateEvent({ ...original, [field]: value })).toThrow();
    const next = correction(original, { note: "Revision two" });
    expect(() => validateEvent({ ...next, [field]: value })).toThrow();
  });

  it.each([
    ["id", "other"],
    ["fee", -1],
    ["fee", NaN],
    ["shares", 0],
    ["shares", 1 / 3],
    ["price", Infinity],
    ["price", 0],
    ["price", Number.MAX_SAFE_INTEGER + 1],
    ["note", null],
    ["name", ""],
    ["symbol", ""],
    ["signalKey", 42],
    ["market", "US"],
  ] as const)("rejects invalid app snapshot %s=%s", (field, value) => {
    const original = appEvent();
    const invalid = { ...original, appExecution: { ...execution, [field]: value } } as LedgerEvent;
    expect(() => validateEvent(invalid)).toThrow();
  });

  it("rejects duplicate, incomplete, malformed and identity-changing chains", () => {
    const original = make();
    const edited = correction(original, { note: "New note" });
    for (const events of [
      [edited],
      [original, original],
      [original, edited, edited],
      [original, { ...edited, previousRevision: null }],
      [original, { ...edited, correctionReason: " " }],
      [original, { ...edited, source: { ...edited.source, recordId: "changed" } }],
      [
        original,
        { ...edited, legacyExecution: { ...execution, note: "Altered initial observation" } },
      ],
    ])
      expect(() => project(events)).toThrow();
  });

  it("rejects reused source identity even when one canonical event is voided", () => {
    const original = make();
    const voided = correctEvent(original, { ...original, voided: true }, "Removed");
    expect(() => project([original, voided, { ...original, id: "new-canonical-id" }])).toThrow(
      /duplicate/i,
    );
  });

  it("keeps app-only chain security identity immutable across revisions, including voids", () => {
    const original = appEvent();
    for (const identity of [
      { ...security, id: "KR:999990", symbol: "999990" },
      { ...security, id: "KR:another-canonical-id" },
      { ...security, market: "KOSDAQ" as const, assetType: "STOCK" as const },
    ]) {
      const next = appEvent(
        {
          ...execution,
          symbol: identity.symbol,
          market: identity.assetType === "ETF" ? "ETF" : identity.market,
        },
        identity,
      );
      const corrected = correctEvent(original, next, "Synthetic changed security");
      expect(() => project([corrected, original], [identity])).toThrow(/security identity/i);
      expect(() => project([original, { ...corrected, voided: true }], [])).toThrow(
        /security identity/i,
      );
    }
  });

  it("accepts explicit unknown US asset class without inferring stock or excluding US ETFs", () => {
    const us: Security = {
      ...security,
      id: "US:SYNTH",
      symbol: "SYNTH",
      market: "US",
      currency: "USD",
      assetType: "UNKNOWN",
    };
    const origin: SourceRef = { ...source, system: "us_actual_portfolio_ledgers" };
    const fill = { ...execution, symbol: us.symbol, market: "US" };
    const event = appEvent(fill, us, origin);
    for (const assetType of ["UNKNOWN", "STOCK", "ETF"] as const) {
      expect(
        projectWebsiteExecutions([event], "us_actual_portfolio_ledgers", [{ ...us, assetType }]),
      ).toEqual([fill]);
    }
  });

  it("rejects unknown or duplicated security IDs and symbol/market/currency/asset mismatches", () => {
    for (const identities of [
      [],
      [security, security],
      [{ ...security, id: "wrong" }],
      [{ ...security, symbol: "999990" }],
      [{ ...security, currency: "USD" as const }],
      [{ ...security, assetType: "UNKNOWN" as const }],
      [{ ...security, assetType: "STOCK" as const }],
      [{ ...security, market: "US" as const, currency: "USD" as const }],
    ])
      expect(() => project([make()], identities)).toThrow();
    const stock = { ...security, assetType: "STOCK" as const };
    const stockEvent = make({ ...execution, market: "KOSPI" }, stock);
    expect(project([stockEvent], [stock])).toEqual([{ ...execution, market: "KOSPI" }]);
    expect(project([stockEvent], [{ ...stock, assetType: "UNKNOWN" }])).toEqual([
      { ...execution, market: "KOSPI" },
    ]);
    expect(() => project([stockEvent], [{ ...stock, market: "KOSDAQ" }])).toThrow();
    expect(() => project([stockEvent], [security])).toThrow();
  });

  it("rejects missing snapshots, foreign/model sources and unsupported events, including voided ones", () => {
    const { legacyExecution: _, ...missing } = make({ ...execution, price: 10 });
    expect(() => project([missing])).toThrow(/snapshot/i);
    expect(() => project([{ ...missing, book: "MODEL", bookId: "MODEL:SYNTHETIC" }])).toThrow(
      /scope/i,
    );
    expect(() => project([{ ...missing, source: { ...source, system: "broker" } }])).toThrow(
      /scope/i,
    );
    expect(() => project([{ ...missing, kind: "DIVIDEND", voided: true }])).toThrow(/unsupported/i);
    expect(() => project([{ ...make(), voided: "false" as unknown as boolean }])).toThrow();
    expect(() =>
      project([{ ...make(), appExecution: null as unknown as ActualExecution<string> }]),
    ).toThrow();
    expect(() => projectWebsiteExecutions([], "broker" as "portfolio_ledgers", [])).toThrow();
  });

  it("refuses unrepresentable tax/basis economics while preserving explicit zero tax", () => {
    const original = make();
    const taxed = correctEvent(original, { ...original, tax: "1" }, "Synthetic tax fact");
    expect(() => project([original, taxed])).toThrow(/economics/i);
    const basis = correctEvent(
      original,
      {
        ...original,
        positionLegs: original.positionLegs.map((leg) => ({ ...leg, basisAdjustment: "1" })),
      },
      "Synthetic basis fact",
    );
    expect(() => project([original, basis])).toThrow(/economics/i);
    expect(project([{ ...original, tax: "0" }])).toEqual([execution]);
    expect(() =>
      project([{ ...original, cashLegs: [{ ...original.cashLegs[0]!, amount: "-101" }] }]),
    ).toThrow(/net cash/i);
    expect(
      project([{ ...original, cashLegs: [{ ...original.cashLegs[0]!, amount: "-100" }] }]),
    ).toEqual([execution]);
  });
});
