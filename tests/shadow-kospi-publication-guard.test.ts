import { expect, it } from "vitest";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  kospiShadowPublicationManifest,
  KOSPI_SHADOW_PUBLICATION_ROOTS,
} from "../scripts/kospi-shadow-code-manifest";
import {
  verifyKospiShadowRuntimeManifest,
  canonicalKospiBootstrapJson,
} from "../scripts/verify-kospi-shadow-runtime";
import { verifyShadowRuntimeManifests } from "../scripts/verify-shadow-runtime-manifests";
import { shadowEngineManifest } from "../scripts/october-shadow-code-manifest";
import { integratedAllocationRuntimeManifest } from "../scripts/integrated-allocation-code-manifest";
import { reviewedKospiShadowRuntime } from "../src/lib/kospiShadowRuntimeAdmission";

const GENERATED = "src/lib/kospiShadowPublicationRuntime.generated.json";
const ADMISSIONS = "src/lib/kospiShadowRuntimeAdmissions.json";
const REVIEW_VERSION = "kospi-shadow-publication-runtime-admissions-v1";

it("native bootstrap canonicalization matches existing finite JSON provenance", () => {
  for (const value of [null, true, 3.125, "한글\n", [], { z: [1, false, null], a: { b: "x" } }])
    expect(canonicalKospiBootstrapJson(value)).toBe(canonicalSeriesJson(value));
  for (const value of [undefined, NaN, Infinity, { a: undefined }])
    expect(() => canonicalKospiBootstrapJson(value)).toThrow();
});

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

it("rejects source and config mutations before evaluation, including regenerated unreviewed candidates", async () => {
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
      "src/lib/ledger/octoberShadowCalendarEvidence.json",
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
    const sentinel = path.join(root, "evaluation-sentinel");
    const verifyCli = (args: string[] = []) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/verify-kospi-shadow-runtime.ts", ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 20000,
          env: {
            PATH: process.env["PATH"] ?? "",
            SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-secret",
            KOSPI_TEST_SENTINEL: sentinel,
          },
        },
      );
    const acceptedCli = verifyCli();
    expect(acceptedCli.error).toBeUndefined();
    expect(acceptedCli.status, acceptedCli.stderr).toBe(0);
    expect(acceptedCli.stdout).toContain('{"stage":"KOSPI_RUNTIME_VERIFIED"}');
    // Real native bootstrap -> fixed Vite config -> runner, with exact argument forwarding.
    for (const date of ["", "2026-10-15", "2026-10-14"]) {
      const launched = verifyCli(["--launch", "--", "--initialize-correction", "--as-of", date]);
      expect(launched.status, launched.stderr).toBe(1);
      expect(launched.stderr).toContain(
        date === "2026-10-14"
          ? "separate manual publication"
          : "explicitly supplied --as-of 2026-10-14",
      );
      expect(launched.stderr).not.toContain("preflight failed");
    }
    const economicBaseline = await verifyShadowRuntimeManifests(root);
    for (const file of [...KOSPI_SHADOW_PUBLICATION_ROOTS, "scripts/source-registry-store.ts"]) {
      const target = path.join(root, file),
        original = await readFile(target, "utf8");
      await writeFile(
        target,
        `${original}\nimport { writeFileSync as writeMutationSentinel } from "node:fs";\nwriteMutationSentinel(process.env["KOSPI_TEST_SENTINEL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "absent");\n`,
      );
      const changed = await kospiShadowPublicationManifest(root);
      expect(changed.codeHash).not.toBe(baseline.codeHash);
      await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Stale KOSPI Shadow");
      {
        const staleCli = verifyCli(["--launch", "--", "--as-of", "2026-10-14"]);
        expect(staleCli.error).toBeUndefined();
        expect(staleCli.status).toBe(1);
        expect(staleCli.stderr).toContain("KOSPI publication runtime preflight failed");
        await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await verifyShadowRuntimeManifests(root)).toEqual(economicBaseline);
      await writeFile(path.join(root, GENERATED), JSON.stringify(changed));
      await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow(
        "Unreviewed KOSPI Shadow",
      );
      {
        const unreviewedCli = verifyCli(["--launch", "--", "--as-of", "2026-10-14"]);
        expect(unreviewedCli.error).toBeUndefined();
        expect(unreviewedCli.status).toBe(1);
        expect(unreviewedCli.stderr).toContain("KOSPI publication runtime preflight failed");
        await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(JSON.parse(await readFile(path.join(root, ADMISSIONS), "utf8"))).toEqual(approved);
      await writeFile(target, original);
      await writeFile(path.join(root, GENERATED), JSON.stringify(baseline));
      expect(await verifyKospiShadowRuntimeManifest(root)).toEqual({
        kospiRuntimeCodeHash: baseline.codeHash,
      });
    }
    const storeTarget = path.join(root, "src/lib/kospiShadowStore.ts");
    const storeBytes = await readFile(storeTarget);
    const alternate = path.join(root, "alternate");
    await mkdir(path.join(alternate, "engine"), { recursive: true });
    await writeFile(path.join(alternate, "kospiShadowStore.ts"), storeBytes);
    await writeFile(
      path.join(alternate, "engine/kospiShadow.ts"),
      `export * from ${JSON.stringify(path.join(root, "src/lib/engine/kospiShadow.ts"))};\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env["KOSPI_TEST_SENTINEL"]!, "redirected-import");\n`,
    );
    await rm(storeTarget);
    await symlink(path.join(alternate, "kospiShadowStore.ts"), storeTarget);
    // Raw content still matches; physical import resolution no longer does.
    expect(await readFile(storeTarget)).toEqual(storeBytes);
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow(
      "Non-regular or redirected",
    );
    expect(verifyCli(["--launch", "--"]).status).toBe(1);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(storeTarget);
    await writeFile(storeTarget, storeBytes);
    const library = path.join(root, "src/lib"),
      relocatedLibrary = path.join(root, "src/lib-physical");
    await rename(library, relocatedLibrary);
    await symlink(relocatedLibrary, library, "dir");
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow(
      "Non-regular or redirected",
    );
    expect(verifyCli(["--launch", "--"]).status).toBe(1);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(library);
    await rename(relocatedLibrary, library);
    expect(await verifyKospiShadowRuntimeManifest(root)).toEqual({
      kospiRuntimeCodeHash: baseline.codeHash,
    });
    for (const control of [GENERATED, ADMISSIONS]) {
      const original = path.join(root, control),
        moved = `${original}.regular`;
      await rename(original, moved);
      await symlink(moved, original);
      await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow(
        "Non-regular or redirected",
      );
      expect(verifyCli(["--launch", "--"]).status).toBe(1);
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(original);
      await rename(moved, original);
    }
    const shortened = structuredClone(baseline);
    delete shortened.manifest.files["scripts/source-registry-store.ts"];
    delete shortened.manifest.rawFiles["scripts/source-registry-store.ts"];
    await writeFile(path.join(root, GENERATED), JSON.stringify(shortened));
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Invalid KOSPI Shadow");
    shortened.codeHash = await hashSeriesValue(shortened.manifest);
    await writeFile(path.join(root, GENERATED), JSON.stringify(shortened));
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Unreviewed KOSPI Shadow");
    expect(verifyCli(["--launch", "--"]).status).toBe(1);
    const missingRaw = structuredClone(baseline);
    Reflect.deleteProperty(missingRaw.manifest, "rawFiles");
    missingRaw.codeHash = await hashSeriesValue(missingRaw.manifest);
    await writeFile(path.join(root, GENERATED), JSON.stringify(missingRaw));
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Incomplete KOSPI Shadow");
    for (const problem of [
      "missing-config",
      "unequal-file-sets",
      "traversal",
      "generated-self-reference",
    ] as const) {
      const candidate = structuredClone(baseline);
      if (problem === "missing-config") {
        delete candidate.manifest.files["scripts/kospi-shadow-runtime.config.ts"];
        delete candidate.manifest.rawFiles["scripts/kospi-shadow-runtime.config.ts"];
      } else if (problem === "unequal-file-sets") {
        delete candidate.manifest.rawFiles["scripts/run-kospi-shadow.ts"];
      } else {
        const badPath = problem === "traversal" ? "src/../outside.ts" : GENERATED;
        candidate.manifest.files[badPath] = `sha256:${"a".repeat(64)}`;
        candidate.manifest.rawFiles[badPath] = `sha256:${"a".repeat(64)}`;
      }
      candidate.codeHash = await hashSeriesValue(candidate.manifest);
      await writeFile(path.join(root, GENERATED), JSON.stringify(candidate));
      // Deliberately malformed fixture-only admission tests bootstrap structure, not review selection.
      await writeFile(
        path.join(root, ADMISSIONS),
        JSON.stringify({
          version: REVIEW_VERSION,
          admissions: [
            { runtimeCodeHash: candidate.codeHash, reviewId: "synthetic-invalid-structure" },
          ],
        }),
      );
      await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow(/Incomplete|Unsafe/);
      const invalid = verifyCli(["--launch", "--"]);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).not.toContain("KOSPI_RUNTIME_VERIFIED");
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await writeFile(path.join(root, GENERATED), JSON.stringify(baseline));
    await writeFile(
      path.join(root, ADMISSIONS),
      JSON.stringify({ version: REVIEW_VERSION, admissions: [] }),
    );
    expect(await kospiShadowPublicationManifest(root)).toEqual(baseline);
    await expect(verifyKospiShadowRuntimeManifest(root)).rejects.toThrow("Unreviewed KOSPI Shadow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

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
  const beforePublication = workflow.split(
    "      - name: Advance isolated immutable KOSPI model journal",
  )[0]!;
  expect(beforePublication).not.toContain("secrets.SUPABASE");
  expect(beforePublication).toContain(
    "run: node --experimental-strip-types scripts/verify-kospi-shadow-runtime.ts",
  );
  expect(workflow).toContain("scripts/verify-kospi-shadow-runtime.ts --launch --");
  const bootstrap = await readFile("scripts/verify-kospi-shadow-runtime.ts", "utf8");
  for (const imported of bootstrap.matchAll(/^import.*from "([^"]+)"/gm))
    expect(imported[1]).toMatch(/^node:/);
});

it("workflow blocks a blank or wrong correction date before invoking the runner", async () => {
  const workflow = await readFile(".github/workflows/kospi-shadow.yml", "utf8");
  const script = workflow
    .split("      - name: Advance isolated immutable KOSPI model journal\n")[1]
    ?.split("        run: |\n")[1]
    ?.split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  expect(script).toBeDefined();
  const root = await mkdtemp(path.join(tmpdir(), "kospi-workflow-guard-"));
  try {
    await writeFile(
      path.join(root, "node"),
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

import { createHash } from "node:crypto";
import { integratedCompatibilityScenario } from "./fixtures/integrated-runtime-compatibility-scenario";
import { buildSnapshot } from "../src/lib/screeningSnapshot";
import {
  ADOPTED_SERIES_KINDS,
  freezeRestartSeries,
  hashSeriesValue,
  canonicalSeriesJson,
  type FrozenModelSeries,
} from "../src/lib/ledger/modelSeries";
import {
  recordOctoberPublication,
  type KrModelPublication,
  type OctoberRun,
  type PreparedOctoberPublication,
} from "../src/lib/ledger/octoberShadowPipeline";
import type { OctoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import type { KrDailyInputArchive } from "../src/lib/ledger/octoberShadowArchive";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { ETF_POLICY, type EtfStrategySnapshot } from "../src/lib/engine/etfStrategy";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { AnalysisResult, ScreeningRow } from "../src/lib/engine/pipeline";
import { nextKrRegularSession } from "../src/lib/ledger/krShadowDecision";
import { getOperationalSignals } from "../src/lib/engine/operationalStrategy";

// Evidence is bounded to the October12 restart books through October14. It is not
// a claim about older books with delayed H60 exits or any post-cutover execution.
// Both executables receive identical synthetic provenance, isolating economics.
// Actual deployment/runtime hashes differ and must be recorded separately.
const PRE_CUTOVER_CODE = `sha256:${"a".repeat(64)}` as const;
const PRE_CUTOVER_SOURCE = `sha256:${"b".repeat(64)}` as const;
function preCutoverGate(
  date: string,
): import("../src/lib/engine/kospiMarketGate").KospiMarketGateEvidence {
  return {
    date,
    status: "NEUTRAL",
    issues: [],
    benchmarkDate: date,
    benchmarkAboveMa60: true,
    benchmarkAboveCloud: true,
    vkospiBelow30: true,
    foreignNet5dPositive: false,
    metCount: 3,
    evaluatedCount: 4,
    incomplete: false,
    vkospi: 15,
    volatilitySource: "VKOSPI",
    marketForeignNet5d: -10,
    marketForeignDates: [date],
  };
}
function preCutoverKrSource(date: string): KrModelPublication {
  const bar = {
    tradeDate: date,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1e6,
    tradingValue: 1e8,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  };
  const instruments = [
    {
      symbol: "000001",
      name: "Synthetic KOSPI",
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
    {
      symbol: "000002",
      name: "Synthetic KOSDAQ",
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
    {
      symbol: "000003",
      name: "Synthetic ETF",
      market: "KOSPI",
      instrumentType: "ETF",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
  ] as MarketDataset["instruments"];
  const strategy: EtfStrategySnapshot = {
    version: ETF_POLICY.version,
    date,
    previousDate: date === "2026-10-06" ? "2026-10-02" : "2026-10-06",
    eligible: false,
    score: 50,
    previousScore: 50,
    technical: 50,
    priority: 50,
    health: 50,
    environment: 50,
    environmentSource: "stock_sector",
    region: "KR",
    sector: "TECH",
    annualVolatility: 0.2,
    entryWeight: 0.075,
    underlyingClose: 100,
    underlyingMa60: 95,
    onset: false,
    rawOnset: false,
    entryState: "none",
    originDate: null,
    confirmationDate: null,
    confirmationIssues: [],
    averageTradingValue20: 1e8,
    dataStatus: "ready",
    krxReferenceDate: date,
    exit: null,
    issues: [],
  };
  const rows = instruments.map((instrument) => ({
    instrument,
    snapshot: { tradeDate: date },
    operatingScore10: 5,
    priority: { points: 5 },
    ...(instrument.instrumentType === "ETF" ? { etfStrategy: strategy } : {}),
  })) as ScreeningRow[];
  const dataset = {
    provider: "TEST_FIXTURE",
    version: "1",
    asOfDate: date,
    isLive: true,
    capabilities: {
      marketCap: true,
      fundamentals: true,
      etfFacts: true,
      sectors: true,
      investorFlow: true,
      volatilityIndex: true,
      exactTradingValue: true,
    },
    notes: [],
    sectors: [],
    tradeDates: ["2026-10-02", "2026-10-06", ...(date > "2026-10-06" ? [date] : [])],
    kospiGateDates: ["2026-10-02", "2026-10-06", ...(date > "2026-10-06" ? [date] : [])],
    instruments,
    bars: Object.fromEntries(instruments.map((i) => [i.symbol, [bar]])),
    indexSeries: [{ indexCode: "KOSPI", bars: [bar] }],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  } as unknown as MarketDataset;
  const next = nextKrRegularSession(date);
  const availableAt = next ? `${next}T08:00:00+09:00` : `${date}T23:50:00+09:00`;
  const decisionAt = next ? `${next}T08:10:00+09:00` : `${date}T23:55:00+09:00`;
  return {
    market: "KR",
    codeHash: PRE_CUTOVER_CODE,
    sourceHash: PRE_CUTOVER_SOURCE,
    availableAt,
    decisionAt,
    confirmedRegularClose: true,
    failedSymbols: 0,
    dataset,
    config: DEFAULT_SCORING_CONFIG,
    universeEvidence: {
      asOfDate: date === "2026-10-06" ? "2026-10-02" : "2026-10-06",
      sourceHash: PRE_CUTOVER_SOURCE,
      symbols: instruments.map((i) => i.symbol),
    },
    sourceEvidence: [{ sourceHash: PRE_CUTOVER_SOURCE, asOfDate: date, registeredAt: availableAt }],
    analysis: { asOfDate: date, calculatedAt: decisionAt, rows } as AnalysisResult,
    snapshot: {
      date,
      asOfDate: date,
      savedAt: availableAt,
      entries: [],
      marketGateStatus: "UNKNOWN",
      totalCount: 0,
      passedCount: 0,
      gradeACount: 0,
      gradeBCount: 0,
    },
  };
}

async function fiveBookPreCutoverScenario() {
  const registry = new Map<string, FrozenModelSeries>();
  const sessions = new Map<string, OctoberRun>();
  const prepared = new Map<string, PreparedOctoberPublication>();
  const archives = new Map<string, KrDailyInputArchive>();
  const store: OctoberShadowStore = {
    readKrInput: async (date, hash) => {
      const found = archives.get(hash);
      if (!found || found.date !== date) throw new Error("Missing synthetic archive");
      return structuredClone(found);
    },
    putKrInput: async (value) => {
      const hash = await hashSeriesValue(value);
      archives.set(hash, structuredClone(value));
      return { date: value.date, hash };
    },
    readPrepared: async (market, date) =>
      structuredClone(prepared.get(`${market}:${date}`) ?? null),
    prepare: async (value) => {
      const key = `${value.market}:${value.date}`;
      if (prepared.has(key)) throw new Error("Unexpected synthetic prepare collision");
      prepared.set(key, structuredClone(value));
      return value;
    },
    readSeries: async (id) => registry.get(id) ?? null,
    insertSeries: async (series) => {
      registry.set(series.bookId, structuredClone(series));
    },
    readLatest: async <T extends import("../src/lib/ledger/modelJournal").ModelJournalRun>(
      id: string,
    ) =>
      structuredClone(
        [...sessions.values()]
          .filter((run) => run.bookId === id)
          .sort((a, b) => b.receipt.date.localeCompare(a.receipt.date))[0] ?? null,
      ) as T | null,
    readSession: async <T extends import("../src/lib/ledger/modelJournal").ModelJournalRun>(
      id: string,
      date: string,
    ) => structuredClone(sessions.get(`${id}:${date}`) ?? null) as T | null,
    append: async (series, run, previous) => {
      const { stateHash, ...body } = run;
      expect(await hashSeriesValue(body)).toBe(stateHash);
      expect(run.previousStateHash).toBe(previous?.stateHash ?? null);
      sessions.set(
        `${series.bookId}:${run.receipt.date}`,
        structuredClone(run as unknown as OctoberRun),
      );
      return { reused: false, stateHash };
    },
  };
  for (const kind of ADOPTED_SERIES_KINDS.filter((value) => !value.startsWith("US_")))
    await store.insertSeries(
      await freezeRestartSeries({
        kind,
        frozenAt: "2026-10-09T00:00:00Z",
        codeHash: PRE_CUTOVER_CODE,
        sourceHash: PRE_CUTOVER_SOURCE,
      }),
    );
  const dates = ["2026-10-12", "2026-10-13", "2026-10-14"];
  for (const [index, date] of dates.entries()) {
    const input = preCutoverKrSource(date);
    const prior = index ? dates[index - 1]! : "2026-10-08";
    input.dataset.tradeDates = ["2026-10-08", ...dates.slice(0, index + 1)];
    input.dataset.kospiGateDates = input.dataset.tradeDates;
    // Entry13 for KOSDAQ and entry14 for confirmed KOSPI/ETF; a confirmed close drop makes accidental
    // early K4/E4 application observable, while MA60/score exits stay inactive.
    for (const instrument of input.dataset.instruments)
      input.dataset.bars[instrument.symbol] = input.dataset.tradeDates.map((day) => ({
        tradeDate: day,
        open: 1000,
        high: 1000,
        low: day === "2026-10-14" ? 650 : 1000,
        close: day === "2026-10-14" ? 650 : 1000,
        volume: 1e6,
        tradingValue: 1e9,
        marketCap: 1e10,
        foreignNetBuyValue: null,
        institutionNetBuyValue: null,
      }));
    for (const row of input.analysis.rows) {
      row.operatingScore10 = index === 0 ? 8 : 8.5;
      row.previousOperatingScore10 = index === 0 ? 7.5 : 8;
      row.previousOperatingScoreDate = prior;
      row.hardFilterPassed = true;
      row.hardFilterStatus = "PASS";
      row.grade = "A";
      row.totalScoreNormalized = 85;
      row.scoreDelta1d = index === 0 ? 5 : 0;
      Object.assign(
        row,
        getOperationalSignals(
          row.instrument.market,
          index === 0 ? 7.5 : 8,
          row.operatingScore10,
          true,
        ),
      );
      if (row.instrument.market === "KOSPI")
        row.kospiEntry = {
          version: "kospi-e8-confirm1-bear-rs-cross-v4",
          date,
          originDate: index <= 1 ? "2026-10-12" : null,
          confirmationDate: index === 1 ? date : null,
          state: index === 0 ? "pending" : index === 1 ? "confirmed" : "none",
          issues: [],
          rsAccel: 1,
          score: row.operatingScore10,
          originScore: index <= 1 ? 8 : null,
          eligible: index === 1,
          marketGate: { origin: preCutoverGate("2026-10-12"), confirmation: preCutoverGate(date) },
        };
      if (row.etfStrategy)
        Object.assign(row.etfStrategy, {
          eligible: true,
          date,
          previousDate: prior,
          score: 85,
          previousScore: index === 0 ? 79 : 85,
          rawOnset: index === 0,
          onset: index === 1,
          entryState: index === 0 ? "pending" : index === 1 ? "confirmed" : "none",
          originDate: index <= 1 ? "2026-10-12" : null,
          confirmationDate: index === 1 ? date : null,
          annualVolatility: 0.3,
          entryWeight: 0.05,
          underlyingClose: 650,
          underlyingMa60: 500,
          exit: null,
        });
    }
    input.snapshot = buildSnapshot({
      ...input.analysis,
      rows: input.analysis.rows.filter((row) => row.instrument.instrumentType === "STOCK"),
      kospiMarketGate: preCutoverGate(date),
      marketGate: { status: "NEUTRAL" },
    });
    input.universeEvidence = {
      asOfDate: prior,
      sourceHash: PRE_CUTOVER_SOURCE,
      symbols: input.dataset.instruments.map((value) => value.symbol),
    };
    const recorded = await recordOctoberPublication(store, input);
    expect(recorded.records).toHaveLength(5);
    const before = canonicalSeriesJson([...sessions]);
    expect(
      (await recordOctoberPublication(store, input)).records.every((entry) => entry.reused),
    ).toBe(true);
    expect(canonicalSeriesJson([...sessions])).toBe(before);
  }
  return {
    series: [...registry.values()],
    sessions: [...sessions.values()],
    archives: [...archives].map(([hash, value]) => ({ hash, value })),
    prepared: [...prepared.values()],
  };
}

it("preserves reviewed pre-cutover O1/S07 complete economic publications through October14", async () => {
  const publications: unknown[] = [];
  const summary = await integratedCompatibilityScenario((value) => publications.push(value));
  expect(publications).toHaveLength(6);
  // Captured by independently executing the identical fixture on the reviewed
  // pre-PR280 source tree at main3e2c40741b597080215d98c628826fdb0481eab9.
  expect(createHash("sha256").update(JSON.stringify({ summary, publications })).digest("hex")).toBe(
    "b89d46f8a5c1cd5f365c0d268298fb313c0f8d4d9b5fbd398d45531c3cbb7ff5",
  );
});

it("preserves all five restarted KR/ETF books through14 before K4/E4 applies", async () => {
  const result = await fiveBookPreCutoverScenario();
  expect(result.sessions).toHaveLength(15);
  const day14 = result.sessions.filter((run) => run.receipt.date === "2026-10-14");
  expect(day14).toHaveLength(5);
  expect(day14.every((run) => run.bookId.startsWith("adopted-shadow-2026-10-12-v1:"))).toBe(true);
  expect(canonicalSeriesJson(result)).not.toMatch(/"(?:K4|E4|H60|H60_CLOSE|H60_DEFERRED_OPEN)"/);
  expect(day14.every((run) => !Object.hasOwn(run.publication, "priceExitAmendment"))).toBe(true);
  const kospi = day14.find((run) =>
    run.bookId.endsWith(":KR_KOSPI"),
  )! as import("../src/lib/ledger/krAdoptedShadow").AdoptedKrRun;
  expect(kospi.result.trades).toHaveLength(1);
  expect(kospi.result.trades[0]).toMatchObject({
    entryDate: "2026-10-14",
    entryPrice: 1000,
    currentPrice: 650,
    status: "OPEN",
    exitReason: null,
  });
  const etf = day14.find((run) =>
    run.bookId.endsWith(":ETF_V02"),
  )! as import("../src/lib/ledger/etfAdoptedShadow").AdoptedEtfRun;
  expect(etf.result.state.positions).toHaveLength(1);
  expect(etf.result.state.positions[0]).toMatchObject({
    entryDate: "2026-10-14",
    entryPrice: "1000",
    mark: { price: "650" },
  });
  expect(etf.result.state.pendingExits).toEqual([]);
  for (const run of day14.filter((value) =>
    ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"].some((kind) => value.bookId.endsWith(`:${kind}`)),
  )) {
    const common = run as import("../src/lib/ledger/krAdoptedShadow").AdoptedKrRun;
    for (const trade of common.result.trades) {
      expect(trade.entryDate >= "2026-10-12").toBe(true);
      expect(trade.holdingDays).toBeLessThanOrEqual(3);
      expect(trade.exitReason ?? "").not.toContain("60거래일");
    }
  }
  // Captured from the identical fixture on reviewed pre-PR280 main3e2c4074;
  // current main1cbb4a31 independently produces byte-identical canonical output.
  const digest = createHash("sha256").update(canonicalSeriesJson(result)).digest("hex");
  expect(digest).toBe("26557023b26c8827c7456962abd51a0590e5cf3d09698477a576f7f4ae8c4722");
});
