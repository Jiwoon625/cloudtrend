import { expect, test } from "vitest";
import {
  assertScreeningResultTransition as guard,
  currentScreeningEngineIdentity as engine,
  type ScreeningResultIdentity,
} from "../src/lib/screeningEngineIdentity";
import { SCREENING_CACHE_VERSION } from "../src/lib/screeningCacheContract";

const previous: ScreeningResultIdentity = {
  version: SCREENING_CACHE_VERSION,
  publicationId: "5f52ffb3-ecd9-420c-a293-bb86cee064d7",
  inputFingerprint: "5d36ba2fd0dce10c5f1df5ab118af9badd7b1afae5f8b27b76d04555e1d207f4",
  resultDigest: "4b6e1bd68a308b63efacacebdfb963ace16650c6797bcbe1cac08b6dc6d0f12a",
  asOfDate: "2026-11-09",
};
const next: ScreeningResultIdentity = {
  ...previous,
  publicationId: "new-publication",
  resultDigest: "ee349d7f807c728e46a58aa48efd3501158843867370e926f36d2fce634fe95a",
  engineIdentity: engine,
};
test("exact legacy migration preserves schema and source fingerprint", () => {
  expect(() => guard(previous, next)).not.toThrow();
  expect(next.version).toBe(previous.version);
  expect(next.inputFingerprint).toBe(previous.inputFingerprint);
});
test.each(["publicationId", "resultDigest", "asOfDate"] as const)(
  "legacy migration pins previous %s",
  (key) => {
    expect(() => guard({ ...previous, [key]: "different" }, next)).toThrow();
  },
);
test.each(["resultDigest", "asOfDate"] as const)("legacy migration pins next %s", (key) => {
  expect(() => guard(previous, { ...next, [key]: "different" })).toThrow();
});
test("bridge cannot recur after successful migration", () => {
  expect(() => guard(next, { ...next, resultDigest: previous.resultDigest })).toThrow();
});
test("same known engine with changed result rejects", () => {
  expect(() => guard({ ...previous, engineIdentity: engine }, next)).toThrow();
});
test("two distinct reviewed engines permit changed calculation", () => {
  expect(() =>
    guard(
      {
        ...previous,
        publicationId: "other",
        engineIdentity: {
          version: engine.version,
          codeHash: "0d2307099c51f1d0e3a37773651001fdbb2bd83cefcc45bb279018689e27d09b",
        },
      },
      next,
    ),
  ).not.toThrow();
});
test.each([
  undefined,
  null,
  {},
  { ...engine, codeHash: "f".repeat(64) },
  { ...engine, version: "spoof" },
  { ...engine, extra: true },
])("missing/malformed/unreviewed new engine rejects even first publication: %j", (value) => {
  expect(() => guard(null, { ...next, engineIdentity: value as never })).toThrow();
});
test("unknown legacy identity is not a broad bypass", () => {
  expect(() => guard({ ...previous, publicationId: "other" }, next)).toThrow();
});

test("missing predecessor digest is not an unknown-identity bypass", () => {
  const { resultDigest: _digest, ...withoutDigest } = previous;
  expect(() => guard(withoutDigest, next)).toThrow("predecessor");
});

test.each([undefined, engine])(
  "Nov10 equal-input/equal-digest transition accepts legacy or current provenance: %j",
  (engineIdentity) => {
    const previousNovember: ScreeningResultIdentity = {
      version: SCREENING_CACHE_VERSION,
      publicationId: "synthetic-nov10-publication",
      inputFingerprint: "a".repeat(64),
      resultDigest: "b".repeat(64),
      asOfDate: "2026-11-10",
      ...(engineIdentity ? { engineIdentity } : {}),
    };
    const nextNovember = {
      ...previousNovember,
      publicationId: "new-calculation",
      engineIdentity: engine,
    };
    expect(() => guard(previousNovember, nextNovember)).not.toThrow();
    expect(() =>
      guard(previousNovember, { ...nextNovember, resultDigest: "c".repeat(64) }),
    ).toThrow("regression guard");
  },
);
