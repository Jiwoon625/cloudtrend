import { describe, expect, it } from "vitest";

import { getDisplayStatus } from "./statusDisplay";

describe("V8 display status", () => {
  it("labels a KOSPI 8-point threshold crossing as a new entry candidate", () => {
    expect(
      getDisplayStatus({
        kosdaq80Onset: false,
        kospiEightPointEntry: true,
        exitSignal: null,
        grade: "A",
      }),
    ).toBe("8점 신규 진입 후보");
  });

  it("keeps the official KOSDAQ onset label unchanged", () => {
    expect(
      getDisplayStatus({
        kosdaq80Onset: true,
        kospiEightPointEntry: false,
        exitSignal: null,
        grade: "A",
      }),
    ).toBe("KOSDAQ80 Onset");
  });
});
