import { expect, it } from "vitest";
import { screeningSession } from "./screeningSession";
it("uses the recorded collection instant in Korean time, including delayed runs", () => {
  expect(screeningSession("2026-10-17T00:15:00Z")).toBe("오전 수집");
  expect(screeningSession("2026-10-17T12:10:00Z")).toBe("오후·저녁 수집");
  expect(screeningSession(null)).toBe("수집시각 미확인");
  expect(screeningSession("2026-10-17T09:00:00")).toBe("수집시각 미확인");
});
