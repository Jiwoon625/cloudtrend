/** Local-only US A0 research driver. No credentials, network, database, or publication writes.
 * Install this file at scripts/run-adopted-us-full-period-backtest.ts with the companion utilities.
 * Run: npx vite-node --config vitest.adopted-us-backtest.config.ts
 *   scripts/run-adopted-us-full-period-backtest.ts -- --run-adopted-backtest --market us
 *   --manifest /private/input/manifest.json --out /private/new-run [--start YYYY-MM-DD]
 *   [--through YYYY-MM-DD] [--smoke-sessions 20]
 * Uses the unchanged prepare-adopted-us-backtest.py manifest.json contract and day streaming.
 * Extracted from run-adopted-full-period-backtest.ts; the original stays unchanged.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseUsProspectiveCsv } from "../src/lib/engine/usProspective";
import type { SeriesHash } from "../src/lib/ledger/modelSeries";
import {
  assertOrderedSessions,
  selectBacktestSessions,
} from "../src/lib/research/adoptedBacktestSessions";
import {
  initializeAdoptedUsBacktest,
  stepAdoptedUsBacktest,
  US_BACKTEST_INITIAL_CAPITAL,
  type AdoptedUsBacktestRun,
} from "../src/lib/research/adoptedUsBacktest";
import {
  fullPeriodBacktestMetrics,
  type BacktestNavPoint,
} from "../src/lib/research/backtestMetrics";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
type Market = "us";
export interface ReplayOptions {
  market: Market;
  manifest: string;
  out: string;
  start?: string;
  through?: string;
  smokeSessions?: number;
}
interface FileEvidence {
  path: string;
  sha256: string;
  bytes?: number;
}
interface UsManifest {
  version: "adopted-us-atomic-inputs-v1" | "adopted-us-cm-expanded-inputs-v1";
  annualBudgetPolicyId?: "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1";
  tradePricePolicyId?: "US_A0_COMPARISON_PRICE_8DP_LEDGER_V1";
  normalizerSource?: string;
  normalizerCodeHash?: string;
  calendar?: FileEvidence;
  sourceCoverageEndDate?: string;
  missingClosePolicyId?: "US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1";
  sourceClocks?: Array<{date: string; openAt: string; closeAvailableAt: string}>;
  /** Preserve the original runner's optional selected-range end override. */
  throughDate?: string;
  sessions: string[];
  files: Array<{
    date: string;
    file: string;
    bytes: number;
    sha256: string;
    rows: number;
    marketDataComplete?: boolean;
  }>;
  featureWarmup?: {
    requiredPriorSessions: number;
    canonicalSourceStart: string;
    earliestEvaluationDate: string | null;
    firstOutputDate: string;
    priorSessionsBeforeFirstOutput: number;
    completeRowsOnFirstOutput: number;
  };
  preparationMetrics?: { elapsedSeconds: number; maxRssKiB: number };
  featureSource: string;
  featureCodeHash: string;
  canonical: Array<FileEvidence & { firstDate: string; lastDate: string }>;
  benchmark: FileEvidence;
  master: FileEvidence;
  sectorMap?: FileEvidence;
  limitations?: string[];
}
const digest = (value: string | Buffer): SeriesHash =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const assertHash = (hash: unknown) => {
  if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash))
    throw new Error("Expected sha256:<64 lowercase hex> provenance");
};
async function hashFile(file: string): Promise<SeriesHash> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}
async function verifyFile(base: string, entry: FileEvidence, requireBytes = false) {
  if (!entry || typeof entry.path !== "string" || !entry.path || /^\w+:\/\//.test(entry.path))
    throw new Error("Only explicit local file paths are supported");
  assertHash(entry.sha256);
  if (
    (requireBytes || entry.bytes !== undefined) &&
    (!Number.isSafeInteger(entry.bytes) || entry.bytes! < 0)
  )
    throw new Error("File byte count is required");
  const file = path.resolve(base, entry.path);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Input is not a regular file: ${file}`);
  if (entry.bytes !== undefined && info.size !== entry.bytes)
    throw new Error(`File byte mismatch: ${file}`);
  if ((await hashFile(file)) !== entry.sha256) throw new Error(`File SHA mismatch: ${file}`);
  return { file, bytes: info.size, sha256: entry.sha256 };
}
async function readVerifiedText(base: string, entry: FileEvidence) {
  const info = await verifyFile(base, entry, true);
  const data = await readFile(info.file);
  // Verify the bytes actually parsed as well, closing the preflight/read race.
  if (digest(data) !== entry.sha256)
    throw new Error(`Input changed after verification: ${info.file}`);
  return (info.file.endsWith(".gz") ? gunzipSync(data) : data).toString("utf8");
}
async function codeFingerprint() {
  const names: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of (await readdir(path.join(ROOT, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (/\.(ts|json)$/.test(name) && !name.includes(".test.")) names.push(name);
    }
  };
  await walk("src/lib");
  names.push(
    "scripts/run-adopted-us-full-period-backtest.ts",
    "collectors/lite_r3/runtime/us_feature_core.py",
    "scripts/prepare-adopted-us-cm-inputs.py",
    "scripts/adopted-us-cm-inputs.py",
    "scripts/audit_us_math.py",
  );
  const files = [];
  for (const name of names.sort())
    files.push({ path: name, sha256: await hashFile(path.join(ROOT, name)) });
  return { sha256: digest(JSON.stringify(files)), files };
}
async function json(out: string, name: string, data: unknown) {
  await writeFile(path.join(out, name), `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}
async function lines(out: string, name: string, rows: unknown[]) {
  await writeFile(
    path.join(out, name),
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    { mode: 0o600, flag: "wx" },
  );
}
function metrics(
  nav: BacktestNavPoint[],
  start: string,
  capital: string | number,
  smoke: boolean,
  expected: string[],
) {
  const calculated = fullPeriodBacktestMetrics({
    dailyNAV: nav,
    startDate: start,
    initialCapital: capital,
  });
  const exactCoverage =
    nav.length === expected.length && nav.every((point, i) => point.date === expected[i]);
  if (smoke || !exactCoverage || calculated.status !== "COMPLETE")
    return {
      status: smoke ? "SAMPLE_INCOMPLETE" : "INCOMPLETE",
      reason: smoke
        ? "Smoke sample cannot establish full-period performance"
        : !exactCoverage
          ? "Session coverage is incomplete"
          : "Missing or stale valuation",
      startDate: start,
      endDate: nav.at(-1)?.date ?? null,
      observations: nav.length,
      annualization: calculated.annualization,
      initialCapital: capital,
      cumulativeReturn: null,
      cagr: null,
      mdd: null,
      missingValuationCount: calculated.missingValuationCount,
      staleValuationCount: calculated.staleValuationCount,
      terminalValuation: calculated.terminalValuation,
    };
  return calculated;
}

export async function runAdoptedUsFullPeriodBacktest(options: ReplayOptions) {
  if (options.market !== "us") throw new Error("US-only runner requires market us");
  const started = performance.now();
  const manifestPath = await realpath(options.manifest);
  const base = path.dirname(manifestPath);
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8")) as UsManifest;
  assertOrderedSessions(manifest.sessions);
  const sourceManifestHash = digest(bytes);
  const smoke = options.smokeSessions !== undefined;
  const start = options.start ?? manifest.sessions[0]!;
  const through = options.through ?? manifest.throughDate ?? manifest.sessions.at(-1)!;
  const sessions = selectBacktestSessions(manifest.sessions, start, through, options.smokeSessions);
  const end = sessions.at(-1)!;
  const code = await codeFingerprint();
  const sourceFiles: Array<{ file: string; bytes: number; sha256: string }> = [];
  const us = manifest;
  const expanded = us.version === "adopted-us-cm-expanded-inputs-v1";
  if (
    (!expanded && us.version !== "adopted-us-atomic-inputs-v1") ||
    !Array.isArray(us.files) ||
    !Array.isArray(us.canonical) ||
    !us.canonical.length
  )
    throw new Error("Expected prepare-adopted-us-backtest.py manifest");
  if (
    us.featureSource !== (expanded
      ? "research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_closeadj_features.py"
      : "collectors/lite_r3/runtime/us_feature_core.py") ||
    us.featureCodeHash !== (await hashFile(path.join(ROOT, us.featureSource)))
  )
    throw new Error("Prepared US features do not match the current production feature function");
  if (expanded && (us.normalizerSource !== "research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_prepare_comparison.py"
    || us.normalizerCodeHash !== await hashFile(path.join(ROOT, us.normalizerSource))
    || !us.calendar || !us.sourceCoverageEndDate || !us.sourceClocks
    || us.missingClosePolicyId !== "US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1"
    || us.annualBudgetPolicyId !== "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1"
    || us.tradePricePolicyId !== "US_A0_COMPARISON_PRICE_8DP_LEDGER_V1"))
    throw new Error("Expanded normalization/calendar/policy provenance is required");
  if (
    us.files.length !== us.sessions.length ||
    us.files.some((file, i) => file.date !== us!.sessions[i])
  )
    throw new Error("US manifest file calendar mismatch");
  for (const file of [
    ...us.canonical,
    us.benchmark,
    us.master,
    ...(us.sectorMap ? [us.sectorMap] : []),
    ...(us.calendar ? [us.calendar] : []),
  ])
    sourceFiles.push(await verifyFile(base, file));
  if (smoke && !us.canonical.some((file) => file.firstDate < start))
    throw new Error("Smoke requires genuine canonical history before portfolio start");
  const warmup = us.featureWarmup;
  if (
    !smoke &&
    (!warmup ||
      warmup.requiredPriorSessions !== 252 ||
      warmup.canonicalSourceStart !== us.canonical[0]?.firstDate ||
      warmup.firstOutputDate !== us.sessions[0] ||
      !Number.isSafeInteger(warmup.priorSessionsBeforeFirstOutput) ||
      warmup.priorSessionsBeforeFirstOutput + us.sessions.indexOf(start) < 252 ||
      !warmup.earliestEvaluationDate ||
      warmup.earliestEvaluationDate > start)
  )
    throw new Error("Full US replay requires verified 252-session canonical feature warmup");
  // Preflight the whole declared input, even for smoke; never silently accept corrupt future files.
  for (const file of us.files) {
    if (
      path.basename(file.file) !== file.file ||
      (!file.file.endsWith(".csv") && !file.file.endsWith(".csv.gz")) ||
      !Number.isSafeInteger(file.rows) ||
      file.rows < 1
    )
      throw new Error("Invalid prepared US daily file");
    sourceFiles.push(await verifyFile(base, { ...file, path: file.file }, true));
  }
  const out = path.resolve(options.out);
  // Always a new directory; refusing reuse prevents clobbering originals or earlier results.
  await mkdir(out, { recursive: false, mode: 0o700 });
  await chmod(out, 0o700);
  const summary: Record<string, unknown> = {};
  const quality: Record<string, unknown> = {
    mode: smoke ? "SAMPLE_INCOMPLETE" : "SELECTED_RANGE_REPLAY",
    market: options.market,
    requestedStart: start,
    requestedThrough: through,
    evaluatedStart: start,
    evaluatedThrough: end,
    sessions: sessions.length,
    sourceManifestHash,
    codeHash: code.sha256,
    inputFiles: sourceFiles,
    sourceSessions: manifest.sessions.length,
    sourceCalendarStart: manifest.sessions[0],
    sourceCalendarEnd: manifest.sessions.at(-1),
    featureWarmup: us.featureWarmup ?? null,
    preparationMetrics: us.preparationMetrics ?? null,
    terminalPositionsLiquidated: false,
    currentRulesAppliedToHistory: true,
    independentOutOfSample: false,
    originalSourceFilesModified: false,
    limitations: [
      ...(manifest.limitations ?? []),
      "Retrospective current rules and current-universe/sector metadata; not independent out-of-sample evidence.",
      "Source adjustment and corporate-action/dividend completeness are not certified by this runner.",
      "Full earlier source history is retained; no fixed 252-session truncation.",
      "A complete selected range does not assert completeness of the entire available historical market.",
    ],
  };
  try {
    await json(out, "provenance.json", {
      manifest: JSON.parse(bytes.toString("utf8")),
      sourceManifestHash,
      code,
    });
    const contract = await initializeAdoptedUsBacktest({
      sessions,
      calendarSourceHash: digest(JSON.stringify(us.sessions)),
      sourceManifestHash,
      codeHash: code.sha256,
      ...(expanded ? {
        annualBudgetPolicy: {policyId: "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1" as const},
        tradePricePolicy: {policyId: "US_A0_COMPARISON_PRICE_8DP_LEDGER_V1" as const},
        missingClosePolicy: {
        policyId: "US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1" as const,
        sourceCoverageEndDate: us.sourceCoverageEndDate!,
        sessionClocks: us.sourceClocks!.filter((clock) => sessions.includes(clock.date)),
      }} : {}),
    });
    let previous: AdoptedUsBacktestRun | null = null;
    const nav: Array<BacktestNavPoint & Record<string, unknown>> = [];
    const trades: unknown[] = [];
    const symbols = new Set<string>();
    let totalRows = 0;
    const readiness: Array<{
      date: string;
      inputRows: number;
      completeFeatureRows: number;
      rankedRows: number;
    }> = [];
    const files = new Map(us.files.map((file) => [file.date, file]));
    for (const date of sessions) {
      const file = files.get(date)!;
      const rows = parseUsProspectiveCsv(
        await readVerifiedText(base, { ...file, path: file.file }),
      );
      if (rows.length !== file.rows || rows.some((row) => row.date !== date))
        throw new Error(`US dated row count/date mismatch: ${date}`);
      for (const row of rows) symbols.add(row.symbol);
      totalRows += rows.length;
      previous = await stepAdoptedUsBacktest(
        contract,
        { date, rows, sourceHash: file.sha256 as SeriesHash,
          ...(expanded ? { marketDataComplete: file.marketDataComplete === true } : {}) },
        previous,
      );
      const rankedRows = Object.keys(previous.rankState.coreRanks).length;
      const completeFeatureRows = rows.filter(
        (row) =>
          row.symbol !== "SPY" &&
          [
            row.ret120,
            row.ret252,
            row.beta60Spy,
            row.ichimokuTkGap,
            row.relvol1_20,
            row.adv20Usd,
            row.amihud20,
          ].every((value) => value !== null && value !== undefined && Number.isFinite(value)),
      ).length;
      readiness.push({ date, inputRows: rows.length, completeFeatureRows, rankedRows });
      if (!smoke && date === start && (rankedRows === 0 || completeFeatureRows === 0))
        throw new Error(
          "Full US replay requires nonempty valid first-session features and Core ranks",
        );
      const result = previous.result;
      nav.push({
        date,
        nav: Number.isFinite(result.nav) ? result.nav : null,
        valuationStatus: !Number.isFinite(result.nav)
          ? "MISSING"
          : previous.staleMarkSymbols.length
            ? "STALE"
            : "COMPLETE",
        cash: result.state.modelCashExact ?? result.cash,
        positionCount: result.positionsCount,
        fees: result.feesUsd,
        staleMarkSymbols: previous.staleMarkSymbols,
        sourceHash: previous.sourceHash,
        stateHash: previous.stateHash,
      });
      trades.push(...result.trades);
    }
    if (previous?.date !== end) throw new Error("US replay did not finish the selected range");
    await json(out, "US_A0.contract.json", contract);
    await lines(out, "US_A0.daily-nav.jsonl", nav);
    await lines(out, "US_A0.trades.jsonl", trades);
    await json(out, "US_A0.final-state.json", previous.result.state);
    await json(out, "US_A0.yearly-budgets.json", {
      policy: expanded ? "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1" : "FIXED_INITIAL_CAPITAL_DIV_20_NO_REBALANCE",
      initialCapital: US_BACKTEST_INITIAL_CAPITAL,
      yearlyReset: expanded,
      ...(expanded ? {yearlyBudgets: previous.result.state.annualEntryBudgetResearch?.byYear} : {}),
    });
    summary["US_A0"] = metrics(nav, start, US_BACKTEST_INITIAL_CAPITAL, smoke, sessions);
    quality["dailySignalReadiness"] = readiness;
    quality["symbolCount"] = symbols.size;
    quality["parsedRows"] = totalRows;
    quality["canonicalSourceStart"] = us.canonical[0]?.firstDate;
    quality["canonicalSourceEnd"] = us.canonical.at(-1)?.lastDate;
    quality["staleNavSessions"] = nav.filter((row) => row.valuationStatus === "STALE").length;
    quality["elapsedSeconds"] = (performance.now() - started) / 1000;
    quality["maxRssKiB"] = process.resourceUsage().maxRSS;
    quality["heapUsedBytes"] = process.memoryUsage().heapUsed;
    quality["runStatus"] = "FINISHED";
    await json(out, "summary.json", summary);
    await json(out, "quality.json", quality);
    await writeFile(
      path.join(out, "report.md"),
      [
        `# Adopted rules ${smoke ? "SMOKE SAMPLE / INCOMPLETE" : "selected-range research"}`,
        "",
        `Range: ${start} through ${end}; ${sessions.length} actual sessions.`,
        "Current production scoring and adopted executors; no forced terminal liquidation.",
        expanded
          ? "US_A0 uses each year's prior-session NAV / 20 for new signals; no holding rebalance; prior pending intent budgets remain frozen."
          : "US_A0 uses fixed initial capital / 20 per new entry; no quarter/year rebalancing.",
        "Only COMPLETE non-smoke selected-range valuations publish return/CAGR/MDD. CAGR uses calendar days / 365.2425.",
        "",
        "See summary.json, quality.json, provenance.json and each book's daily-nav/trades/yearly-budgets files.",
        `Elapsed: ${quality["elapsedSeconds"]} seconds. Peak RSS: ${quality["maxRssKiB"]} KiB.`,
        "",
        ...(quality["limitations"] as string[]).map((line) => `- ${line}`),
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    return { out, summary, quality };
  } catch (error) {
    await json(out, "FAILED.json", {
      status: "INCOMPLETE",
      error: error instanceof Error ? error.message : String(error),
      elapsedSeconds: (performance.now() - started) / 1000,
      maxRssKiB: process.resourceUsage().maxRSS,
      summaryMetricsPublishable: false,
    });
    throw error;
  }
}

export function parseReplayArgs(argv: string[]): ReplayOptions {
  argv = argv.filter((arg) => arg !== "--run-adopted-backtest");
  const allowed = new Set([
    "--market",
    "--manifest",
    "--out",
    "--start",
    "--through",
    "--smoke-sessions",
  ]);
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--") || values.has(flag))
      throw new Error(`Invalid or duplicate CLI argument: ${flag}`);
    values.set(flag, value);
  }
  const market = values.get("--market") as Market;
  const manifest = values.get("--manifest");
  const out = values.get("--out");
  if (market !== "us" || !manifest || !out)
    throw new Error("Required: --market us --manifest <local JSON> --out <new private directory>");
  return {
    market,
    manifest,
    out,
    ...(values.has("--start") ? { start: values.get("--start")! } : {}),
    ...(values.has("--through") ? { through: values.get("--through")! } : {}),
    ...(values.has("--smoke-sessions")
      ? { smokeSessions: Number(values.get("--smoke-sessions")) }
      : {}),
  };
}
// vite-node --script discards its --config option and loads the application server.
// The explicit marker supports the lightweight research config without that side effect.
if (
  process.argv.includes("--run-adopted-backtest") ||
  (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
) {
  runAdoptedUsFullPeriodBacktest(parseReplayArgs(process.argv.slice(2)))
    .then(({ out, quality }) =>
      console.log(
        JSON.stringify({
          out,
          status: quality["runStatus"],
          mode: quality["mode"],
          sessions: quality["sessions"],
          elapsedSeconds: quality["elapsedSeconds"],
          maxRssKiB: quality["maxRssKiB"],
        }),
      ),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}
