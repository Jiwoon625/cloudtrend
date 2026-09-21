import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  DEFAULT_BACKTEST_PARAMS,
  runBacktest,
  type BacktestInputSeries,
  type BacktestParams,
} from "../src/lib/engine/backtestV4";
import {
  ANALYSIS_BUCKET,
  codeVersion,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";

interface BaselineConfig {
  symbols?: string[];
  limit?: number;
  includeEtf?: boolean;
  roundTripCostBps?: number;
  horizons?: number[];
  horizonDays?: number;
  sampleEvery?: number;
}

interface EtfV21Manifest {
  version: string;
  runId: string;
  rowCount: number;
  symbolCount: number;
  etfSymbolCount: number;
  missingSymbolCount: number;
  missingSymbols: string[];
  etfParquet: {
    file: string;
    bytes: number;
    sha256: string;
    rows: number;
  };
}

function argValue(args: string[], name: string, fallback: string) {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] ?? fallback) : fallback;
}

function userId() {
  const value = process.env["SUPABASE_USER_ID"] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("SUPABASE_USER_ID is required");
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = argValue(args, "--input", ".cache/etf-v21/compact.csv");
  const manifestPath = argValue(args, "--manifest", ".cache/etf-v21/manifest.json");
  const configPath = argValue(args, "--config", "config/backtest.etf-v21-baseline.json");
  const outputPath = argValue(args, "--output", "analysis-runs/etf-v21-baseline/result.json");

  const [csvText, manifestText, configText] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as EtfV21Manifest;
  const config = JSON.parse(configText) as BaselineConfig;

  const parsed = parseManualMarketData([csvText]);
  const selected = new Set((config.symbols ?? []).map((symbol) => symbol.trim().toUpperCase()));
  const pool = parsed.dataset.instruments
    .filter((instrument) => instrument.instrumentType === "ETF")
    .filter((instrument) => selected.size === 0 || selected.has(instrument.symbol))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(1, Math.round(config.limit ?? 1000)));

  const series: BacktestInputSeries[] = pool
    .map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market === "KOSDAQ" ? ("KOSDAQ" as const) : ("KOSPI" as const),
      sectorCode: instrument.sectorCode,
      sectorName: instrument.sectorName,
      bars: parsed.dataset.bars[instrument.symbol] ?? [],
    }))
    .filter((item) => item.bars.length > 0);

  if (series.length !== manifest.etfSymbolCount) {
    throw new Error(
      `ETF universe mismatch: manifest=${manifest.etfSymbolCount}, parsed=${series.length}`,
    );
  }

  const params: BacktestParams = {
    ...DEFAULT_BACKTEST_PARAMS,
    horizons: config.horizons ?? [5, 10, 20, 30, 40],
    horizonDays: config.horizonDays ?? 20,
    sampleEvery: config.sampleEvery ?? 5,
    roundTripCostBps: Math.max(0, config.roundTripCostBps ?? 30),
  };

  const result = runBacktest(series, params);
  const scoreOnset678 = result.scoreOnsets.filter(
    (row) => row.threshold === 6 || row.threshold === 7 || row.threshold === 8,
  );
  const oosPortfolio = result.strategyValidation.portfolioRows.filter((row) => row.split === "OOS");
  const oosCore40 = oosPortfolio.filter(
    (row) =>
      row.strategy === "e70-h40-u80-d30" || row.strategy === "e70-h40-u90-d30",
  );

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const uid = userId();
  const remoteRoot = `${uid}/results/etf-v21-baseline`;
  const payload = {
    schemaVersion: 1,
    experiment: "ETF_V21_BASELINE",
    createdAt,
    codeVersion: codeVersion(),
    source: {
      collectorVersion: manifest.version,
      collectorRunId: manifest.runId,
      parquetFile: manifest.etfParquet.file,
      parquetSha256: manifest.etfParquet.sha256,
      parquetRows: manifest.etfParquet.rows,
      configuredUniverse: manifest.etfSymbolCount + manifest.missingSymbolCount,
      canonicalEtfUniverse: manifest.etfSymbolCount,
      missingSymbolCount: manifest.missingSymbolCount,
      missingSymbols: manifest.missingSymbols,
    },
    design: {
      purpose:
        "Freeze the first expanded-universe ETF baseline before ETF-specific reweighting or rotation.",
      score:
        "Existing CloudTrend historical technical score; no ETF-specific Health reweighting in this baseline.",
      entry:
        "Existing score diagnostics plus frozen V6 70-point Onset strategy scenarios.",
      execution:
        "Signal at close, next-trading-day open entry, configured round-trip cost, existing strategy validation accounting.",
      horizons: params.horizons,
      primaryHorizon: params.horizonDays,
      roundTripCostBps: params.roundTripCostBps,
      sampleEvery: params.sampleEvery,
      benchmark:
        "No external market index is embedded in the ETF-only parquet; absolute/cross-sectional baseline is primary in this run.",
    },
    firstReadout: {
      parsedUniverse: series.length,
      from: result.from,
      to: result.to,
      observations: result.observations,
      validScoreDays: result.scoreDiagnostics.validScoreDays,
      missingScoreDays: result.scoreDiagnostics.missingScoreDays,
      firstScoreDate: result.scoreDiagnostics.firstScoreDate,
      oosStart: result.scoreDiagnostics.oosStart,
      scoreOnset678,
      oosCore40,
      scoreChangeRows: result.strategyValidation.scoreChangeRows,
      strongestByHorizon: result.summary.strongestByHorizon,
      stableFeatures: result.summary.stableFeatures,
      oosStableFeatures: result.summary.oosStableFeatures,
    },
    result,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");

  const client = trustedSupabaseClient();
  const versionedPath = `${remoteRoot}/${stamp}.json`;
  await uploadJson(client, versionedPath, payload);
  await uploadJson(client, `${remoteRoot}/latest.json`, {
    createdAt,
    codeVersion: payload.codeVersion,
    resultPath: versionedPath,
    source: payload.source,
    design: payload.design,
    firstReadout: payload.firstReadout,
  });

  const { data: readBack, error: readError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(versionedPath);
  if (readError || !readBack) throw new Error(`ETF baseline result read-back failed: ${readError?.message ?? "unknown"}`);

  process.stdout.write(
    JSON.stringify(
      {
        experiment: payload.experiment,
        source: payload.source,
        design: payload.design,
        firstReadout: payload.firstReadout,
        resultPath: versionedPath.replace(uid, "<user>"),
        resultBytes: readBack.size,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
