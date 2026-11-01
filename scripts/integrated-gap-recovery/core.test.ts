import { describe, it, expect } from "vitest";
import {
  validateGapRequest,
  prepareGapPlan,
  canonicalHash,
  PRIOR_CAPTURE,
  PRIOR_PLAN,
  DATE,
  PREDECESSOR,
  type GapRequest,
} from "./core";
import runtime from "../../src/lib/integratedAllocationRuntime.generated.json";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
} from "../../src/lib/ledger/octoberShadowCalendar";
const owner = "00000000-0000-4000-8000-000000000001",
  code = "a".repeat(40),
  hash = "sha256:" + "b".repeat(64);
async function fixture(): Promise<GapRequest> {
  const cal = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  const p = `${owner}/staging/integrated-allocation-inputs/v1/`;
  const paths = [
    ...cal.regularSessions
      .filter((d) => d >= "2026-10-12" && d <= PREDECESSOR)
      .map((d) => p + "KR/" + d + ".json"),
    p + "US/" + PREDECESSOR + ".json",
    p + "US/" + DATE + ".json",
  ];
  return {
    version: "integrated-gap-request-v1",
    owner,
    codeCommit: code,
    preparedAt: "2026-11-01T10:00:00Z",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    targetDate: DATE,
    predecessorDate: PREDECESSOR,
    priorCaptureHash: PRIOR_CAPTURE,
    priorPlanHash: PRIOR_PLAN,
    expectedRuntimeHash: runtime.codeHash,
    expected: { sources: hash, models: hash, registries: hash, actual: hash },
    storage: paths.map((path) => ({
      path,
      rawHash: hash,
      payloadHash: hash,
      generation: { id: "test" },
    })),
    targetAbsent: true,
  };
}
describe("exact integrated gap scope", () => {
  it("admits exact29 request only", async () => {
    const r = await fixture();
    await expect(validateGapRequest(r, canonicalHash(r), owner, code)).resolves.toBeUndefined();
  });
  for (const [field, value] of Object.entries({
    targetDate: "2026-10-30",
    predecessorDate: "2026-10-27",
    operationalApproval: true,
    historicalAvailabilityClaim: true,
    targetAbsent: false,
    priorCaptureHash: hash,
    priorPlanHash: hash,
    expectedRuntimeHash: hash,
    preparedAt: "invalid",
  }))
    it(`rejects altered ${field}`, async () => {
      const r = { ...(await fixture()), [field]: value } as any;
      await expect(validateGapRequest(r, canonicalHash(r), owner, code)).rejects.toThrow();
    });
  it("rejects owner, commit and requesthash drift", async () => {
    const r = await fixture();
    await expect(validateGapRequest(r, hash, owner, code)).rejects.toThrow();
    await expect(validateGapRequest(r, canonicalHash(r), "another", code)).rejects.toThrow();
    await expect(validateGapRequest(r, canonicalHash(r), owner, "b".repeat(40))).rejects.toThrow();
  });
  it("rejects duplicate/missing or target29 storage pin", async () => {
    for (const fn of [
      (r: any) => r.storage.pop(),
      (r: any) => r.storage.push(r.storage[0]),
      (r: any) => (r.storage[0].path = r.storage[0].path.replace("2026-10-12", "2026-10-29")),
    ]) {
      const r = await fixture();
      fn(r);
      await expect(validateGapRequest(r, canonicalHash(r), owner, code)).rejects.toThrow();
    }
  });
  it("rejects weakened baseline or malformed objecthash", async () => {
    const r = await fixture();
    delete r.expected.actual;
    await expect(validateGapRequest(r, canonicalHash(r), owner, code)).rejects.toThrow();
    const s = await fixture();
    s.storage[0].rawHash = "anything";
    await expect(validateGapRequest(s, canonicalHash(s), owner, code)).rejects.toThrow();
  });
  it("stops stale baseline before hydration and any operational side effect", async () => {
    const r = await fixture();
    const c: any = {
      version: "integrated-gap-capture-v1",
      owner,
      codeCommit: code,
      request: r,
      requestHash: canonicalHash(r),
      capturedAt: "2026-11-01T10:00:00Z",
      priorCaptureHash: PRIOR_CAPTURE,
      priorPlanHash: PRIOR_PLAN,
      baseline: { sources: [], models: [], registries: [], actual: {} },
      objects: [],
    };
    await expect(prepareGapPlan(c, {}, {})).rejects.toThrow("Stale baseline");
  });
  it("stops wrong capture before any reconstruction", async () => {
    const r = await fixture();
    const baseline = { sources: [], models: [], registries: [], actual: {} };
    r.expected = Object.fromEntries(
      Object.entries(baseline).map(([k, v]) => [k, canonicalHash(v)]),
    );
    const c: any = {
      version: "integrated-gap-capture-v1",
      owner,
      codeCommit: code,
      request: r,
      requestHash: canonicalHash(r),
      capturedAt: "2026-11-01T10:00:00Z",
      priorCaptureHash: PRIOR_CAPTURE,
      priorPlanHash: PRIOR_PLAN,
      baseline,
      objects: [],
    };
    await expect(prepareGapPlan(c, {}, {})).rejects.toThrow("Prior proof identity mismatch");
  });
});
