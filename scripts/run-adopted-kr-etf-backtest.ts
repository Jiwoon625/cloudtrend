/** Local-only research driver. No credentials, network, database, or publication writes.
 * Run: npx vite-node --config vitest.adopted-backtest.config.ts
 *   scripts/run-adopted-kr-etf-backtest.ts -- --run-adopted-backtest --market kr-etf --manifest /private/input.json
 *   --start 2017-01-03 --through 2026-10-08 --out /private/new-run [--smoke-sessions 20]
 * KR/ETF manifest: {version:"adopted-kr-etf-inputs-v1",sessions:[...],
 *   files:[{path,bytes,sha256}],startDate?,throughDate?,limitations?:[]}
 * Smoke fixture instead of files: dataset:{path,bytes,sha256},sourceHash:"sha256:...".
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { CURRENT_RULES_RESEARCH } from "../src/lib/engine/operatingPolicyContext";
import { buildSnapshot, type ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import type { SeriesHash } from "../src/lib/ledger/modelSeries";
import {
  adoptedDatasetAsOf,
  assertOrderedSessions,
  assertResearchDataset,
  selectBacktestSessions,
} from "../src/lib/research/adoptedBacktestInput";
import { runAdoptedKrBacktest } from "../src/lib/research/adoptedKrBacktest";
import {
  runAdoptedEtfBacktest,
  type AdoptedEtfDatedSnapshot,
} from "../src/lib/research/adoptedEtfBacktest";
import {
  fullPeriodBacktestMetrics,
  type BacktestNavPoint,
} from "../src/lib/research/backtestMetrics";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
type Market = "kr" | "etf" | "kr-etf";
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
interface KrManifest {
  version: "adopted-kr-etf-inputs-v1";
  sessions: string[];
  files?: FileEvidence[];
  dataset?: FileEvidence;
  sourceHash?: string;
  startDate?: string;
  throughDate?: string;
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
  names.push("scripts/run-adopted-kr-etf-backtest.ts");
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

export async function runAdoptedFullPeriodBacktest(options: ReplayOptions) {
  if (!["kr", "etf", "kr-etf"].includes(options.market)) throw new Error("Unknown market");
  const started = performance.now();
  const manifestPath = await realpath(options.manifest);
  const base = path.dirname(manifestPath);
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8")) as KrManifest;
  assertOrderedSessions(manifest.sessions);
  const sourceManifestHash = digest(bytes);
  const smoke = options.smokeSessions !== undefined;
  const kr = manifest as KrManifest;
  const start = options.start ?? kr.startDate;
  if (!start)
    throw new Error("KR/ETF requires --start or manifest.startDate, after real source warmup");
  const through = options.through ?? kr.throughDate ?? manifest.sessions.at(-1)!;
  const sessions = selectBacktestSessions(manifest.sessions, start, through, options.smokeSessions);
  const end = sessions.at(-1)!;
  const code = await codeFingerprint();
  const sourceFiles: Array<{ file: string; bytes: number; sha256: string }> = [];
  let dataset: MarketDataset | undefined;
  {
    if (
      kr.version !== "adopted-kr-etf-inputs-v1" ||
      Boolean(kr.dataset) === Boolean(kr.files?.length)
    )
      throw new Error("KR/ETF manifest requires exactly one ordered files list or dataset fixture");
    if (kr.dataset) {
      if (!smoke) throw new Error("Serialized dataset fixtures are smoke-only");
      assertHash(kr.sourceHash);
      sourceFiles.push(await verifyFile(base, kr.dataset, true));
      dataset = JSON.parse(await readVerifiedText(base, kr.dataset)) as MarketDataset;
    } else {
      const texts: string[] = [];
      for (const file of kr.files!) {
        if (!/\.csv(\.gz)?$/i.test(file.path))
          throw new Error("KR/ETF sources must be canonical CSV or CSV.gz");
        sourceFiles.push(await verifyFile(base, file, true));
        texts.push(await readVerifiedText(base, file));
      }
      dataset = parseManualMarketData(texts).dataset;
    }
    assertResearchDataset(dataset);
    if (!dataset.tradeDates.some((date) => date < start))
      throw new Error("Input must retain real before-start history");
    const sourceSessions = dataset.tradeDates.filter((date) => date >= start && date <= end);
    if (JSON.stringify(sourceSessions) !== JSON.stringify(sessions))
      throw new Error("Declared selected sessions differ from canonical KOSPI session evidence");
    const known = new Set(manifest.sessions);
    if (
      Object.values(dataset.observedBars!).some((rows) =>
        rows.some(
          (row) => row.tradeDate >= start && row.tradeDate <= end && !known.has(row.tradeDate),
        ),
      )
    )
      throw new Error("Canonical observation outside the declared market calendar");
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
    {
      const raw = dataset!;
      const withKr = options.market !== "etf";
      const withEtf = options.market !== "kr";
      const snapshots: ScreeningSnapshot[] = [];
      const gates: Parameters<typeof runAdoptedKrBacktest>[0]["marketGates"] = {};
      const markets = Object.fromEntries(
        raw.instruments.map((instrument) => [instrument.symbol, instrument.market]),
      );
      const etfSymbols = raw.instruments
        .filter((instrument) => instrument.instrumentType === "ETF")
        .map((instrument) => instrument.symbol);
      if (withEtf && !etfSymbols.length)
        throw new Error("Requested ETF replay has no ETF instruments");
      let scoredEntries = 0;
      const signalQuality = {
        pendingStockEntries: 0,
        missingStockScores: 0,
        incompleteKospiGateSessions: 0,
      };
      const readiness = {
        scope: "SELECTED_SCORING_SESSIONS_ONLY_NOT_EARLIEST_SOURCE_HISTORY",
        entryReadyDefinition: "CURRENT_ENGINE_ELIGIBLE_ENTRY_SIGNAL_NOT_FILL",
        firstAnyValidScoreDate: { KOSPI: null, KOSDAQ: null, ETF: null } as Record<
          "KOSPI" | "KOSDAQ" | "ETF",
          string | null
        >,
        firstEntryReadyDate: { KOSPI: null, KOSDAQ: null, ETF: null } as Record<
          "KOSPI" | "KOSDAQ" | "ETF",
          string | null
        >,
        validScoreObservations: { KOSPI: 0, KOSDAQ: 0, ETF: 0 },
        entryReadyObservations: { KOSPI: 0, KOSDAQ: 0, ETF: 0 },
      };
      function* scoreSessions(): Generator<AdoptedEtfDatedSnapshot> {
        for (const date of sessions) {
          const sliced = adoptedDatasetAsOf(raw, date);
          const { analysis } = runFullMarketAnalysis(
            sliced,
            DEFAULT_SCORING_CONFIG,
            CURRENT_RULES_RESEARCH,
          );
          scoredEntries += analysis.rows.length;
          for (const row of analysis.rows) {
            const market = row.instrument.market;
            const score = market === "ETF" ? row.etfStrategy?.score : row.operatingScore10;
            const valid = typeof score === "number" && Number.isFinite(score);
            if (valid) {
              readiness.firstAnyValidScoreDate[market] ??= date;
              readiness.validScoreObservations[market]++;
            }
            const ready =
              market === "ETF"
                ? row.etfStrategy?.eligible === true &&
                  row.etfStrategy.dataStatus === "ready" &&
                  row.etfStrategy.onset
                : valid &&
                  row.hardFilterPassed &&
                  (row.pendingRules?.length ?? 0) === 0 &&
                  (market === "KOSPI" ? row.kospiEntry?.eligible === true : row.kosdaq80Onset);
            if (ready) {
              readiness.firstEntryReadyDate[market] ??= date;
              readiness.entryReadyObservations[market]++;
            }
          }
          for (const row of analysis.rows)
            if (row.instrument.instrumentType === "STOCK") {
              if (row.hardFilterStatus === "PENDING" || (row.pendingRules?.length ?? 0) > 0)
                signalQuality.pendingStockEntries++;
              if (row.operatingScore10 === null) signalQuality.missingStockScores++;
            }
          if (!analysis.kospiMarketGate || analysis.kospiMarketGate.incomplete)
            signalQuality.incompleteKospiGateSessions++;
          if (withKr) {
            // Do not retain evidence/top-list duplication. Preserve all stock entries and policy fields.
            const { topStocks: _stocks, topEtfs: _etfs, ...snapshot } = buildSnapshot(analysis);
            snapshot.entries = snapshot.entries.filter((entry) => entry.instrumentType === "STOCK");
            snapshots.push(snapshot);
            if (analysis.kospiMarketGate) gates[date] = analysis.kospiMarketGate;
          }
          yield {
            date,
            strategies: analysis.rows.flatMap((row) =>
              row.instrument.instrumentType === "ETF" && row.etfStrategy
                ? [{ symbol: row.instrument.symbol, strategy: row.etfStrategy }]
                : [],
            ),
          };
        }
      }
      const sourceCoverage = Object.fromEntries(
        ["KOSPI", "KOSDAQ", "ETF"].map((market) => {
          const instruments = raw.instruments.filter((i) => i.market === market);
          let firstDate: string | null = null,
            lastDate: string | null = null,
            rows = 0;
          for (const instrument of instruments) {
            const bars = raw.observedBars![instrument.symbol] ?? [];
            rows += bars.length;
            const first = bars[0]?.tradeDate,
              last = bars.at(-1)?.tradeDate;
            if (first && (!firstDate || first < firstDate)) firstDate = first;
            if (last && (!lastDate || last > lastDate)) lastDate = last;
          }
          return [market, { symbols: instruments.length, rows, firstDate, lastDate }];
        }),
      );
      quality["sourceCoverage"] = sourceCoverage;
      quality["sourceBarStart"] = raw.tradeDates[0];
      quality["sourceBarEnd"] = raw.asOfDate;
      quality["warmupSessions"] = raw.tradeDates.filter((date) => date < start).length;
      quality["symbolCount"] = raw.instruments.length;
      quality["stockSymbols"] = raw.instruments.length - etfSymbols.length;
      quality["etfSymbols"] = etfSymbols.length;
      quality["sourceObservedRows"] = Object.values(raw.observedBars!).reduce(
        (n, rows) => n + rows.length,
        0,
      );
      quality["syntheticFixture"] = Boolean(kr.dataset) || !raw.isLive;
      quality["undatedEtfFactsExcluded"] = Object.keys(raw.etfFacts).length;
      if (withEtf) {
        const result = await runAdoptedEtfBacktest({
          runId: `${smoke ? "smoke" : "selected"}-${sourceManifestHash.slice(7, 19)}-${start}-${end}`,
          startDate: start,
          endDate: end,
          sourceHash: sourceManifestHash,
          codeHash: code.sha256,
          calendar: {
            market: "KR",
            sourceHash: digest(JSON.stringify(manifest.sessions)),
            coverageStart: manifest.sessions[0]!,
            coverageEnd: manifest.sessions.at(-1)!,
            regularSessions: manifest.sessions,
          },
          etfSymbols,
          observedBars: raw.observedBars!,
          snapshots: scoreSessions(),
          includeRecords: false,
        });
        await lines(out, "ETF_V02.daily-nav.jsonl", result.dailyNav);
        await lines(out, "ETF_V02.trades.jsonl", result.fills);
        await json(out, "ETF_V02.contract.json", result.contract);
        await json(out, "ETF_V02.final-state.json", result.finalState);
        await json(out, "ETF_V02.yearly-budgets.json", {
          policy: "ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1",
          yearlyReset: true,
          years: result.finalState.researchYearAssetBases,
        });
        summary["ETF_V02"] = metrics(result.dailyNav, start, result.initialNav, smoke, sessions);
        quality["ETF_V02"] = result.quality;
      } else
        for (const _snapshot of scoreSessions()) {
          /* consume the shared scoring generator */
        }
      if (withKr)
        for (const scope of ["MIXED", "KOSPI", "KOSDAQ"] as const) {
          const result = runAdoptedKrBacktest({
            snapshots,
            bars: raw.observedBars!,
            markets,
            marketDates: manifest.sessions,
            marketGates: gates,
            startDate: start,
            throughDate: end,
            scope,
            fingerprint: sourceManifestHash,
            ...(raw.liquidSymbolCountsByDate
              ? { marketLiquidCounts: raw.liquidSymbolCountsByDate }
              : {}),
          });
          const book = scope === "MIXED" ? "KR_COMBINED_ADOPTED" : `${scope}_STANDALONE_DIAGNOSTIC`;
          await lines(out, `${book}.daily-nav.jsonl`, result.dailyNAV);
          await lines(out, `${book}.trades.jsonl`, result.trades);
          await json(out, `${book}.yearly-budgets.json`, result.yearlyBudgets);
          await json(out, `${book}.evidence.json`, result.evidence);
          await json(out, `${book}.accounting.json`, result.ledger.modelAccounting);
          summary[book] = metrics(
            result.dailyNAV,
            start,
            result.evidence.initialCapital,
            smoke,
            sessions,
          );
          quality[book] = {
            accountRole: result.evidence.accountRole,
            missingNavSessions: result.dailyNAV.filter((row) => row.valuationStatus === "MISSING")
              .length,
            staleNavSessions: result.dailyNAV.filter((row) => row.valuationStatus === "STALE")
              .length,
            tradeCount: result.trades.length,
            terminalOpenPositions: result.trades.filter((trade) => trade.status === "OPEN").length,
          };
        }
      quality["scoringSessions"] = sessions.length;
      quality["signalQuality"] = signalQuality;
      quality["signalReadiness"] = readiness;
      quality["scoredEntries"] = scoredEntries;
      quality["retainedStockSnapshots"] = snapshots.length;
      quality["retainedStockEntries"] = snapshots.reduce(
        (n, snapshot) => n + snapshot.entries.length,
        0,
      );
    }
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
        "KR_COMBINED_ADOPTED shares 30 slots; KOSPI/KOSDAQ standalone books are independent 30-slot diagnostics.",
        "KR yearly new-entry budget uses prior-year final-close NAV / 30; held quantities are not rebalanced.",
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
  if (!["kr", "etf", "kr-etf"].includes(market) || !manifest || !out)
    throw new Error(
      "Required: --market kr|etf|kr-etf --manifest <local JSON> --out <new private directory>",
    );
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
  runAdoptedFullPeriodBacktest(parseReplayArgs(process.argv.slice(2)))
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
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
