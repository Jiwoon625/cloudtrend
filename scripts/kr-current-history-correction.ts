/* eslint-disable @typescript-eslint/no-explicit-any */
/** Pure candidate planner. No registration, source activation, publication or ledger effects. */
import { createHash } from "node:crypto";
import {
  collectRawEvidence,
  deriveCollectorOverlay,
  overlayDataset,
  verifyCapturePlan,
  type PreflightScope,
} from "./kr-vintage-preflight-core";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import {
  CANONICAL_SOURCE_COLUMNS,
  toCanonicalCsv,
  validateSourceBytes,
  type CanonicalSourceRow,
} from "../src/lib/sourceData";
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { validDate } from "../src/lib/ledger/date";
import {
  classifyKrScreeningPublication,
  type KrPublicationSource,
  type KrScreeningPublication,
} from "../src/lib/krScreeningPublication";

export const CURRENT_HISTORY_FIELD_POLICY = "TAGGED_COLLECTOR_PROXY_V1_RETAIN_INDEPENDENT";
const CHANGED_COLUMNS = [
  "open",
  "high",
  "low",
  "close",
  "volume",
  "tradingValue",
  "foreignNetBuyValue",
  "institutionNetBuyValue",
] as const;
export interface CurrentHistorySource {
  id: string;
  canonicalCsv: string;
  dataHash: string;
  schemaHash: string;
  publicationSource: KrPublicationSource;
}
export interface CurrentHistoryCorrectionInput {
  sources: CurrentHistorySource[];
  /** Ordered array of {id,dataHash,schemaHash,canonicalByteHash,sourceMetadataHash}; supplied independently by materializer. */
  expectedOrderedSourcesHash: string;
  expectedCurrentDatasetHash: string;
  publication: KrScreeningPublication;
  expectedPublicationHash: string;
  capture: {
    manifestRaw: Uint8Array;
    normalizedRowsRaw: Uint8Array;
    rawPages: Array<{ name: string; raw: Uint8Array }>;
  };
  /** Original reviewed capture scope; expectedRun remains that historical run, not the current run. */
  scope: PreflightScope & {
    predecessorDate: string;
    currentAsOfDate: string;
    reviewedHistoricalDates: string[];
  };
  fieldPolicy: typeof CURRENT_HISTORY_FIELD_POLICY;
}
const sha = (v: string | Uint8Array) => "sha256:" + createHash("sha256").update(v).digest("hex");
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const hashOk = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
function need(v: unknown, message: string): asserts v {
  if (!v) throw new Error(`CURRENT_HISTORY_${message}`);
}
function changedPaths(a: any, b: any, root = "$", output: string[] = []) {
  if (same(a ?? null, b ?? null) && (a === undefined) === (b === undefined)) return output;
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      changedPaths(a[key], b[key], `${root}/${key}`, output);
  } else output.push(root);
  return output;
}

export async function planCurrentHistoryCorrection(input: CurrentHistoryCorrectionInput) {
  const { scope, sources } = input;
  need(
    input.fieldPolicy === CURRENT_HISTORY_FIELD_POLICY &&
      scope &&
      /^[A-Z0-9._-]{1,20}$/.test(scope.symbol),
    "POLICY_OR_SYMBOL",
  );
  need(
    [scope.predecessorDate, scope.currentAsOfDate, scope.captureThroughDate].every(validDate) &&
      scope.predecessorDate < scope.currentAsOfDate &&
      scope.predecessorDate <= scope.captureThroughDate &&
      scope.captureThroughDate < scope.currentAsOfDate,
    "DATE_BOUNDARY",
  );
  const approvedDates = scope.reviewedHistoricalDates;
  need(
    Array.isArray(approvedDates) &&
      approvedDates.length > 0 &&
      approvedDates.length <= 1000 &&
      approvedDates.every(
        (d, i) =>
          validDate(d) && d <= scope.predecessorDate && (i === 0 || d > approvedDates[i - 1]!),
      ),
    "REVIEWED_DATE_MASK",
  );
  need(
    Array.isArray(sources) &&
      sources.length > 0 &&
      sources.length <= 128 &&
      new Set(sources.map((s) => s.id)).size === sources.length,
    "SOURCE_INVENTORY",
  );
  need(
    [
      input.expectedOrderedSourcesHash,
      input.expectedCurrentDatasetHash,
      input.expectedPublicationHash,
      scope.captureManifestHash,
    ].every(hashOk),
    "EXPECTED_HASHES",
  );
  const identities = await Promise.all(
    sources.map(async (s) => ({
      id: s.id,
      dataHash: s.dataHash,
      schemaHash: s.schemaHash,
      canonicalByteHash: sha(s.canonicalCsv),
      sourceMetadataHash: await hashSeriesValue(s.publicationSource),
    })),
  );
  need(
    (await hashSeriesValue(identities)) === input.expectedOrderedSourcesHash,
    "ORDERED_SOURCE_BINDING",
  );
  need(
    input.publication.phase === "PRELIMINARY" &&
      input.publication.asOfDate === scope.currentAsOfDate &&
      (await hashSeriesValue(input.publication)) === input.expectedPublicationHash,
    "CURRENT_PHASE_BINDING",
  );
  const raw = new Map<
    string,
    { fields: Record<string, string>; sourceByField: Record<string, string> }
  >();
  for (const source of sources) {
    need(
      source.id.length > 0 && hashOk(source.dataHash) && hashOk(source.schemaHash),
      "SOURCE_IDENTITY",
    );
    need(
      source.publicationSource.id === source.id &&
        source.publicationSource.data_hash === source.dataHash &&
        source.publicationSource.schema_hash === source.schemaHash &&
        hashOk(source.publicationSource.file_hash),
      "SOURCE_METADATA_BINDING",
    );
    const checked = await validateSourceBytes({
      bytes: new TextEncoder().encode(source.canonicalCsv),
      filename: "current-source.csv",
      contentType: "text/csv",
      streamingCsv: true,
    });
    need(
      checked.valid &&
        checked.dataHash === source.dataHash &&
        checked.schemaHash === source.schemaHash &&
        checked.canonicalCsv === source.canonicalCsv &&
        checked.stats.maxDate === source.publicationSource.max_date,
      "SOURCE_CANONICAL_OR_SCHEMA_CHANGED",
    );
    const declared = (source.publicationSource.validation_result as any)?.krPublication;
    if (declared)
      need(
        sha(declared.manifestText) === declared.manifestSha256,
        "PUBLICATION_MANIFEST_BYTE_HASH",
      );
    collectRawEvidence(source.canonicalCsv, scope.symbol, source.id, raw);
  }
  const texts = sources.map((s) => s.canonicalCsv);
  const base = parseManualMarketDataWithReferences(texts).dataset;
  const beforeHash = await hashSeriesValue(base);
  need(
    beforeHash === input.expectedCurrentDatasetHash && base.asOfDate === scope.currentAsOfDate,
    "CURRENT_DATASET_BINDING",
  );
  const currentPublication = classifyKrScreeningPublication(
    sources.map((s) => s.publicationSource),
    base.asOfDate,
  );
  need(
    currentPublication.phase === "PRELIMINARY" &&
      same(currentPublication, input.publication) &&
      (await hashSeriesValue(currentPublication)) === input.expectedPublicationHash,
    "DERIVED_CURRENT_PHASE_MISMATCH",
  );
  const instrument = base.instruments.find((i) => i.symbol === scope.symbol);
  need(instrument?.instrumentType === "STOCK", "TARGET_NOT_CURRENT_STOCK");
  need(sha(input.capture.manifestRaw) === scope.captureManifestHash, "CAPTURE_MANIFEST_HASH");
  const manifest = JSON.parse(Buffer.from(input.capture.manifestRaw).toString("utf8"));
  const normalizedProof = manifest.artifacts?.[scope.normalizedArtifactName];
  need(
    normalizedProof &&
      normalizedProof.sha256 === sha(input.capture.normalizedRowsRaw).slice(7) &&
      normalizedProof.bytes === input.capture.normalizedRowsRaw.byteLength,
    "NORMALIZED_CAPTURE_BINDING",
  );
  const normalizedRows = JSON.parse(Buffer.from(input.capture.normalizedRowsRaw).toString("utf8"));
  const pages = input.capture.rawPages.map((p) => ({
    name: p.name,
    raw: Buffer.from(p.raw),
  }));
  const capture = verifyCapturePlan(
    base,
    null,
    manifest,
    normalizedRows,
    pages,
    scope.captureManifestHash,
    scope,
  );
  need(capture.size === 400, "EXPECTED_PROVIDER_OBSERVATION_COUNT");
  const mask = new Set(approvedDates);
  const selected = structuredClone(base);
  for (const field of ["bars", "observedBars"] as const) {
    need(selected[field]?.[scope.symbol], "MISSING_TARGET_OBSERVATIONS");
    selected[field]![scope.symbol] = selected[field]![scope.symbol]!.filter((b) =>
      mask.has(b.tradeDate),
    );
    need(
      same(selected[field]![scope.symbol]!.map((b) => b.tradeDate).sort(), approvedDates),
      "REVIEWED_MASK_NOT_EXACTLY_COVERED",
    );
  }
  let plan = deriveCollectorOverlay(selected, capture, raw, scope);
  verifyCapturePlan(
    selected,
    plan,
    manifest,
    normalizedRows,
    pages,
    scope.captureManifestHash,
    scope,
  );
  // Bind the same exact dated price plan to the full CURRENT universe; only its masked rows change.
  plan = { ...plan, baseDatasetHash: beforeHash };
  const expected = overlayDataset(base, plan, scope);
  const correctionRows: CanonicalSourceRow[] = [];
  const rowMask = [];
  const retainedAdditionalProxyColumns = new Set<string>();
  for (const item of plan.rows) {
    const original = raw.get(item.date)!;
    const old = base.observedBars![scope.symbol]!.find((b) => b.tradeDate === item.date)!;
    if (same(old, item.bar)) continue;
    need(mask.has(item.date) && item.date <= scope.predecessorDate, "CORRECTION_DATE_ESCAPE");
    const row = Object.fromEntries(
      CANONICAL_SOURCE_COLUMNS.map((k) => [k, original.fields[k] ?? ""]),
    ) as CanonicalSourceRow;
    need(
      row.symbol === scope.symbol && row.date === item.date && row.type === "STOCK",
      "RAW_TARGET_ROW_IDENTITY",
    );
    const beforeRow = structuredClone(row);
    for (const field of CHANGED_COLUMNS)
      row[field] = item.bar[field] === null ? "" : String(item.bar[field]);
    const changed = CANONICAL_SOURCE_COLUMNS.filter((k) => row[k] !== beforeRow[k]);
    need(
      changed.every((k) => (CHANGED_COLUMNS as readonly string[]).includes(k)),
      "COLUMN_MASK_ESCAPE",
    );
    if (original.fields["investorValueSource"] === "TOSS_NET_VOLUME_X_CLOSE_PROXY")
      for (const key of CANONICAL_SOURCE_COLUMNS)
        if (
          key.endsWith("NetBuyValue") &&
          !(CHANGED_COLUMNS as readonly string[]).includes(key) &&
          row[key] !== ""
        )
          retainedAdditionalProxyColumns.add(key);
    correctionRows.push(row);
    rowMask.push({
      date: item.date,
      symbol: scope.symbol,
      changedColumns: changed,
      changedCells: changed.map((column) => ({
        column,
        before: beforeRow[column],
        after: row[column],
        currentSource: original.sourceByField[column] ?? null,
        replacementEvidence: item.fieldEvidence[column] ?? null,
      })),
      oldAnalyticalHash: item.oldAnalyticalHash,
      oldObservedHash: item.oldObservedHash,
      newBarHash: await hashSeriesValue(item.bar),
      rawBeforeHash: await hashSeriesValue(beforeRow),
      rawAfterHash: await hashSeriesValue(row),
      currentSourceByField: original.sourceByField,
      fieldEvidence: item.fieldEvidence,
      retainedFieldVintage: item.retainedFieldVintage,
      untouchedRawQuantities: item.untouchedRawQuantities,
    });
  }
  need(correctionRows.length > 0, "NO_CORRECTION_NEEDED");
  const csv = toCanonicalCsv(correctionRows);
  const validation = await validateSourceBytes({
    bytes: new TextEncoder().encode(csv),
    filename: "reviewed-current-history-correction.csv",
    contentType: "text/csv",
    streamingCsv: true,
  });
  need(
    validation.valid &&
      validation.canonicalCsv === csv &&
      validation.stats.rowCount === correctionRows.length,
    "CORRECTION_NORMALIZATION_CHANGED_MASK",
  );
  const reparsed = parseManualMarketDataWithReferences([...texts, csv]).dataset;
  const differencePaths = changedPaths(expected, reparsed);
  if (differencePaths.length)
    return {
      version: "kr-current-history-correction-candidate-v1",
      status: "BLOCKED_REPARSE_MASK_MISMATCH",
      operationalApproval: false,
      sourceRegistration: false,
      beforeDatasetHash: beforeHash,
      expectedDatasetHash: await hashSeriesValue(expected),
      reparsedDatasetHash: await hashSeriesValue(reparsed),
      mismatchPaths: differencePaths,
      explanation:
        "Appending full canonical rows changed fields outside the approved dataset mask; no mismatch was normalized away.",
    };
  const hypotheticalHistorySource: KrPublicationSource = {
    max_date: validation.stats.maxDate,
    file_hash: sha(csv),
    data_hash: validation.dataHash,
    schema_hash: validation.schemaHash,
    // Deliberately no krPublication: a historical correction cannot declare FINAL.
    validation_result: {},
  };
  const afterPublication = classifyKrScreeningPublication(
    [...sources.map((s) => s.publicationSource), hypotheticalHistorySource],
    reparsed.asOfDate,
  );
  need(
    reparsed.asOfDate === base.asOfDate && same(currentPublication, afterPublication),
    "CURRENT_PHASE_OR_HORIZON_CHANGED",
  );
  const untouchedNewer = (dataset: typeof base) =>
    Object.fromEntries(
      Object.entries(dataset.observedBars ?? {}).map(([s, bars]) => [
        s,
        bars.filter((b) => b.tradeDate > scope.predecessorDate),
      ]),
    );
  need(same(untouchedNewer(base), untouchedNewer(reparsed)), "NEWER_OBSERVATION_CHANGED");
  return {
    version: "kr-current-history-correction-candidate-v1",
    status: "CANDIDATE_REVIEW_REQUIRED",
    operationalApproval: false,
    sourceRegistration: false,
    role: "HISTORY_ONLY",
    historicalAvailabilityClaim: false,
    collectorFinalDeclaration: false,
    economicCashEquivalenceClaim: false,
    fieldPolicy: input.fieldPolicy,
    allowedChangedColumns: [...CHANGED_COLUMNS],
    orderedSourceIdentities: identities,
    orderedSourcesHash: input.expectedOrderedSourcesHash,
    captureManifestHash: scope.captureManifestHash,
    providerObservationCount: capture.size,
    approvedDateMask: approvedDates,
    rowMask,
    retainedAdditionalProxyColumns: [...retainedAdditionalProxyColumns].sort(),
    additionalProxyColumnsRebased: false,
    currentPublicationBefore: currentPublication,
    currentPublicationAfter: afterPublication,
    beforeDatasetHash: beforeHash,
    expectedDatasetHash: await hashSeriesValue(expected),
    afterDatasetHash: await hashSeriesValue(reparsed),
    fullMaskedEquality: true,
    newerObservationsUnchanged: true,
    correction: {
      csv,
      fileHash: sha(csv),
      dataHash: validation.dataHash,
      schemaHash: validation.schemaHash,
      minDate: validation.stats.minDate,
      maxDate: validation.stats.maxDate,
      rowCount: validation.stats.rowCount,
    },
    metadataNote:
      "HISTORY_ONLY candidate; no krPublication or FINAL authority. Retained non-engine proxy columns are unchanged raw cells, not a claim that every monetary column was rebased.",
  };
}
