import { it, expect } from "vitest";
import {
  screeningStagesPath,
  initialScreeningStages,
  validScreeningStages,
} from "./screeningStages";
it("keeps authenticated caller identities within a single owner/path segment", () => {
  expect(screeningStagesPath("synthetic-owner", "us-2026-11-03-sha256:abc")).toBe(
    "synthetic-owner/results/screening/stages/us-2026-11-03-sha256:abc.json",
  );
  for (const value of ["../other-owner", "owner/other", "", "a?b", "a\\b"]) {
    expect(() => screeningStagesPath(value, "run")).toThrow();
    expect(() => screeningStagesPath("owner", value)).toThrow();
  }
});
it("never treats absent, partial or unknown status fields as successful completion", () => {
  expect(validScreeningStages(initialScreeningStages())).toBe(true);
  expect(initialScreeningStages().publication).toBe("NOT_RUN");
  expect(initialScreeningStages(true).models).toBe("SKIPPED_PRELIMINARY");
  for (const value of [
    null,
    {},
    { screening: "COMPLETED" },
    { ...initialScreeningStages(), models: "unknown" },
  ])
    expect(validScreeningStages(value)).toBe(false);
});
