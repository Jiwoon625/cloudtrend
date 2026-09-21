import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_BACKTEST_PARAMS,
  runBacktest,
  type BacktestInputSeries,
  type BacktestParams,
} from "../src/lib/engine/backtestV4";
import { normalizeKrxSymbol } from "../src/lib/engine/manualDataset";
import { resolveSectorCode } from "../src/lib/engine/sectors";
import type { DailyPrice } from "../src/lib/engine/types";
import { visitDelimitedRows } from "../src/lib/sourceData";
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

interface MutableSeries {
  symbol: string;
  name: string;
  market: "KOSPI" | "KOSDAQ";
  bars: DailyPrice[];
  dates: Set<string>;
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

function normalizeHeader(value: string) {
  return value.replace(/[\s_]/g, "").toLowerCase();
}

function normalizeDate(value: string | undefined) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 8
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    : "";
}

function num(value: string | undefined): number | null {
  if (value == null) return null;
  const normalized = value.replace(/[, %₩원]/g, "").trim();
  if (!normalized || /^(null|none|nan|na|-)$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEtfSeries(csvText: string): BacktestInputSeries[] {
  let header: string[] | null = null;
  const map = new Map<string, MutableSeries>();

  visitDelimitedRows(csvText, (cells, rowIndex) => {
    if (rowIndex === 0) {
      header = cells.map(normalizeHeader);
      return;
    }
    if (!header) return;

    const idx = (...names: string[]) => header!.findIndex((item) => names.includes(item));
    const value = (...names: string[]) => {
      const i = idx(...names);
      return i >= 0 ? cells[i] : undefined;
    };

    const symbol = normalizeKrxSymbol(value("symbol", "code", "종목코드", "단축코드"));
    const date = normalizeDate(value("date", "tradedate", "기준일", "일자"));
    const close = num(value("close", "종가"));
    if (!symbol || !date || close === null || !(close > 0)) return;

    const securityType = String(value("securitytype", "type", "종류") ?? "").toUpperCase();
    if (securityType !== "ETF") return;

    const name = String(value("name", "종목명") ?? symbol).trim() || symbol;
    const rawMarket = String(value("market", "시장") ?? "").toUpperCase();
    const market = rawMarket.includes("KOSDAQ") || rawMarket.includes("코스닥")
      ? ("KOSDAQ" as const)
      : ("KOSPI" as const);
    const open = num(value("open", "시가")) ?? close;
    const highRaw = num(value("high", "고가")) ?? Math.max(open, close);
    const lowRaw = num(value("low", "저가")) ?? Math.min(open, close);
    const high = Math.max(highRaw, open, close, lowRaw);
    const low = Math.min(lowRaw, open, close, highRaw);
    const volume = num(value("volume", "거래량")) ?? 0;
    const tradingValue = num(value("tradingvalue", "amount", "tradingamount", "거래대금"))
      ?? close * volume;

    const bar: DailyPrice = {
      tradeDate: date,
      open,
      high,
      low,
      close,
      volume,
      tradingValue,
      marketCap: num(value("marketcap", "시가총액")),
      foreignNetBuyValue: num(value("foreignnetbuyvalue", "foreignnet", "외국인순매수")),
      institutionNetBuyValue: num(
        value("institutionnetbuyvalue", "institutionnet", "기관순매수"),
      ),
      shortSellingVolumeRate: null,
      lendingBalanceQuantity: null,
    };

    const existing = map.get(symbol);
    if (existing) {
      if (!existing.dates.has(date)) {
        existing.dates.add(date);
        existing.bars.push(bar);
      }
    } else {
      map.set(symbol, {
        symbol,
        name,
        market,
        bars: [bar],
        dates: new Set([date]),
      });
    }
  });

  return [...map.values()]
    .map((item) => {
      item.bars.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      const sector = resolveSectorCode(item.symbol, item.name, true);
      return {
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        sectorCode: sector.code,
        sectorName: sector.name,
        bars: item.bars,
      } satisfies BacktestInputSeries;
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
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

  const selected = new Set((config.symbols ?? []).map((symbol) => symbol.trim().toUpperCase()));
  const allSeries = parseEtfSeries(csvText);
  const series = allSeries
    .filter((item) => selected.size === 0 || selected.has(item.symbol))
    .slice(0, Math.max(1, Math.round(config.limit ?? 1000)));

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

  // The v2.1 ETF parquet intentionally contains ETF rows only. This baseline therefore
  // runs without a fabricated market-index context. Market-adjusted/regime fields remain
  // unavailable; absolute and cross-sectional results are the primary readout.
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
        "The canonical ETF parquet contains ETF rows only. No synthetic index was inserted; absolute/cross-sectional baseline is primary and market-adjusted/regime metrics are unavailable.",
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
  if (readError || !readBack)
    throw new Error(
      `ETF baseline result read-back failed: ${readError?.message ?? "unknown"}`,
    );

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
