import assert from "node:assert/strict";
import {
  classifyKrScreeningPublication,
  type KrPublicationSource,
} from "../src/lib/krScreeningPublication";
import { createHash } from "node:crypto";
import {
  planCurrentHistoryCorrection,
  CURRENT_HISTORY_FIELD_POLICY,
  type CurrentHistoryCorrectionInput,
} from "./kr-current-history-correction";
import { toCanonicalCsv, validateSourceText, type CanonicalSourceRow } from "../src/lib/sourceData";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import { hashSeriesValue } from "../src/lib/ledger/modelSeries";

const symbol = "111111",
  predecessor = "2026-10-23",
  asOf = "2026-10-28",
  captureThrough = "2026-10-27";
const dates: string[] = [];
const day = new Date(captureThrough + "T00:00:00Z");
while (dates.length < 400) {
  if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.unshift(day.toISOString().slice(0, 10));
  day.setUTCDate(day.getUTCDate() - 1);
}
const rawHash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const makeRow = (s: string, date: string, p: number, volume: number): CanonicalSourceRow => ({
  symbol: s,
  name: s === "KOSPI" ? "Synthetic index" : "Synthetic stock",
  market: s === "KOSPI" ? "INDEX" : "KOSDAQ",
  type: s === "KOSPI" ? "INDEX" : "STOCK",
  date,
  open: String(p),
  high: String(p * 1.1),
  low: String(p * 0.9),
  close: String(p),
  volume: String(volume),
  tradingValue: String(p * volume),
  marketCap: "1000000",
  foreignNetBuyValue: String(3 * p),
  institutionNetBuyValue: String(-2 * p),
  sector: "BIO",
  tradingValueSource: "CLOSE_X_VOLUME_PROXY",
  investorValueSource: "TOSS_NET_VOLUME_X_CLOSE_PROXY",
  investorVolumeSource: "TOSS_KRX_NXT",
  foreignNetBuyVolume: "3",
  institutionNetBuyVolume: "-2",
  listedShares: "100000",
  shortSellingVolumeRate: "0.2",
  lendingBalanceQuantity: "500",
  marketCapSource: "KRX_STOCK",
  individualNetBuyValue: String(p),
  individualNetBuyVolume: "1",
});
const oldRows = dates.flatMap((date) => [
  makeRow("KOSPI", date, 100, 1000),
  makeRow(symbol, date, date <= predecessor ? 10 : 5, date <= predecessor ? 20 : 40),
]);
const refreshed = makeRow(symbol, "2026-10-20", 10, 20);
refreshed.marketCap = "1234567";
refreshed["shortSellingVolumeRate"] = "0.99";
refreshed["lendingBalanceQuantity"] = "777";
const currentRows = [refreshed, makeRow(symbol, asOf, 6, 45), makeRow("KOSPI", asOf, 101, 1100)];
const sources: CurrentHistoryCorrectionInput["sources"] = [];
for (const [id, rows] of [
  ["synthetic-old", oldRows],
  ["synthetic-current", currentRows],
] as const) {
  const v = await validateSourceText(toCanonicalCsv(rows));
  assert.equal(v.valid, true);
  sources.push({
    id,
    canonicalCsv: v.canonicalCsv,
    dataHash: v.dataHash,
    schemaHash: v.schemaHash,
    publicationSource: {
      id,
      max_date: v.stats.maxDate,
      file_hash: "sha256:" + rawHash(v.canonicalCsv),
      data_hash: v.dataHash,
      schema_hash: v.schemaHash,
    },
  });
}
const all400 = dates.map((date) => ({
  symbol,
  date,
  open: 5,
  high: 5.5,
  low: 4.5,
  close: 5,
  volume: 40,
}));
const providerPages = [0, 1].map((i) => {
  const candles = all400.slice(i * 200, (i + 1) * 200).map((r) => ({
    symbol,
    currency: "KRW",
    timestamp: r.date + "T00:00:00Z",
    openPrice: r.open,
    highPrice: r.high,
    lowPrice: r.low,
    closePrice: r.close,
    volume: r.volume,
  }));
  return {
    name: `provider-page-${i + 1}.json`,
    raw: Buffer.from(
      JSON.stringify({
        symbol,
        currency: "KRW",
        result: { symbol, currency: "KRW", candles },
      }),
    ),
  };
});
const normalizedName = "synthetic-adjusted-360.json",
  normalized = Buffer.from(JSON.stringify(all400.slice(-360)));
const artifacts: Record<string, unknown> = {
  [normalizedName]: { sha256: rawHash(normalized), bytes: normalized.length },
};
for (const p of providerPages)
  artifacts[p.name] = {
    sha256: rawHash(p.raw),
    bytes: p.raw.length,
    responseCandles: 200,
  };
const manifest = {
  status: "CAPTURED_REVIEW_REQUIRED",
  symbol,
  adjusted: true,
  rows: 360,
  firstDate: all400.slice(-360)[0]!.date,
  lastDate: captureThrough,
  artifacts,
};
const manifestRaw = Buffer.from(JSON.stringify(manifest));
const phaseManifest = JSON.stringify({
  runId: "synthetic-pending-request",
  complete: true,
  mode: "SCREENING",
  missingSymbolCount: 0,
  missingSymbols: [],
  missingIndexSymbols: [],
  actualLatestPriceDate: asOf,
  cutoffDateInclusive: asOf,
  latestKrxPublicationPending: true,
  latestKrxPendingDate: asOf,
  krxPublicationEvidence: {
    version: "krx-publication-readiness-v1",
    phase: "PRELIMINARY",
    calendar: {
      latestSession: asOf,
      previousSession: captureThrough,
      source: "TOSS_BOTH_MARKET_INDEX_CANDLES",
      checkedAt: asOf + "T09:00:00Z",
      sessions: [captureThrough, asOf],
    },
    markets: Object.fromEntries(
      ["KOSPI", "KOSDAQ", "ETF"].map((m) => [
        m,
        {
          provider: "KRX_OPENAPI",
          targetDate: asOf,
          status: "PENDING_PUBLICATION",
          lastPublishedDate: captureThrough,
          usableRows: 0,
          responseStatus: "empty_unconfirmed",
          rawRows: 0,
          referenceOnlyPrices: false,
        },
      ]),
    ),
  },
});
function attachPublication(source: KrPublicationSource) {
  source.validation_result = {
    krPublication: {
      version: "kr-screening-publication-v1",
      phase: "PRELIMINARY",
      requestId: "synthetic-pending-request",
      manifestText: phaseManifest,
      manifestSha256: "sha256:" + rawHash(phaseManifest),
      asOfDate: asOf,
      sourceFileHash: source.file_hash,
      sourceDataHash: source.data_hash,
      sourceSchemaHash: source.schema_hash,
    },
  };
}
attachPublication(sources[1]!.publicationSource);
const publication = classifyKrScreeningPublication(
  sources.map((s) => s.publicationSource),
  asOf,
);
async function orderedHash(sources: CurrentHistoryCorrectionInput["sources"]) {
  return hashSeriesValue(
    await Promise.all(
      sources.map(async (s) => ({
        id: s.id,
        dataHash: s.dataHash,
        schemaHash: s.schemaHash,
        canonicalByteHash: "sha256:" + rawHash(s.canonicalCsv),
        sourceMetadataHash: await hashSeriesValue(s.publicationSource),
      })),
    ),
  );
}
const input: CurrentHistoryCorrectionInput = {
  sources,
  expectedOrderedSourcesHash: await orderedHash(sources),
  expectedCurrentDatasetHash: await hashSeriesValue(
    parseManualMarketDataWithReferences(sources.map((s) => s.canonicalCsv)).dataset,
  ),
  publication,
  expectedPublicationHash: await hashSeriesValue(publication),
  capture: {
    manifestRaw,
    normalizedRowsRaw: normalized,
    rawPages: providerPages,
  },
  scope: {
    symbol,
    targetDate: "2026-10-26",
    baselineAsOfDate: captureThrough,
    captureThroughDate: captureThrough,
    captureManifestHash: "sha256:" + rawHash(manifestRaw),
    normalizedArtifactName: normalizedName,
    expectedRun: {
      id: "synthetic-reviewed-run",
      codeVersion: "a".repeat(40),
      dataVersion: "sha256:" + "b".repeat(64),
      sourceCount: 1,
    },
    predecessorDate: predecessor,
    currentAsOfDate: asOf,
    reviewedHistoricalDates: dates.filter((d) => d <= predecessor),
  },
  fieldPolicy: CURRENT_HISTORY_FIELD_POLICY,
};
const before = JSON.stringify(input);
const result = await planCurrentHistoryCorrection(input);
assert.equal(result.status, "CANDIDATE_REVIEW_REQUIRED");
if (!("correction" in result)) throw new Error(JSON.stringify(result));
assert.equal(result.fullMaskedEquality, true);
assert.equal(result.newerObservationsUnchanged, true);
assert.equal(result.providerObservationCount, 400);
assert.equal(result.correction.maxDate, predecessor);
assert.equal(result.currentPublicationAfter.phase, "PRELIMINARY");
assert.equal(result.currentPublicationAfter.asOfDate, asOf);
assert.equal(result.sourceRegistration, false);
assert.equal(result.collectorFinalDeclaration, false);
assert.equal(result.correction.rowCount, 398);
assert.equal(result.retainedAdditionalProxyColumns.includes("individualNetBuyValue"), true);
assert.equal(JSON.stringify(input), before);
const merged = parseManualMarketDataWithReferences([
  ...sources.map((s) => s.canonicalCsv),
  result.correction.csv,
]).dataset;
const preserved = merged.observedBars![symbol]!.find((b) => b.tradeDate === "2026-10-20")!;
assert.equal(preserved.marketCap, 1234567);
assert.equal(preserved.shortSellingVolumeRate, 0.99);
assert.equal(preserved.lendingBalanceQuantity, 777);
assert.equal(preserved.foreignNetBuyValue, 15);
assert.equal(merged.observedBars![symbol]!.find((b) => b.tradeDate === asOf)!.close, 6);
let count = 1;
for (const edit of [
  (x: CurrentHistoryCorrectionInput) => {
    x.sources.reverse();
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.expectedCurrentDatasetHash = "sha256:" + "0".repeat(64);
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.publication.phase = "FINAL" as never;
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.scope.reviewedHistoricalDates.push("2026-10-26");
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.scope.reviewedHistoricalDates[0] = "2020-01-01";
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.capture.manifestRaw = new Uint8Array([1]);
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.capture.rawPages[0]!.raw = new Uint8Array([1]);
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.capture.normalizedRowsRaw = new Uint8Array([1]);
  },
  (x: CurrentHistoryCorrectionInput) => {
    x.scope.captureThroughDate = asOf;
  },
]) {
  const x = structuredClone(input);
  edit(x);
  await assert.rejects(() => planCurrentHistoryCorrection(x));
  count++;
}
async function replaceCurrentRows(x: CurrentHistoryCorrectionInput, rows: CanonicalSourceRow[]) {
  const checked = await validateSourceText(toCanonicalCsv(rows));
  assert.equal(checked.valid, true);
  x.sources[1] = {
    id: "synthetic-current",
    canonicalCsv: checked.canonicalCsv,
    dataHash: checked.dataHash,
    schemaHash: checked.schemaHash,
    publicationSource: {
      id: "synthetic-current",
      max_date: checked.stats.maxDate,
      file_hash: "sha256:" + rawHash(checked.canonicalCsv),
      data_hash: checked.dataHash,
      schema_hash: checked.schemaHash,
    },
  };
  attachPublication(x.sources[1]!.publicationSource);
  x.expectedOrderedSourcesHash = await orderedHash(x.sources);
  x.expectedCurrentDatasetHash = await hashSeriesValue(
    parseManualMarketDataWithReferences(x.sources.map((s) => s.canonicalCsv)).dataset,
  );
}
const staleTag = structuredClone(input);
const staleRows = structuredClone(currentRows);
staleRows[0]!["investorValueSource"] = "";
await replaceCurrentRows(staleTag, staleRows);
await assert.rejects(() => planCurrentHistoryCorrection(staleTag), /provenance mismatch/);
count++;
const official = structuredClone(input);
const officialRows = structuredClone(currentRows);
officialRows[0]!["investorValueSource"] = "KRX_STOCK";
officialRows[0]!["tradingValueSource"] = "KRX_STOCK";
officialRows[0]!.tradingValue = "987654";
officialRows[0]!.foreignNetBuyValue = "123456";
officialRows[0]!.institutionNetBuyValue = "-54321";
await replaceCurrentRows(official, officialRows);
const officialResult = await planCurrentHistoryCorrection(official);
if (!("correction" in officialResult)) throw new Error(JSON.stringify(officialResult));
const officialAfter = parseManualMarketDataWithReferences([
  ...official.sources.map((s) => s.canonicalCsv),
  officialResult.correction.csv,
]).dataset.observedBars![symbol]!.find((b) => b.tradeDate === "2026-10-20")!;
assert.equal(officialAfter.foreignNetBuyValue, 123456);
assert.equal(officialAfter.institutionNetBuyValue, -54321);
assert.equal(officialAfter.tradingValue, 987654);
count++;
const strippedPhase = structuredClone(input);
delete strippedPhase.sources[1]!.publicationSource.validation_result;
strippedPhase.expectedOrderedSourcesHash = await orderedHash(strippedPhase.sources);
await assert.rejects(
  () => planCurrentHistoryCorrection(strippedPhase),
  /DERIVED_CURRENT_PHASE_MISMATCH/,
);
count++;
const badManifestDigest = structuredClone(input);
const declaration = badManifestDigest.sources[1]!.publicationSource.validation_result as {
  krPublication: { manifestText: string };
};
declaration.krPublication.manifestText += " ";
badManifestDigest.expectedOrderedSourcesHash = await orderedHash(badManifestDigest.sources);
await assert.rejects(
  () => planCurrentHistoryCorrection(badManifestDigest),
  /PUBLICATION_MANIFEST_BYTE_HASH/,
);
count++;
// Already-authoritative FINAL is preserved, never synthesized by a historical correction.
function attachFinal(source: KrPublicationSource) {
  const date = source.max_date!;
  const m = JSON.parse(phaseManifest);
  m.runId = "synthetic-final-request";
  m.actualLatestPriceDate = date;
  m.cutoffDateInclusive = date;
  m.latestKrxPublicationPending = false;
  delete m.latestKrxPendingDate;
  m.krxPublicationEvidence.phase = "FINAL";
  m.krxPublicationEvidence.calendar.latestSession = date;
  m.krxPublicationEvidence.calendar.sessions = [date];
  for (const market of Object.values(m.krxPublicationEvidence.markets) as Record<
    string,
    unknown
  >[]) {
    market.targetDate = date;
    market.status = "PUBLISHED";
    market.lastPublishedDate = date;
    market.usableRows = 1;
    market.rawRows = 1;
    market.responseStatus = "ok";
  }
  const manifestText = JSON.stringify(m);
  source.validation_result = {
    krPublication: {
      version: "kr-screening-publication-v1",
      phase: "FINAL",
      requestId: m.runId,
      manifestText,
      manifestSha256: "sha256:" + rawHash(manifestText),
      asOfDate: date,
      sourceFileHash: source.file_hash,
      sourceDataHash: source.data_hash,
      sourceSchemaHash: source.schema_hash,
    },
  };
}
async function rebindPublication(x: CurrentHistoryCorrectionInput) {
  x.expectedOrderedSourcesHash = await orderedHash(x.sources);
  x.publication = classifyKrScreeningPublication(
    x.sources.map((s) => s.publicationSource),
    asOf,
  );
  x.expectedPublicationHash = await hashSeriesValue(x.publication);
}
const finalInput = structuredClone(official);
attachFinal(finalInput.sources[1]!.publicationSource);
await rebindPublication(finalInput);
const finalBefore = JSON.stringify(finalInput);
const finalResult = await planCurrentHistoryCorrection(finalInput);
if (!("correction" in finalResult)) throw new Error(JSON.stringify(finalResult));
assert.equal(finalResult.currentPublicationAfter.phase, "FINAL");
assert.deepEqual(finalResult.currentPublicationAfter, finalInput.publication);
assert.deepEqual(finalResult.currentPublicationBefore, finalResult.currentPublicationAfter);
assert.equal(finalResult.currentPublicationAfter.financialSideEffects, true); // Existing metadata, not an execution authorization.
assert.equal(finalResult.operationalApproval, false);
assert.equal(finalResult.collectorFinalDeclaration, false);
assert.equal(finalResult.sourceRegistration, false);
assert.equal(finalResult.newerObservationsUnchanged, true);
assert.equal(JSON.stringify(finalInput), finalBefore);
const finalAfter = parseManualMarketDataWithReferences([
  ...finalInput.sources.map((x) => x.canonicalCsv),
  finalResult.correction.csv,
]).dataset;
assert.equal(finalAfter.observedBars![symbol]!.find((b) => b.tradeDate === asOf)!.close, 6);
assert.equal(
  finalAfter.observedBars![symbol]!.find((b) => b.tradeDate === "2026-10-20")!.foreignNetBuyValue,
  123456,
);
count++;
const fallbackFinal = structuredClone(finalInput);
delete fallbackFinal.sources[1]!.publicationSource.validation_result;
await rebindPublication(fallbackFinal);
assert.equal(fallbackFinal.publication.phase, "FINAL");
await assert.rejects(
  () => planCurrentHistoryCorrection(fallbackFinal),
  /EXPLICIT_CURRENT_FINAL_REQUIRED/,
);
count++;
const oldFinalOnly = structuredClone(fallbackFinal);
attachFinal(oldFinalOnly.sources[0]!.publicationSource);
await rebindPublication(oldFinalOnly);
await assert.rejects(
  () => planCurrentHistoryCorrection(oldFinalOnly),
  /EXPLICIT_CURRENT_FINAL_REQUIRED/,
);
count++;
const forgedFinal = structuredClone(finalInput);
(
  forgedFinal.sources[1]!.publicationSource.validation_result as {
    krPublication: { sourceDataHash: string };
  }
).krPublication.sourceDataHash = "sha256:" + "0".repeat(64);
forgedFinal.expectedOrderedSourcesHash = await orderedHash(forgedFinal.sources);
await assert.rejects(
  () => planCurrentHistoryCorrection(forgedFinal),
  /source\/date\/hash binding mismatch/,
);
count++;
const unresolvedPending = structuredClone(finalInput);
const extraPending = structuredClone(input.sources[1]!);
extraPending.id = "synthetic-unresolved-pending";
extraPending.publicationSource.id = extraPending.id;
unresolvedPending.sources.unshift(extraPending);
unresolvedPending.expectedOrderedSourcesHash = await orderedHash(unresolvedPending.sources);
await assert.rejects(
  () => planCurrentHistoryCorrection(unresolvedPending),
  /DERIVED_CURRENT_PHASE_MISMATCH/,
);
count++;
console.log(
  JSON.stringify({
    syntheticTests: count,
    status: "PASS",
    sourceCountNotHardcoded: input.sources.length,
    correctionRows: result.correction.rowCount,
    currentPhasePreserved: result.currentPublicationAfter.phase,
    noRegistrationOrNetwork: true,
  }),
);
