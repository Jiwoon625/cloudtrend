import fs from "node:fs";
import { describe, expect, it } from "vitest";
const core = fs.readFileSync(new URL("./core.ts", import.meta.url), "utf8");
const entry = fs.readFileSync(new URL("./entry.ts", import.meta.url), "utf8");
// Static wrapper-boundary checks, not a substitute for real historical reconstruction.
describe("separate gap wrapper memory boundaries", () => {
  it("verifies complete evidence and retains date proof before releasing only local references", () => {
    const release = core.indexOf("priorCapture = null;");
    for (const required of [
      "canonicalHash(priorCapture) === PRIOR_CAPTURE",
      "canonicalHash(priorPlan) === PRIOR_PLAN",
      "canonicalHash(datasetCapture) === decodedCaptureHash",
      "canonicalHash(datasetCapture.dataset) === priorPlan.preparation.basis.datasetHash",
      "(await H(datasetCapture.config)) === priorPlan.preparation.basis.configHash",
      'check(proof, "Missing historical date proof")',
    ]) {
      expect(core.indexOf(required)).toBeGreaterThan(-1);
      expect(core.indexOf(required)).toBeLessThan(release);
    }
    expect(core).not.toMatch(/delete\s+(priorCapture|priorPlan|datasetCapture)/);
    expect(core).not.toMatch(/(?:priorCapture|priorPlan|datasetCapture)\[[^\]]+\]\s*=/);
  });
  it("leaves the existing slicer and analyzer plus post-analysis proof equality unchanged", () => {
    expect(core).toContain("const sliced = sliceKrDatasetForReplay(historicalDataset, DATE);");
    expect(core).toContain("historicalDataset = null;\n  collect();");
    expect(core).toContain("analyzeKrReplayDataset(sliced, config)");
    expect(core).toContain(
      "proof.sourceHash === sourceHash && proof.datasetHash === canonicalHash(dataset)",
    );
    expect(core).toContain("decodedCaptureHash,");
  });
  it("enables GC only in the isolated worker and caps heap without inheriting credentials", () => {
    const spawn = entry.slice(
      entry.indexOf("const child = spawnSync("),
      entry.indexOf("check(child.status === 0"),
    );
    expect(spawn).toMatch(/"--expose-gc",\s*path\.join\(root, "integrated-gap-code\/pure\.mjs"\)/);
    expect(spawn).toContain(
      'env: { ...pureEnvironment(directory), NODE_OPTIONS: "--max-old-space-size=4096" }',
    );
    expect(spawn).not.toContain("...process.env");
    expect(spawn).not.toContain("SUPABASE");
  });
});
