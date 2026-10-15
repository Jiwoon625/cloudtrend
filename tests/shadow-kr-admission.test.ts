import { describe, expect, it } from "vitest";
import { isKrLiveShadowDecision } from "../src/lib/krShadowAdmission";

describe("KR Shadow next-morning publication boundary", () => {
  it("rejects a delayed evening refresh just after KST midnight", () => {
    // October 14's evening source was activated at 00:03 KST on October 15.
    // Merely crossing the calendar date does not make it the 08:00 KRX refresh.
    expect(
      isKrLiveShadowDecision(
        "2026-10-14",
        "2026-10-14T15:03:09.077298Z",
        "2026-10-14T15:12:47.652127Z",
      ),
    ).toBe(false);
  });

  it("does not promote an overnight source when the decision runs after 08:00", () => {
    expect(
      isKrLiveShadowDecision(
        "2026-10-14",
        "2026-10-15T07:59:59.999+09:00",
        "2026-10-15T08:10:00+09:00",
      ),
    ).toBe(false);
  });

  it("accepts the inclusive 08:00 KST refresh boundary in either timezone", () => {
    for (const availableAt of ["2026-10-15T08:00:00+09:00", "2026-10-14T23:00:00Z"])
      expect(isKrLiveShadowDecision("2026-10-14", availableAt, "2026-10-15T08:00:00+09:00")).toBe(
        true,
      );
    expect(
      isKrLiveShadowDecision(
        "2026-10-14",
        "2026-10-14T23:48:03.687779Z",
        "2026-10-14T23:57:37.5012925Z",
      ),
    ).toBe(true);
  });

  it("retains the strict pre-open and source-before-decision requirements", () => {
    expect(
      isKrLiveShadowDecision(
        "2026-10-14",
        "2026-10-15T08:00:00+09:00",
        "2026-10-15T08:59:59.999+09:00",
      ),
    ).toBe(true);
    expect(
      isKrLiveShadowDecision(
        "2026-10-14",
        "2026-10-15T08:00:00+09:00",
        "2026-10-15T09:00:00+09:00",
      ),
    ).toBe(false);
    expect(
      isKrLiveShadowDecision(
        "2026-10-14",
        "2026-10-15T08:10:00+09:00",
        "2026-10-15T08:09:59+09:00",
      ),
    ).toBe(false);
  });

  it("applies the 08:00 boundary to the next reviewed session after a holiday", () => {
    expect(
      isKrLiveShadowDecision(
        "2026-10-08",
        "2026-10-12T00:05:00+09:00",
        "2026-10-12T08:10:00+09:00",
      ),
    ).toBe(false);
    expect(
      isKrLiveShadowDecision(
        "2026-10-08",
        "2026-10-12T08:00:00+09:00",
        "2026-10-12T08:10:00+09:00",
      ),
    ).toBe(true);
  });
});
