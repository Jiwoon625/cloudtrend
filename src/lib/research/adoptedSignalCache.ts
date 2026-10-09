/** Private, local-only current-engine signal transport. No source prices or account state. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { AnalysisResult } from "../engine/pipeline";
import { ETF_POLICY } from "../engine/etfStrategy";
import { KOSPI_CONSISTENCY_VERSION } from "../engine/kospiEntryConfirmation";
import type { KospiMarketGateEvidence } from "../engine/kospiMarketGate";
import type { SeriesHash } from "../ledger/modelSeries";
import { validDate } from "../ledger/date";
import { buildSnapshot, type ScreeningSnapshot } from "../screeningSnapshot";
import type { AdoptedEtfDatedSnapshot } from "./adoptedEtfBacktest";
import { assertOrderedSessions } from "./adoptedBacktestInput";

export const SIGNAL_CACHE_VERSION = "adopted-signal-cache-v1";
export const SIGNAL_CACHE_INDEX_VERSION = "adopted-signal-cache-index-v1";
export interface SignalCacheFile {
  path: string;
  bytes: number;
  sha256: SeriesHash;
}
export interface AdoptedSignalIdentity {
  version: typeof SIGNAL_CACHE_VERSION;
  sourceHash: SeriesHash;
  calendarHash: SeriesHash;
  actualCalendarHash: SeriesHash;
  codeHash: SeriesHash;
  policyHash: SeriesHash;
}
const markets = ["KOSPI", "KOSDAQ", "ETF"] as const;
type MarketCounts = Record<(typeof markets)[number], number>;
export interface AdoptedSignalRecord {
  date: string;
  /** Wall-clock generation time is audit metadata, never historical signal evidence. */
  krSnapshot: Omit<ScreeningSnapshot, "savedAt">;
  krGate: KospiMarketGateEvidence | null;
  etfSnapshot: AdoptedEtfDatedSnapshot;
  counters: {
    scoredEntries: number;
    pendingStockEntries: number;
    missingStockScores: number;
    incompleteKospiGateSessions: number;
    validScores: MarketCounts;
    entryReady: MarketCounts;
  };
}
export interface AdoptedSignalCacheManifest {
  version: typeof SIGNAL_CACHE_VERSION;
  identity: AdoptedSignalIdentity;
  identityHash: SeriesHash;
  /** Binds the shared source identity to this exact ordered evaluation-session selection. */
  selectionHash: SeriesHash;
  evaluationDates: string[];
  records: number;
  data: SignalCacheFile;
  audit: { createdAt: string; timestampRole: "GENERATION_TIME_ONLY_NOT_MARKET_EVIDENCE" };
}
export interface AdoptedSignalCacheIndex {
  version: typeof SIGNAL_CACHE_INDEX_VERSION;
  chunks: SignalCacheFile[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Non-finite signal cache number");
  return value;
}
export const signalCacheHash = (value: string | Buffer): SeriesHash =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const stableSignalHash = (value: unknown) =>
  signalCacheHash(JSON.stringify(canonical(value)));

/** Paths, registration/generation timestamps and preparation duration are intentionally absent. */
export function createAdoptedSignalIdentity(input: {
  sourceKind: "CANONICAL_CSV" | "SMOKE_DATASET";
  files: Array<{ bytes: number; sha256: string }>;
  sessions: string[];
  actualSessions: string[];
  extension: { afterDate: string; rows: number } | null;
  codeHash: SeriesHash;
  policy: unknown;
}): AdoptedSignalIdentity {
  assertOrderedSessions(input.sessions);
  assertOrderedSessions(input.actualSessions);
  for (const file of input.files) {
    assertHash(file.sha256);
    assertCount(file.bytes);
  }
  assertHash(input.codeHash);
  const calendarHash = stableSignalHash(input.sessions);
  const actualCalendarHash = stableSignalHash(input.actualSessions);
  return {
    version: SIGNAL_CACHE_VERSION,
    sourceHash: stableSignalHash({
      sourceKind: input.sourceKind,
      files: input.files.map(({ bytes, sha256 }) => ({ bytes, sha256 })),
      extension: input.extension,
      calendarHash,
      actualCalendarHash,
    }),
    calendarHash,
    actualCalendarHash,
    codeHash: input.codeHash,
    policyHash: stableSignalHash(input.policy),
  };
}
const zeroCounts = (): MarketCounts => ({ KOSPI: 0, KOSDAQ: 0, ETF: 0 });
export function adoptedSignalRecord(analysis: AnalysisResult): AdoptedSignalRecord {
  const {
    savedAt: _time,
    topStocks: _stocks,
    topEtfs: _etfs,
    ...krSnapshot
  } = buildSnapshot(analysis);
  krSnapshot.entries = krSnapshot.entries.filter((entry) => entry.instrumentType === "STOCK");
  const counters: AdoptedSignalRecord["counters"] = {
    scoredEntries: analysis.rows.length,
    pendingStockEntries: 0,
    missingStockScores: 0,
    incompleteKospiGateSessions:
      !analysis.kospiMarketGate || analysis.kospiMarketGate.incomplete ? 1 : 0,
    validScores: zeroCounts(),
    entryReady: zeroCounts(),
  };
  for (const row of analysis.rows) {
    const market = row.instrument.market;
    const score = market === "ETF" ? row.etfStrategy?.score : row.operatingScore10;
    const valid = typeof score === "number" && Number.isFinite(score);
    if (valid) counters.validScores[market]++;
    const ready =
      market === "ETF"
        ? row.etfStrategy?.eligible === true &&
          row.etfStrategy.dataStatus === "ready" &&
          row.etfStrategy.onset
        : valid &&
          row.hardFilterPassed &&
          (row.pendingRules?.length ?? 0) === 0 &&
          (market === "KOSPI" ? row.kospiEntry?.eligible === true : row.kosdaq80Onset);
    if (ready) counters.entryReady[market]++;
    if (row.instrument.instrumentType === "STOCK") {
      if (row.hardFilterStatus === "PENDING" || (row.pendingRules?.length ?? 0) > 0)
        counters.pendingStockEntries++;
      if (row.operatingScore10 === null) counters.missingStockScores++;
    }
  }
  return {
    date: analysis.asOfDate,
    krSnapshot,
    krGate: analysis.kospiMarketGate ?? null,
    etfSnapshot: {
      date: analysis.asOfDate,
      strategies: analysis.rows.flatMap((row) =>
        row.instrument.instrumentType === "ETF" && row.etfStrategy
          ? [{ symbol: row.instrument.symbol, strategy: row.etfStrategy }]
          : [],
      ),
    },
    counters,
  };
}
export function signalQualityAccumulator() {
  return {
    scoredEntries: 0,
    signalQuality: {
      pendingStockEntries: 0,
      missingStockScores: 0,
      incompleteKospiGateSessions: 0,
    },
    readiness: {
      scope: "SELECTED_SCORING_SESSIONS_ONLY_NOT_EARLIEST_SOURCE_HISTORY",
      entryReadyDefinition: "CURRENT_ENGINE_ELIGIBLE_ENTRY_SIGNAL_NOT_FILL",
      firstAnyValidScoreDate: { KOSPI: null, KOSDAQ: null, ETF: null } as Record<
        (typeof markets)[number],
        string | null
      >,
      firstEntryReadyDate: { KOSPI: null, KOSDAQ: null, ETF: null } as Record<
        (typeof markets)[number],
        string | null
      >,
      validScoreObservations: zeroCounts(),
      entryReadyObservations: zeroCounts(),
    },
  };
}
export function accumulateSignalQuality(
  target: ReturnType<typeof signalQualityAccumulator>,
  row: AdoptedSignalRecord,
) {
  target.scoredEntries += row.counters.scoredEntries;
  for (const key of [
    "pendingStockEntries",
    "missingStockScores",
    "incompleteKospiGateSessions",
  ] as const)
    target.signalQuality[key] += row.counters[key];
  for (const market of markets) {
    target.readiness.validScoreObservations[market] += row.counters.validScores[market];
    target.readiness.entryReadyObservations[market] += row.counters.entryReady[market];
    if (row.counters.validScores[market])
      target.readiness.firstAnyValidScoreDate[market] ??= row.date;
    if (row.counters.entryReady[market]) target.readiness.firstEntryReadyDate[market] ??= row.date;
  }
}
function assertHash(value: unknown): asserts value is SeriesHash {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid signal cache SHA-256");
}
function assertCount(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Invalid signal cache count");
}
function assertNoFutureDates(value: unknown, asOf: string, key = "") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoFutureDates(item, asOf, key);
  } else if (typeof value === "object") {
    for (const [name, item] of Object.entries(value)) assertNoFutureDates(item, asOf, name);
  } else if (/date(s)?$/i.test(key)) {
    if (typeof value !== "string" || !validDate(value) || value > asOf)
      throw new Error("Invalid or future signal evidence date");
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Non-finite signal cache number");
  }
}
export function assertAdoptedSignalRecord(
  value: unknown,
  expectedDate: string,
): asserts value is AdoptedSignalRecord {
  const row = value as AdoptedSignalRecord;
  if (
    !row ||
    row.date !== expectedDate ||
    !validDate(row.date) ||
    row.krSnapshot?.asOfDate !== row.date ||
    row.krSnapshot.date !== row.date ||
    row.etfSnapshot?.date !== row.date ||
    !Array.isArray(row.krSnapshot.entries) ||
    !Array.isArray(row.etfSnapshot.strategies) ||
    !row.counters ||
    (row.krGate !== null && row.krGate?.date !== row.date)
  )
    throw new Error("Signal cache record/date mismatch");
  if (
    "savedAt" in row.krSnapshot ||
    "storedAt" in row.krSnapshot ||
    "sourceRegisteredAt" in row.krSnapshot
  )
    throw new Error("Generation timestamps must remain separate from cached signal payload");
  if (
    row.krSnapshot.entries.some((entry) => entry.instrumentType !== "STOCK") ||
    new Set(row.krSnapshot.entries.map((entry) => entry.symbol)).size !==
      row.krSnapshot.entries.length ||
    new Set(row.etfSnapshot.strategies.map((entry) => entry.symbol)).size !==
      row.etfSnapshot.strategies.length ||
    row.etfSnapshot.strategies.some((entry) => entry.strategy.date !== row.date)
  )
    throw new Error("Duplicate, invalid or misdated cached instrument");
  if (
    row.etfSnapshot.strategies.some(({ strategy }) => strategy.version !== ETF_POLICY.version) ||
    row.krSnapshot.entries.some(
      ({ kospiEntry }) => kospiEntry && kospiEntry.version !== KOSPI_CONSISTENCY_VERSION,
    )
  )
    throw new Error("Cached signal policy version mismatch");
  for (const key of [
    "scoredEntries",
    "pendingStockEntries",
    "missingStockScores",
    "incompleteKospiGateSessions",
  ] as const)
    assertCount(row.counters[key]);
  if (row.counters.incompleteKospiGateSessions > 1) throw new Error("Invalid daily gate count");
  for (const market of markets) {
    assertCount(row.counters.validScores?.[market]);
    assertCount(row.counters.entryReady?.[market]);
  }
  assertNoFutureDates(row, row.date);
}
async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}` as SeriesHash;
}
async function checkedFile(base: string, entry: SignalCacheFile) {
  if (!entry || typeof entry.path !== "string" || !entry.path || /^\w+:\/\//.test(entry.path))
    throw new Error("Signal cache requires explicit local paths");
  assertHash(entry.sha256);
  assertCount(entry.bytes);
  const file = path.resolve(base, entry.path);
  const info = await stat(file);
  if (!info.isFile() || info.size !== entry.bytes)
    throw new Error("Signal cache file byte mismatch");
  if ((await fileHash(file)) !== entry.sha256) throw new Error("Signal cache file SHA mismatch");
  return file;
}
export async function writeAdoptedSignalCache(input: {
  out: string;
  identity: AdoptedSignalIdentity;
  evaluationDates: string[];
  records: Iterable<AdoptedSignalRecord> | AsyncIterable<AdoptedSignalRecord>;
}): Promise<AdoptedSignalCacheManifest> {
  assertOrderedSessions(input.evaluationDates);
  const dataPath = "signal-cache.jsonl.gz";
  const dataFile = path.join(input.out, dataPath);
  let count = 0;
  async function* lines() {
    for await (const row of input.records) {
      assertAdoptedSignalRecord(row, input.evaluationDates[count]!);
      count++;
      yield JSON.stringify(row) + "\n";
    }
    if (count !== input.evaluationDates.length)
      throw new Error("Incomplete signal cache record coverage");
  }
  await pipeline(
    Readable.from(lines()),
    createGzip(),
    createWriteStream(dataFile, { mode: 0o600, flags: "wx" }),
  );
  const identityHash = stableSignalHash(input.identity);
  const manifest: AdoptedSignalCacheManifest = {
    version: SIGNAL_CACHE_VERSION,
    identity: input.identity,
    identityHash,
    selectionHash: stableSignalHash({ identityHash, evaluationDates: input.evaluationDates }),
    evaluationDates: input.evaluationDates,
    records: count,
    data: { path: dataPath, bytes: (await stat(dataFile)).size, sha256: await fileHash(dataFile) },
    audit: {
      createdAt: new Date().toISOString(),
      timestampRole: "GENERATION_TIME_ONLY_NOT_MARKET_EVIDENCE",
    },
  };
  // Only complete data ever gets a manifest. Interrupted chunks cannot be mistaken for complete caches.
  await writeFile(
    path.join(input.out, "signal-cache.manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return manifest;
}
export async function openAdoptedSignalCache(input: {
  indexPath: string;
  identity: AdoptedSignalIdentity;
  actualSessions: string[];
  selectedSessions: string[];
}) {
  assertOrderedSessions(input.actualSessions);
  assertOrderedSessions(input.selectedSessions);
  if (stableSignalHash(input.actualSessions) !== input.identity.actualCalendarHash)
    throw new Error("Signal cache actual calendar identity mismatch");
  const indexBytes = await readFile(input.indexPath);
  const index = JSON.parse(indexBytes.toString("utf8")) as AdoptedSignalCacheIndex;
  if (
    index.version !== SIGNAL_CACHE_INDEX_VERSION ||
    !Array.isArray(index.chunks) ||
    !index.chunks.length
  )
    throw new Error("Invalid signal cache index");
  const identityHash = stableSignalHash(input.identity);
  const chunks: Array<{ manifest: AdoptedSignalCacheManifest; file: string }> = [];
  const manifestPaths = new Set<string>();
  for (const entry of index.chunks) {
    const manifestFile = await checkedFile(path.dirname(input.indexPath), entry);
    if (manifestPaths.has(manifestFile)) throw new Error("Duplicate signal cache manifest");
    manifestPaths.add(manifestFile);
    const bytes = await readFile(manifestFile);
    if (bytes.length !== entry.bytes || signalCacheHash(bytes) !== entry.sha256)
      throw new Error("Signal cache manifest changed after verification");
    const manifest = JSON.parse(bytes.toString("utf8")) as AdoptedSignalCacheManifest;
    if (
      manifest.version !== SIGNAL_CACHE_VERSION ||
      manifest.identityHash !== identityHash ||
      stableSignalHash(manifest.identity) !== identityHash
    )
      throw new Error("Signal cache source/code/policy/calendar identity mismatch");
    assertOrderedSessions(manifest.evaluationDates);
    if (
      manifest.records !== manifest.evaluationDates.length ||
      manifest.selectionHash !==
        stableSignalHash({ identityHash, evaluationDates: manifest.evaluationDates })
    )
      throw new Error("Signal cache selection/count mismatch");
    if (
      manifest.audit?.timestampRole !== "GENERATION_TIME_ONLY_NOT_MARKET_EVIDENCE" ||
      !Number.isFinite(Date.parse(manifest.audit.createdAt))
    )
      throw new Error("Signal cache requires separate generation audit");
    chunks.push({ manifest, file: await checkedFile(path.dirname(manifestFile), manifest.data) });
  }
  chunks.sort((a, b) =>
    a.manifest.evaluationDates[0]!.localeCompare(b.manifest.evaluationDates[0]!),
  );
  const allDates = chunks.flatMap((chunk) => chunk.manifest.evaluationDates);
  assertOrderedSessions(allDates); // Reject overlap/duplicates across every chunk, including outside selection.
  const expected = input.actualSessions.filter(
    (date) => date >= allDates[0]! && date <= allDates.at(-1)!,
  );
  if (JSON.stringify(allDates) !== JSON.stringify(expected))
    throw new Error("Signal cache has missing, off-calendar or future evaluation dates");
  const selected = new Set(input.selectedSessions);
  if (
    JSON.stringify(allDates.filter((date) => selected.has(date))) !==
    JSON.stringify(input.selectedSessions)
  )
    throw new Error("Signal cache does not completely cover requested sessions");
  async function* records(): AsyncGenerator<{ record: AdoptedSignalRecord; generatedAt: string }> {
    for (const { manifest, file } of chunks) {
      // Hash the actual compressed bytes consumed as well, closing the preflight/read race.
      const hash = createHash("sha256");
      let bytes = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      });
      const decompressed = createGunzip();
      let streamError: unknown;
      const pumping = pipeline(createReadStream(file), verify, decompressed).catch(
        (error: unknown) => {
          streamError = error;
        },
      );
      const lines = createInterface({ input: decompressed, crlfDelay: Infinity });
      let count = 0;
      try {
        for await (const line of lines) {
          if (!line) throw new Error("Empty signal cache row");
          const row: unknown = JSON.parse(line);
          assertAdoptedSignalRecord(row, manifest.evaluationDates[count]!);
          count++;
          if (selected.has(row.date)) yield { record: row, generatedAt: manifest.audit.createdAt };
        }
        await pumping;
        if (streamError) throw streamError;
        if (count !== manifest.records) throw new Error("Incomplete signal cache row coverage");
        if (
          bytes !== manifest.data.bytes ||
          `sha256:${hash.digest("hex")}` !== manifest.data.sha256
        )
          throw new Error("Signal cache data changed after verification");
      } finally {
        lines.close();
        decompressed.destroy();
        verify.destroy();
        await pumping;
      }
    }
  }
  return {
    records,
    indexHash: signalCacheHash(indexBytes),
    chunks: chunks.length,
    availableSessions: allDates.length,
    selectedSessions: input.selectedSessions.length,
    identityHash,
  };
}
