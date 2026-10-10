import { describe, expect, it } from "vitest";
import { parseNewActualPortfolioRequest } from "./newActualPortfolioInput";
describe("strict new actual input boundary", () => {
  const input = {
    accessToken: "synthetic",
    action: "cash",
    expectedRevision: 1,
    requestId: "00000000-0000-4000-8000-000000000001",
    currency: "KRW",
    event: {
      id: "",
      date: "2026-10-12",
      kind: "DEPOSIT",
      amount: 100,
      reference: "broker receipt",
    },
    confirmed: true,
  };
  it("accepts explicit real-flow recording", () =>
    expect(parseNewActualPortfolioRequest(input).action).toBe("cash"));
  it.each([
    { confirmed: false },
    { userId: "another-owner" },
    { expectedRevision: 0 },
    { requestId: "unknown" },
    { event: { ...input.event, amount: NaN } },
    { event: { ...input.event, date: "2026-02-30" } },
    { event: { ...input.event, amount: 0 } },
    { event: { ...input.event, reference: "https://example.com/secret" } },
  ])("rejects malformed/unapproved or spoofed input %j", (changes) =>
    expect(() => parseNewActualPortfolioRequest({ ...input, ...changes })).toThrow(),
  );
  it("never accepts legacy capital/plan as a load side effect", () =>
    expect(() =>
      parseNewActualPortfolioRequest({
        accessToken: "synthetic",
        action: "load",
        capital: 12345678,
      }),
    ).toThrow());
});
