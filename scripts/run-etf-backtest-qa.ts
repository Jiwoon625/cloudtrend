import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ANALYSIS_BUCKET, trustedSupabaseClient } from "./analysis-run-store";
import { loadResearchTexts, parseSharedMarketData } from "./research-shared-input";
import { normalizeKrxSymbol } from "../src/lib/engine/manualDataset";
import { resolveSectorCode } from "../src/lib/engine/sectors";
import { visitDelimitedRows } from "../src/lib/sourceData";

const EXPECTED_ETF_SECTOR: Readonly<Record<string, string>> = Object.freeze({
  "091160": "SEMI", "091230": "SEMI", "395270": "SEMI", "396500": "SEMI", "455850": "SEMI",
  "305720": "BATTERY", "305540": "BATTERY", "364980": "BATTERY", "461950": "BATTERY", "462010": "BATTERY",
  "091180": "AUTO", "138540": "AUTO", "385520": "AUTO", "464600": "AUTO", "466930": "AUTO",
  "143860": "BIO", "227540": "BIO", "244580": "BIO", "253280": "BIO", "261070": "BIO",
  "266370": "IT_HW", "326240": "IT_HW", "363580": "IT_HW", "380340": "IT_HW", "487750": "IT_HW",
  "157490": "SOFTWARE", "365000": "SOFTWARE", "407820": "SOFTWARE", "427120": "SOFTWARE", "0105D0": "SOFTWARE",
  "091170": "FINANCE", "091220": "FINANCE", "102970": "FINANCE", "139270": "FINANCE", "140700": "FINANCE",
  "102960": "SHIP_DEF", "139230": "SHIP_DEF", "441540": "SHIP_DEF", "463250": "SHIP_DEF", "466920": "SHIP_DEF",
  "117680": "CHEM_STEEL", "139240": "CHEM_STEEL",
  "117460": "ENERGY", "139250": "ENERGY", "367770": "ENERGY", "377990": "ENERGY", "434730": "ENERGY",
  "139290": "CONSUMER", "227560": "CONSUMER", "228800": "CONSUMER", "266390": "CONSUMER", "266410": "CONSUMER",
  "228790": "HEALTH_SVC", "307510": "HEALTH_SVC", "464610": "HEALTH_SVC", "479850": "HEALTH_SVC", "0008T0": "HEALTH_SVC",
  "228810": "TELCO_MEDIA", "266360": "TELCO_MEDIA", "300950": "TELCO_MEDIA", "395290": "TELCO_MEDIA", "475050": "TELCO_MEDIA",
  "117700": "CONSTRUCT", "139220": "CONSTRUCT",
});

const EXPECTED = Object.keys(EXPECTED_ETF_SECTOR).sort();
const WARMUP = 130;

function hashBytes(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

function normalizeDate(value: string) {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 8) return "";
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function normalizeHeader(value: string) {
  return value.replace(/[\s_]/g, "").toLowerCase();
}

function num(value: string | undefined) {
  if (value == null) return null;
  const s = value.replace(/[, %₩원]/g, "").trim();
  if (!s || /^(null|none|nan|na|-)$/.test(s.toLowerCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface StageSeries {
  symbol: string;
  name: string;
  sourceSector: string;
  dates: Set<string>;
  closeByDate: Map<string, number>;
  rowCount: number;
}

async function main() {
  const userId = process.env["SUPABASE_USER_ID"] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("SUPABASE_USER_ID is required");
  const filename = process.env["ETF_STAGING_FILENAME"] ?? "trendscore_input_20260918_061658.csv";
  const stagingPath = `${userId}/source/backtest/${filename}`;
  const manifestPath = process.env["BACKTEST_SOURCE_MANIFEST"] ?? ".cache/cloudtrend-backtest-manifest.json";
  const cacheDir = process.env["BACKTEST_SOURCE_CACHE_DIR"] ?? ".cache/cloudtrend-backtest";

  const client = trustedSupabaseClient();
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(stagingPath);
  if (error || !data) throw new Error(`ETF staging download failed: ${error?.message ?? "unknown"}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  const text = decode(bytes);

  let header: string[] | null = null;
  let idxDate = -1;
  let idxSymbol = -1;
  let idxName = -1;
  let idxType = -1;
  let idxMarket = -1;
  let idxSector = -1;
  let idxClose = -1;

  const series = new Map<string, StageSeries>();
  const allEtfDates = new Set<string>();
  const seenPairs = new Set<string>();
  const duplicatePairs: string[] = [];
  let totalRows = 0;
  let etfRows = 0;
  let malformedRows = 0;

  visitDelimitedRows(text, (cells, rowIndex) => {
    if (rowIndex === 0) {
      header = cells.map(normalizeHeader);
      const find = (...names: string[]) => header!.findIndex((h) => names.includes(h));
      idxDate = find("date", "tradedate", "기준일", "일자");
      idxSymbol = find("symbol", "code", "종목코드", "단축코드");
      idxName = find("name", "종목명");
      idxType = find("type", "종류", "securitytype");
      idxMarket = find("market", "시장");
      idxSector = find("sector", "sectorcode", "섹터", "업종");
      idxClose = find("close", "종가");
      if (idxDate < 0 || idxSymbol < 0) throw new Error("date/symbol columns are required");
      return;
    }

    totalRows++;
    const date = normalizeDate(cells[idxDate] ?? "");
    const symbol = normalizeKrxSymbol(cells[idxSymbol] ?? "");
    if (!date || !symbol) {
      malformedRows++;
      return;
    }
    const type = (idxType >= 0 ? cells[idxType] ?? "" : "").trim().toUpperCase();
    const market = (idxMarket >= 0 ? cells[idxMarket] ?? "" : "").trim().toUpperCase();
    const isEtf = type.includes("ETF") || market === "ETF" || EXPECTED_ETF_SECTOR[symbol] !== undefined;
    if (!isEtf) return;

    etfRows++;
    allEtfDates.add(date);
    const key = `${date}|${symbol}`;
    if (seenPairs.has(key)) {
      if (duplicatePairs.length < 100) duplicatePairs.push(key);
    } else {
      seenPairs.add(key);
    }

    let s = series.get(symbol);
    if (!s) {
      s = {
        symbol,
        name: idxName >= 0 ? (cells[idxName] ?? "").trim() : "",
        sourceSector: idxSector >= 0 ? (cells[idxSector] ?? "").trim() : "",
        dates: new Set<string>(),
        closeByDate: new Map<string, number>(),
        rowCount: 0,
      };
      series.set(symbol, s);
    }
    s.rowCount++;
    s.dates.add(date);
    const close = idxClose >= 0 ? num(cells[idxClose]) : null;
    if (close != null) s.closeByDate.set(date, close);
  });

  const tradeDates = [...allEtfDates].sort();
  const globalMin = tradeDates[0] ?? null;
  const globalMax = tradeDates.at(-1) ?? null;
  const dateIndex = new Map(tradeDates.map((d, i) => [d, i]));

  const actualSymbols = [...series.keys()].sort();
  const missingExpected = EXPECTED.filter((s) => !series.has(s));
  const unexpected = actualSymbols.filter((s) => EXPECTED_ETF_SECTOR[s] === undefined);

  const perSymbol = EXPECTED.map((symbol) => {
    const s = series.get(symbol);
    if (!s) {
      return {
        symbol,
        expectedSector: EXPECTED_ETF_SECTOR[symbol],
        status: "missing_symbol",
        firstDate: null,
        lastDate: null,
        tradingDays: 0,
        leadingMissingTradeDays: null,
        internalMissingTradeDays: null,
        trailingMissingTradeDays: null,
        currentResolvedSector: null,
        mappingMatchesExpected: false,
      };
    }
    const dates = [...s.dates].sort();
    const firstDate = dates[0]!;
    const lastDate = dates.at(-1)!;
    const firstIdx = dateIndex.get(firstDate)!;
    const lastIdx = dateIndex.get(lastDate)!;
    const internalSpan = tradeDates.slice(firstIdx, lastIdx + 1);
    const internalMissing = internalSpan.filter((d) => !s.dates.has(d));
    const leading = firstIdx;
    const trailing = tradeDates.length - 1 - lastIdx;
    const currentResolvedSector = resolveSectorCode(symbol, s.name, true).code;
    const status =
      internalMissing.length > 0 || trailing > 0
        ? "collection_gap_candidate"
        : leading > 0
          ? "pre_listing_consistent"
          : "complete_from_global_start";
    return {
      symbol,
      name: s.name,
      expectedSector: EXPECTED_ETF_SECTOR[symbol],
      sourceSector: s.sourceSector || null,
      currentResolvedSector,
      mappingMatchesExpected: currentResolvedSector === EXPECTED_ETF_SECTOR[symbol],
      status,
      firstDate,
      lastDate,
      tradingDays: dates.length,
      rowCount: s.rowCount,
      leadingMissingTradeDays: leading,
      internalMissingTradeDays: internalMissing.length,
      internalMissingExamples: internalMissing.slice(0, 20),
      trailingMissingTradeDays: trailing,
    };
  });

  const { texts } = await loadResearchTexts(manifestPath, cacheDir);
  const core = parseSharedMarketData(texts).dataset;
  const existingEtfs = core.instruments
    .filter((i) => i.instrumentType === "ETF")
    .map((i) => i.symbol)
    .sort();
  const existingSet = new Set(existingEtfs);
  const symbolOverlap = actualSymbols.filter((s) => existingSet.has(s));

  let dateSymbolOverlapCount = 0;
  let closeConflictCount = 0;
  const closeConflictExamples: Array<{ symbol: string; date: string; staged: number; core: number }> = [];
  for (const symbol of symbolOverlap) {
    const staged = series.get(symbol)!;
    const coreBars = core.bars[symbol] ?? [];
    const coreByDate = new Map(coreBars.map((b) => [b.tradeDate, b.close]));
    for (const [date, close] of staged.closeByDate) {
      const coreClose = coreByDate.get(date);
      if (coreClose == null) continue;
      dateSymbolOverlapCount++;
      if (Math.abs(coreClose - close) > 1e-9) {
        closeConflictCount++;
        if (closeConflictExamples.length < 50)
          closeConflictExamples.push({ symbol, date, staged: close, core: coreClose });
      }
    }
  }

  const sectors = [...new Set(Object.values(EXPECTED_ETF_SECTOR))].sort();
  const expectedPerSector = Object.fromEntries(
    sectors.map((sector) => [
      sector,
      EXPECTED.filter((symbol) => EXPECTED_ETF_SECTOR[symbol] === sector).length,
    ]),
  );

  const readyByDate = new Map<string, Record<string, number>>();
  for (const date of tradeDates) readyByDate.set(date, Object.fromEntries(sectors.map((s) => [s, 0])));
  for (const symbol of EXPECTED) {
    const s = series.get(symbol);
    if (!s) continue;
    const dates = [...s.dates].sort();
    for (const date of dates.slice(WARMUP - 1)) {
      const sector = EXPECTED_ETF_SECTOR[symbol]!;
      readyByDate.get(date)![sector] = (readyByDate.get(date)![sector] ?? 0) + 1;
    }
  }

  const coverageBySector = Object.fromEntries(
    sectors.map((sector) => {
      const points = tradeDates.map((date) => ({ date, count: readyByDate.get(date)![sector] ?? 0 }));
      const firstAny = points.find((p) => p.count > 0)?.date ?? null;
      const fullCount = expectedPerSector[sector] as number;
      const firstFull = points.find((p) => p.count === fullCount)?.date ?? null;
      const nonzeroCounts = points.filter((p) => p.count > 0).map((p) => p.count);
      return [
        sector,
        {
          expectedEtfs: fullCount,
          firstPlAvailableDate: firstAny,
          firstFullCoverageDate: firstFull,
          minAvailableAfterStart: nonzeroCounts.length ? Math.min(...nonzeroCounts) : 0,
          maxAvailable: nonzeroCounts.length ? Math.max(...nonzeroCounts) : 0,
          latestAvailable: points.at(-1)?.count ?? 0,
        },
      ];
    }),
  );

  const years = [...new Set(tradeDates.map((d) => d.slice(0, 4)))];
  const yearEndCoverage = Object.fromEntries(
    years.map((year) => {
      const date = tradeDates.filter((d) => d.startsWith(year)).at(-1)!;
      return [year, { date, ...readyByDate.get(date)! }];
    }),
  );

  const mappingMismatches = perSymbol
    .filter((x) => x.status !== "missing_symbol" && !x.mappingMatchesExpected)
    .map((x) => ({
      symbol: x.symbol,
      name: "name" in x ? x.name : "",
      expectedSector: x.expectedSector,
      currentResolvedSector: x.currentResolvedSector,
      sourceSector: "sourceSector" in x ? x.sourceSector : null,
    }));

  const qa = {
    generatedAt: new Date().toISOString(),
    staging: {
      filename,
      path: stagingPath.replace(userId, "<user>"),
      bytes: bytes.byteLength,
      sha256: hashBytes(bytes),
      totalRows,
      etfRows,
      malformedRows,
      globalMinDate: globalMin,
      globalMaxDate: globalMax,
      distinctEtfSymbols: actualSymbols.length,
      expectedCount: EXPECTED.length,
      missingExpected,
      unexpected,
      duplicateDateSymbolCount: etfRows - seenPairs.size,
      duplicateExamples: duplicatePairs,
    },
    existingCoreComparison: {
      existingCoreEtfSymbols: existingEtfs.length,
      stagingEtfSymbols: actualSymbols.length,
      symbolOverlapCount: symbolOverlap.length,
      symbolOverlap,
      dateSymbolOverlapCount,
      closeConflictCount,
      closeConflictExamples,
    },
    perSymbol,
    mapping: {
      mismatchCount: mappingMismatches.length,
      mismatches: mappingMismatches,
    },
    plCoverage: {
      warmupBars: WARMUP,
      expectedPerSector,
      sectorSummary: coverageBySector,
      yearEnd: yearEndCoverage,
    },
    pass: {
      expected65Present: missingExpected.length === 0 && EXPECTED.length === 65,
      noDuplicateDateSymbol: etfRows === seenPairs.size,
      noInternalOrTrailingGapCandidates: perSymbol.every(
        (x) => x.status === "missing_symbol" || x.status === "pre_listing_consistent" || x.status === "complete_from_global_start",
      ),
      noCoreCloseConflicts: closeConflictCount === 0,
    },
  };

  await mkdir("analysis-runs", { recursive: true });
  const out = path.join("analysis-runs", "etf-backtest-qa.json");
  await writeFile(out, JSON.stringify(qa, null, 2), "utf8");
  process.stdout.write(JSON.stringify(qa, null, 2) + "\n");

  if (!qa.pass.expected65Present || !qa.pass.noDuplicateDateSymbol) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
