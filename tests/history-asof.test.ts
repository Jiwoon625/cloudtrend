import { expect, test } from "vitest";
import { buildSnapshot, latestSourceRegistration } from "../src/lib/screeningSnapshot";
test("after midnight and repeat runs retain the market date", () => {
  for (const calculatedAt of ["2026-09-23T15:36:00Z", "2026-09-24T00:36:00Z"]) {
    const s = buildSnapshot(
      { asOfDate: "2026-09-23", calculatedAt, marketGate: { status: "NEUTRAL" }, rows: [] },
      "2026-09-24T00:32:00Z",
    );
    expect(s.date).toBe("2026-09-23");
    expect(s.savedAt).toBe(calculatedAt);
    expect(s.sourceRegisteredAt).toBe("2026-09-24T00:32:00Z");
  }
});
test("registration ignores unrelated newer dates and invalid timestamps", () => {
  const a = {
    min_date: "2026-09-23",
    max_date: "2026-09-23",
    activated_at: "2026-09-24T00:32:00Z",
    created_at: "2026-09-24T00:30:00Z",
  };
  expect(
    latestSourceRegistration(
      [
        a,
        {
          ...a,
          min_date: "2026-09-24",
          max_date: "2026-09-24",
          activated_at: "2026-09-25T00:00:00Z",
        },
      ],
      "2026-09-23",
    ),
  ).toBe(a.activated_at);
  expect(latestSourceRegistration([], "2026-09-23")).toBeUndefined();
});
