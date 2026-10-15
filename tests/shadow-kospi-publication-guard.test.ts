import { expect, it } from "vitest";
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  kospiShadowPublicationManifest,
  KOSPI_SHADOW_PUBLICATION_ROOTS,
} from "../scripts/kospi-shadow-code-manifest";
import { verifyKospiShadowRuntimeManifest } from "../scripts/verify-kospi-shadow-runtime";
import { verifyShadowRuntimeManifests } from "../scripts/verify-shadow-runtime-manifests";
import { shadowEngineManifest } from "../scripts/october-shadow-code-manifest";
import { integratedAllocationRuntimeManifest } from "../scripts/integrated-allocation-code-manifest";
import { reviewedKospiShadowRuntime } from "../src/lib/kospiShadowRuntimeAdmission";

const GENERATED = "src/lib/kospiShadowPublicationRuntime.generated.json";
const ADMISSIONS = "src/lib/kospiShadowRuntimeAdmissions.json";
const REVIEW_VERSION = "kospi-shadow-publication-runtime-admissions-v1";

it("covers each publication root and transitive executable dependency without altering old economic identities", async () => {
  const manifest = await kospiShadowPublicationManifest();
  for (const file of [
    ...KOSPI_SHADOW_PUBLICATION_ROOTS,
    "src/lib/engine/kospiShadow.ts",
    "scripts/source-registry-store.ts",
    "scripts/analysis-run-store.ts",
    "scripts/verify-kospi-shadow-runtime.ts",
    "scripts/kospi-shadow-code-manifest.ts",
    "scripts/october-shadow-code-manifest.ts",
    "src/lib/kospiShadowRuntimeAdmission.ts",
  ])
    expect(manifest.manifest.files).toHaveProperty(file);
  expect(manifest.manifest.files).not.toHaveProperty(GENERATED);
  expect(manifest.manifest.files).not.toHaveProperty(ADMISSIONS);
  expect(JSON.parse(await readFile(GENERATED, "utf8"))).toEqual(manifest);
  const previous = await verifyShadowRuntimeManifests();
  const october = JSON.parse(
    await readFile("src/lib/ledger/octoberShadowEngineManifest.generated.json", "utf8"),
  );
  const integrated = JSON.parse(
    await readFile("src/lib/integratedAllocationRuntime.generated.json", "utf8"),
  );
  expect(previous).toEqual({
    octoberRuntimeCodeHash: october.codeHash,
    integratedRuntimeCodeHash: integrated.codeHash,
  });
}, 30000);

it("requires an explicit exact-hash review and rejects duplicate or malformed admissions", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const entry = { runtimeCodeHash: hash, reviewId: "synthetic-reviewed-baseline" };
  expect(
    reviewedKospiShadowRuntime(hash, { version: REVIEW_VERSION, admissions: [entry] }),
  ).toEqual(entry);
  expect(() =>
    reviewedKospiShadowRuntime(hash, { version: REVIEW_VERSION, admissions: [] }),
  ).toThrow("Unreviewed");
  expect(() =>
    reviewedKospiShadowRuntime(hash, { version: REVIEW_VERSION, admissions: [entry, entry] }),
  ).toThrow("ambiguous");
  expect(() =>
    reviewedKospiShadowRuntime(hash, { version: "unknown", admissions: [entry] }),
  ).toThrow();
  expect(() =>
    reviewedKospiShadowRuntime(hash, {
      version: REVIEW_VERSION,
      admissions: [{ ...entry, reviewId: "" }],
    }),
  ).toThrow();
  expect(() =>
    reviewedKospiShadowRuntime(`sha256:${"b".repeat(64)}`, {
      version: REVIEW_VERSION,
      admissions: [entry],
    }),
  ).toThrow("Unreviewed");
});

it("rejects mutations to runner, revision, and store both before and after regeneration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kospi-publication-guard-"));
  try {
    const baseline = await kospiShadowPublicationManifest();
    const [october, integrated] = await Promise.all([
      shadowEngineManifest(),
      integratedAllocationRuntimeManifest(),
    ]);
    const fixtureFiles = new Set([
      ...Object.keys(baseline.manifest.files),
      ...Object.keys(october.manifest.files),
      ...Object.keys(integrated.manifest.files),
      "src/lib/ledger/octoberShadowEngineManifest.generated.json",
      "src/lib/integratedAllocationRuntime.generated.json",
    ]);
    for (const file of fixtureFiles) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), await readFile(file));
    }
    await writeFile(path.join(root, GENERATED), JSON.stringify(baseline));
    // Fixture-only explicit approval. Production generator cannot write this file.
    const approved = {
      version: REVIEW_VERSION,
      admissions: [{ runtimeCodeHash: baseline.codeHash, reviewId: "synthetic-reviewed-baseline" }],
    };
    await writeFile(path.join(root, ADMISSIONS), JSON.stringify(approved));
    expect(await kospiShadowPublicationManifest(root)).toEqual(baseline);
    expect(await verifyKospiShadowRuntimeManifest(root)).toEqual({
      kospiRuntimeCodeHash: baseline.codeHash,
    });
    await symlink(await realpath("node_modules"), path.join(root, "node_modules"), "dir");
    const verifyCli = () =>
      spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/vite-node/vite-node.mjs"),
          "--script",
          "scripts/verify-kospi-shadow-runtime.ts",
        ],
        { cwd: root, encoding: "utf8", timeout: 20000, env: { PATH: process.env["PATH"] ?? "" } },
      );
    const acceptedCli = verifyCli();
    expect(acceptedCli.error).toBeUndefined();
    expect(acceptedCli.status, acceptedCli.stderr).toBe(0);
    const economicBaseline = await verifyShadowRuntimeManifests(root);
    for (const file of KOSPI_SHADOW_PUBLICATION_ROOTS) {
      const target = path.join(root, file),
        original = await readFile(target, "utf8");
      await writeFile(target, `${original}\nexport const PUBLICATION_MUTATION_TEST = 1;\n`);
      const changed = await kospiShadowPublicationManifest(root);
      expect(changed.codeHash).not.toBe(baseline.codeHash);
      await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Stale KOSPI Shadow");
      if (file === KOSPI_SHADOW_PUBLICATION_ROOTS[0]) {
        const staleCli = verifyCli();
        expect(staleCli.error).toBeUndefined();
        expect(staleCli.status).toBe(1);
        expect(staleCli.stderr).toContain("KOSPI publication runtime preflight failed");
      }
      expect(await verifyShadowRuntimeManifests(root)).toEqual(economicBaseline);
      await writeFile(path.join(root, GENERATED), JSON.stringify(changed));
      await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow(
        "Unreviewed KOSPI Shadow",
      );
      if (file === KOSPI_SHADOW_PUBLICATION_ROOTS[0]) {
        const unreviewedCli = verifyCli();
        expect(unreviewedCli.error).toBeUndefined();
        expect(unreviewedCli.status).toBe(1);
        expect(unreviewedCli.stderr).toContain("KOSPI publication runtime preflight failed");
      }
      expect(JSON.parse(await readFile(path.join(root, ADMISSIONS), "utf8"))).toEqual(approved);
      await writeFile(target, original);
      await writeFile(path.join(root, GENERATED), JSON.stringify(baseline));
      expect(await verifyKospiShadowRuntimeManifest(root)).toEqual({
        kospiRuntimeCodeHash: baseline.codeHash,
      });
    }
    await writeFile(
      path.join(root, ADMISSIONS),
      JSON.stringify({ version: REVIEW_VERSION, admissions: [] }),
    );
    expect(await kospiShadowPublicationManifest(root)).toEqual(baseline);
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Unreviewed KOSPI Shadow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

it("wires independent generation and verification into build, dev, runner and CI", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  for (const key of ["prebuild", "predev"]) {
    expect(pkg.scripts[key]).toContain("build-kospi-shadow-manifest.ts");
    expect(pkg.scripts[key]).toContain("verify-kospi-shadow-runtime.ts");
    expect(pkg.scripts[key].indexOf("build-kospi-shadow-manifest.ts")).toBeLessThan(
      pkg.scripts[key].indexOf("verify-kospi-shadow-runtime.ts"),
    );
  }
  const runner = await readFile("scripts/run-kospi-shadow.ts", "utf8");
  expect(runner.indexOf("await verifyKospiShadowRuntimeManifest();")).toBeLessThan(
    runner.indexOf("const client = trustedSupabaseClient()"),
  );
  const generator = await readFile("scripts/build-kospi-shadow-manifest.ts", "utf8");
  expect(generator).not.toContain("kospiShadowRuntimeAdmissions.json");
  expect(await readFile("vitest.shadow.config.ts", "utf8")).toContain('"tests/shadow-*.test.ts"');
  const workflow = await readFile(".github/workflows/kospi-shadow.yml", "utf8");
  expect(workflow).toContain("npx vitest run --config vitest.shadow.config.ts");
  expect(workflow).toContain('"scripts/verify-kospi-shadow-runtime.ts"');
});

it("workflow blocks a blank or wrong correction date before invoking the runner", async () => {
  const workflow = await readFile(".github/workflows/kospi-shadow.yml", "utf8");
  const script = workflow
    .split("      - name: Advance isolated immutable KOSPI model journal\n        run: |\n")[1]
    ?.split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  expect(script).toBeDefined();
  const root = await mkdtemp(path.join(tmpdir(), "kospi-workflow-guard-"));
  try {
    await writeFile(
      path.join(root, "npx"),
      '#!/bin/sh\nprintf "RUNNER_SENTINEL:%s\\n" "$*"\nexit 42\n',
      { mode: 0o700 },
    );
    const execute = (date: string) =>
      spawnSync("bash", ["-c", script!], {
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env["PATH"]}`,
          INITIALIZE_CORRECTION: "true",
          SHADOW_AS_OF: date,
          SUPABASE_USER_ID: "synthetic-owner",
        },
      });
    for (const date of ["", " ", "2026-10-13", "2026-10-15"]) {
      const result = execute(date);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("RUNNER_SENTINEL");
    }
    const valid = execute("2026-10-14");
    expect(valid.status).toBe(42);
    expect(valid.stdout).toContain("--as-of 2026-10-14 --initialize-correction");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
