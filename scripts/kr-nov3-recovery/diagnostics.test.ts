import { expect, it } from "vitest";
import {
  safeKrCompanionDiagnostic,
  krCompanionFailureCheck,
  withKrCompanionDiagnostics,
} from "./diagnostics";
it("sanitizes unknown stages/checks and discards private fields", () => {
  const result = safeKrCompanionDiagnostic({
    phase: "SECRET_PATH",
    check: "SECRET_VALUE",
    raw: { secret: true },
  });
  expect(result).toEqual({ phase: "UNKNOWN", check: "UNKNOWN" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(safeKrCompanionDiagnostic({ phase: "RAW_EVIDENCE", check: null })).toEqual({
    phase: "RAW_EVIDENCE",
    check: null,
  });
});
it("recognizes only exact guard codes, never arbitrary matching prefixes or error messages", () => {
  expect(krCompanionFailureCheck(Error("KR_NOV3_RECOVERY_RAW_SHORT_VOLUME"))).toBe(
    "RAW_SHORT_VOLUME",
  );
  expect(krCompanionFailureCheck(Error("CAPTURE_CODEC_REJECTED"))).toBe("CAPTURE_CODEC_REJECTED");
  for (const e of [
    Error("KR_NOV3_RECOVERY_SECRET_VALUE"),
    Error("KR_NOV3_RECOVERY_RAW_SHORT_VOLUME: private"),
    "SECRET",
    { message: "SECRET" },
  ])
    expect(krCompanionFailureCheck(e)).toBe("UNKNOWN");
});
it.each([
  [TypeError, "TYPE_ERROR"],
  [RangeError, "RANGE_ERROR"],
  [SyntaxError, "SYNTAX_ERROR"],
] as const)("categorizes errors without message text", (ErrorClass, code) => {
  expect(krCompanionFailureCheck(new ErrorClass("PRIVATE_RAW"))).toBe(code);
});
it.each([
  ["EEXIST", "FILE_EXISTS"],
  ["ENOENT", "FILE_MISSING"],
  ["EACCES", "FILE_PERMISSION"],
  ["EPERM", "FILE_PERMISSION"],
  ["ENOSPC", "FILE_CAPACITY"],
  ["EDQUOT", "FILE_CAPACITY"],
  ["PRIVATE", "UNKNOWN"],
])("allows only known filesystem categories %s", (errno, code) => {
  expect(krCompanionFailureCheck(Object.assign(Error("PRIVATE_PATH"), { code: errno }))).toBe(code);
});
it("keeps the original rejected Error object and exposes only bounded phase/check", async () => {
  const failure = Error("KR_NOV3_RECOVERY_RAW_SHORT_VOLUME"),
    events: unknown[] = [];
  await expect(
    withKrCompanionDiagnostics(
      async (mark) => {
        mark("RAW_EVIDENCE");
        throw failure;
      },
      (v) => events.push(v),
    ),
  ).rejects.toBe(failure);
  expect(events).toEqual([
    { phase: "RAW_EVIDENCE", check: null },
    { phase: "RAW_EVIDENCE", check: "RAW_SHORT_VOLUME" },
  ]);
});
it("diagnostic failure cannot alter successful or failed calculation outcomes", async () => {
  const report = () => {
    throw Error("REPORTING_FAILED");
  };
  const result = { status: "BLOCKED", operationalApproval: false };
  await expect(
    withKrCompanionDiagnostics(async (mark) => {
      mark("PLAN_COMPUTE");
      return result;
    }, report),
  ).resolves.toBe(result);
  const failure = Error("ORIGINAL");
  await expect(
    withKrCompanionDiagnostics(async () => {
      throw failure;
    }, report),
  ).rejects.toBe(failure);
});
