import { describe, expect, it } from "vitest";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shadowEngineManifest } from "../../scripts/october-shadow-code-manifest";
import {
  integratedRegistry,
  prepareIntegratedInitialization,
} from "./integratedAllocationPublication";
import { canonicalSeriesJson } from "./ledger/modelSeries";
import {
  INTEGRATED_ALLOCATION_FROZEN_CODE_HASH as F,
  reviewedIntegratedRuntime,
} from "./integratedAllocationRuntimeAdmission";
const R = `sha256:${"1".repeat(64)}`;
const reviews = {
  version: "integrated-allocation-runtime-admissions-v1",
  admissions: [
    { runtimeCodeHash: F, frozenCodeHash: F, reviewId: "original-review-v1" },
    { runtimeCodeHash: R, frozenCodeHash: F, reviewId: "synthetic-compatibility-review-v1" },
  ],
};

describe("explicit integrated runtime compatibility", () => {
  it("keeps executable identity separate from frozen contract identity", () => {
    expect(reviewedIntegratedRuntime(R, F, reviews)).toEqual(reviews.admissions[1]);
    expect(reviewedIntegratedRuntime(F, F).runtimeCodeHash).toBe(F);
    expect(Object.isFrozen(reviewedIntegratedRuntime(R, F, reviews))).toBe(true);
  });
  it("does not auto-admit a changed runtime, identity, or forged review", () => {
    expect(() => reviewedIntegratedRuntime(R, F)).toThrow("Unreviewed");
    expect(() => reviewedIntegratedRuntime(R, R, reviews)).toThrow("contract");
    expect(() =>
      reviewedIntegratedRuntime(R, F, {
        ...reviews,
        admissions: [...reviews.admissions, reviews.admissions[1]!],
      }),
    ).toThrow("ambiguous");
    expect(() =>
      reviewedIntegratedRuntime(R, F, {
        ...reviews,
        admissions: [{ ...reviews.admissions[1]!, frozenCodeHash: R }],
      }),
    ).toThrow("review");
  });
  it("preserves exact registered contracts and initialization under a reviewed new executable", async () => {
    const next = reviewedIntegratedRuntime(R, F, reviews);
    for (const [kind, expected] of [
      ["O1", "sha256:f9192e317f4c3976d1f86e01c6b8ae68ec53ce92645cc7b6e3a0e3bfd0331b61"],
      ["S07", "sha256:63c0dd9b864b3e51b8ea2a9608f584cf75767d04a80c8bee8a13a9092627bc13"],
    ] as const) {
      const old = await integratedRegistry(kind, F);
      expect(old.contractHash).toBe(expected);
      expect(canonicalSeriesJson(await integratedRegistry(kind, next.frozenCodeHash))).toBe(
        canonicalSeriesJson(old),
      );
      expect(
        canonicalSeriesJson(await prepareIntegratedInitialization(kind, next.frozenCodeHash)),
      ).toBe(canonicalSeriesJson(await prepareIntegratedInitialization(kind, F)));
    }
  });
  it("excludes only review metadata from its own digest and still hashes the validator", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "integrated-runtime-admission-"));
    try {
      await mkdir(path.join(root, "src/lib"), { recursive: true });
      const validator = await readFile("src/lib/integratedAllocationRuntimeAdmission.ts", "utf8");
      await writeFile(
        path.join(root, "src/lib/integratedAllocationRuntimeAdmission.ts"),
        validator,
      );
      await writeFile(
        path.join(root, "src/lib/integratedAllocationRuntimeAdmissions.json"),
        JSON.stringify(reviews),
      );
      const manifest = () =>
        shadowEngineManifest(root, ["src/lib/integratedAllocationRuntimeAdmission.ts"], "test", [
          "/integratedAllocationRuntimeAdmissions.json",
        ]);
      const old = await manifest();
      await writeFile(
        path.join(root, "src/lib/integratedAllocationRuntimeAdmissions.json"),
        JSON.stringify({ ...reviews, version: "changed" }),
      );
      expect((await manifest()).codeHash).toBe(old.codeHash);
      await writeFile(
        path.join(root, "src/lib/integratedAllocationRuntimeAdmission.ts"),
        validator.replace(
          "return Object.freeze({ ...review })",
          "return Object.freeze({ ...review, altered: true })",
        ),
      );
      expect((await manifest()).codeHash).not.toBe(old.codeHash);
      expect(Object.keys(old.manifest.files)).toEqual([
        "src/lib/integratedAllocationRuntimeAdmission.ts",
      ]);
      const builder = await readFile("scripts/integrated-allocation-code-manifest.ts", "utf8");
      expect(builder).toContain('"/integratedAllocationRuntimeAdmissions.json"');
      expect(builder).not.toContain('"/integratedAllocationRuntimeAdmission"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
