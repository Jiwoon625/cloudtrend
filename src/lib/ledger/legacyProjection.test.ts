import { describe, expect, it } from "vitest";
import { normalizeLegacyExecution, projectLegacyExecutions, correctEvent } from "./migration";
import { validateEvent } from "./validation";
import type { Security, SourceRef } from "./types";
const security: Security = {
  id: "KR:0123A0",
  symbol: "0123A0",
  name: "Synthetic aggregate",
  market: "KOSPI",
  assetType: "ETF",
  currency: "KRW",
  notionPageId: null,
};
const source: SourceRef = {
  system: "portfolio_ledgers",
  recordId: "synthetic-aggregate",
  revision: "8",
  contentHash: `sha256:${"b".repeat(64)}`,
};
const execution = {
  id: source.recordId,
  symbol: security.symbol,
  name: security.name,
  market: "ETF",
  signalKey: null,
  side: "BUY" as const,
  date: "2026-09-02",
  price: 100 / 3,
  shares: 3,
  fee: 0,
  note: "Synthetic aggregate includes earlier component fills",
  order: 0,
};
const make = () =>
  normalizeLegacyExecution({
    execution,
    accountId: "UNASSIGNED:portfolio_ledgers",
    security,
    source,
    recordedAt: "2026-10-02T12:00:00Z",
  });
describe("lossless source migration", () => {
  it("preserves repeating source average and exact original gross", () => {
    const event = make();
    expect(event.price).toBe("33.33333333");
    expect(event.gross).toBe("100");
    expect(event.legacyExecution).toEqual(execution);
    expect(event.issues).toContain("legacy_average_price_precision_preserved_in_source");
    expect(event.issues).toContain("account_mapping_unverified");
    expect(
      projectLegacyExecutions(
        [event],
        { system: source.system, revision: source.revision, executions: [execution] },
        [security],
      ),
    ).toEqual([execution]);
    expect(event.cashLegs[0]!.amount).toBeNull();
  });
  it.each(["gross", "price", "quantity", "fee"] as const)("rejects altered %s", (field) => {
    expect(() => validateEvent({ ...make(), [field]: "999" })).toThrow();
  });
  it("rejects source identity changes and non-fill use", () => {
    expect(() =>
      validateEvent({ ...make(), source: { ...source, recordId: "different" } }),
    ).toThrow();
    expect(() => validateEvent({ ...make(), kind: "DIVIDEND" })).toThrow();
  });
  it("refuses fallback projection of corrected records", () => {
    expect(() =>
      projectLegacyExecutions(
        [{ ...make(), revision: 2, previousRevision: 1, correctionReason: "Review" }],
        { system: source.system, revision: source.revision, executions: [execution] },
        [security],
      ),
    ).toThrow();
  });
  it("allows a reviewed fee correction without changing retained aggregate metadata", () => {
    const original = make();
    const corrected = correctEvent(original, { ...original, fee: "1" }, "Verified commission");
    expect(corrected.legacyExecution).toEqual(execution);
    expect(corrected.gross).toBe("100");
    expect(() => validateEvent(corrected)).not.toThrow();
    expect(() =>
      correctEvent(
        original,
        { ...original, legacyExecution: { ...execution, note: "altered" } },
        "Bad mutation",
      ),
    ).toThrow();
  });
  it("represents benign binary gross artifacts without losing the source", () => {
    const fill = { ...execution, price: 0.1 };
    const event = normalizeLegacyExecution({
      execution: fill,
      accountId: "UNASSIGNED:portfolio_ledgers",
      security,
      source,
      recordedAt: "2026-10-02T12:00:00Z",
    });
    expect(event.gross).toBe("0.3");
    expect(event.legacyExecution).toEqual(fill);
  });
  it("rejects a model copy and an unmarked unassigned account", () => {
    expect(() => validateEvent({ ...make(), book: "MODEL", bookId: "shadow:synthetic" })).toThrow();
    expect(() => validateEvent({ ...make(), issues: [] })).toThrow();
  });
  it("rejects altered retained notes, symbols or security identity in verified projection", () => {
    for (const event of [
      { ...make(), legacyExecution: { ...execution, note: "altered" } },
      { ...make(), legacyExecution: { ...execution, symbol: "999999" } },
      { ...make(), securityId: "wrong" },
    ]) {
      expect(() =>
        projectLegacyExecutions(
          [event],
          { system: source.system, revision: source.revision, executions: [execution] },
          [security],
        ),
      ).toThrow();
    }
  });
  it("requires full unique source coverage", () => {
    const verified = { system: source.system, revision: source.revision, executions: [execution] };
    expect(() => projectLegacyExecutions([], verified, [security])).toThrow();
    expect(() =>
      projectLegacyExecutions(
        [make(), make()],
        { ...verified, executions: [execution, { ...execution, id: "another" }] },
        [security],
      ),
    ).toThrow();
  });
  it("does not alias the captured source object", () => {
    const projected = projectLegacyExecutions(
      [make()],
      { system: source.system, revision: source.revision, executions: [execution] },
      [security],
    );
    projected[0]!.note = "Changed";
    expect(execution.note).toContain("Synthetic");
  });
});
