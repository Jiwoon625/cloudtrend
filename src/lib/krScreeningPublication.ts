import type { AnalysisResult } from "./engine/pipeline";

export const KR_PUBLICATION_VERSION = "kr-screening-publication-v1" as const;
export interface KrPublicationRequest {
  version: typeof KR_PUBLICATION_VERSION;
  phase: "PRELIMINARY" | "FINAL";
  requestId: string;
  manifestText: string;
  manifestSha256: string;
}
export interface KrPendingSupersession {
  sourceId: string;
  fileHash: string;
  dataHash: string;
  schemaHash: string;
  asOfDate: string;
}
export interface KrSourcePublication extends KrPublicationRequest {
  /** Server-derived proof: complete incoming canonical keys and exact same-date repair. */
  supersedesPending?: KrPendingSupersession[];
  asOfDate: string;
  sourceFileHash: string;
  sourceDataHash: string;
  sourceSchemaHash: string;
}
export interface KrPublicationSource {
  id?: string;
  max_date?: string | null;
  file_hash?: string;
  data_hash?: string;
  schema_hash?: string;
  validation_result?: unknown;
}
export interface KrScreeningPublication {
  version: typeof KR_PUBLICATION_VERSION;
  phase: "PRELIMINARY" | "FINAL";
  asOfDate: string;
  heldFields: string[];
  financialSideEffects: boolean;
  requestIds: string[];
}
const hash = /^sha256:[a-f0-9]{64}$/;
const date = /^\d{4}-\d{2}-\d{2}$/;
export function publicationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid KR publication evidence");
  return value as Record<string, unknown>;
}
export function krSourcePublication(source: KrPublicationSource): KrSourcePublication | undefined {
  const validation = source.validation_result;
  if (validation === undefined || validation === null) return undefined;
  const raw = publicationObject(validation)["krPublication"];
  if (raw === undefined) return undefined;
  const p = publicationObject(raw) as unknown as KrSourcePublication;
  if (
    p.version !== KR_PUBLICATION_VERSION ||
    !["PRELIMINARY", "FINAL"].includes(p.phase) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(p.requestId) ||
    typeof p.manifestText !== "string" ||
    p.manifestText.length > 1024 * 1024 ||
    !hash.test(p.manifestSha256) ||
    !date.test(p.asOfDate) ||
    p.asOfDate !== source.max_date ||
    !hash.test(p.sourceFileHash) ||
    p.sourceFileHash !== source.file_hash ||
    !hash.test(p.sourceDataHash) ||
    p.sourceDataHash !== source.data_hash ||
    !hash.test(p.sourceSchemaHash) ||
    p.sourceSchemaHash !== source.schema_hash
  )
    throw new Error("KR publication source/date/hash binding mismatch");
  if (
    p.supersedesPending !== undefined &&
    (p.phase !== "FINAL" ||
      !Array.isArray(p.supersedesPending) ||
      p.supersedesPending.some(
        (v) =>
          !v ||
          typeof v.sourceId !== "string" ||
          !hash.test(v.fileHash) ||
          !hash.test(v.dataHash) ||
          !hash.test(v.schemaHash) ||
          v.asOfDate !== p.asOfDate,
      ))
  )
    throw new Error("Invalid KR pending supersession proof");
  validateKrPublicationManifest(p, p.asOfDate);
  return p;
}

/** Only supported official-provider/calendar evidence can authorize a pending preview. */
export function validateKrPublicationManifest(request: KrPublicationRequest, asOfDate: string) {
  const m = publicationObject(JSON.parse(request.manifestText));
  if (
    m["runId"] !== request.requestId ||
    m["complete"] !== true ||
    m["mode"] !== "SCREENING" ||
    m["missingSymbolCount"] !== 0 ||
    !Array.isArray(m["missingSymbols"]) ||
    m["missingSymbols"].length ||
    !Array.isArray(m["missingIndexSymbols"]) ||
    m["missingIndexSymbols"].length
  )
    throw new Error(
      "KR publication requires the same completed collector run and complete symbol coverage",
    );
  const e = publicationObject(m["krxPublicationEvidence"]);
  const calendar = publicationObject(e["calendar"]);
  if (
    e["version"] !== "krx-publication-readiness-v1" ||
    e["phase"] !== request.phase ||
    calendar["latestSession"] !== asOfDate ||
    calendar["source"] !== "TOSS_BOTH_MARKET_INDEX_CANDLES" ||
    typeof calendar["checkedAt"] !== "string" ||
    !Number.isFinite(Date.parse(calendar["checkedAt"])) ||
    !Array.isArray(calendar["sessions"]) ||
    !calendar["sessions"].includes(asOfDate) ||
    m["actualLatestPriceDate"] !== asOfDate ||
    m["cutoffDateInclusive"] !== asOfDate
  )
    throw new Error("KR publication manifest latest-session evidence mismatch");
  const markets = publicationObject(e["markets"]);
  let pending = 0;
  for (const name of ["KOSPI", "KOSDAQ", "ETF"]) {
    const market = publicationObject(markets[name]);
    if (market["provider"] !== "KRX_OPENAPI" || market["targetDate"] !== asOfDate)
      throw new Error("KR publication provider/date evidence mismatch");
    if (market["status"] === "PENDING_PUBLICATION") {
      pending++;
      if (
        market["lastPublishedDate"] !== calendar["previousSession"] ||
        typeof market["lastPublishedDate"] !== "string" ||
        market["lastPublishedDate"] >= asOfDate ||
        market["usableRows"] !== 0 ||
        !(
          (market["responseStatus"] === "empty_unconfirmed" &&
            market["rawRows"] === 0 &&
            market["referenceOnlyPrices"] === false) ||
          (name === "ETF" &&
            market["responseStatus"] === "reference_only_no_prices" &&
            typeof market["rawRows"] === "number" &&
            market["rawRows"] > 0 &&
            market["referenceOnlyPrices"] === true)
        )
      )
        throw new Error("Invalid KRX pending-publication evidence");
    } else if (
      !["PUBLISHED", "EXACT_READY"].includes(String(market["status"])) ||
      market["lastPublishedDate"] !== asOfDate ||
      market["referenceOnlyPrices"] !== false ||
      typeof market["usableRows"] !== "number" ||
      market["usableRows"] <= 0
    ) {
      throw new Error("KRX publication is neither verified published nor expected pending");
    }
  }
  if (
    request.phase === "PRELIMINARY"
      ? pending === 0 ||
        m["latestKrxPublicationPending"] !== true ||
        m["latestKrxPendingDate"] !== asOfDate
      : pending > 0 || m["latestKrxPublicationPending"] === true
  )
    throw new Error("KR publication phase contradicts pending evidence");
}

/** A later FINAL may repair only exact earlier source generations on the SAME date. */
export function unresolvedKrPendingSources(sources: readonly KrPublicationSource[]) {
  return sources.filter((source, index) => {
    const pending = krSourcePublication(source);
    if (pending?.phase !== "PRELIMINARY") return false;
    return !sources.slice(index + 1).some((later) => {
      const final = krSourcePublication(later);
      return (
        final?.phase === "FINAL" &&
        final.asOfDate === pending.asOfDate &&
        final.supersedesPending?.some(
          (proof) =>
            proof.sourceId === source.id &&
            proof.fileHash === source.file_hash &&
            proof.dataHash === source.data_hash &&
            proof.schemaHash === source.schema_hash &&
            proof.asOfDate === pending.asOfDate,
        )
      );
    });
  });
}

export function classifyKrScreeningPublication(
  sources: readonly KrPublicationSource[],
  asOfDate?: string,
): KrScreeningPublication {
  const declarations = sources
    .map(krSourcePublication)
    .filter((p): p is KrSourcePublication => !!p);
  const latest =
    asOfDate ??
    sources
      .map((s) => s.max_date ?? "")
      .sort()
      .at(-1) ??
    "";
  // Historical pending sources cannot authorize financial effects through an append/compaction.
  // A final replacement must retire them, rather than silently relabel their incomplete rows.
  const pending = unresolvedKrPendingSources(sources).length > 0;
  return {
    version: KR_PUBLICATION_VERSION,
    phase: pending ? "PRELIMINARY" : "FINAL",
    asOfDate: latest,
    heldFields: pending
      ? [
          "KRX market capitalization",
          "KRX investor flows",
          "KRX ETF official facts",
          "financial journals and valuations",
        ]
      : [],
    financialSideEffects: !pending,
    requestIds: [...new Set(declarations.map((p) => p.requestId))].sort(),
  };
}

export function applyKrScreeningPublication<T extends AnalysisResult>(
  analysis: T,
  publication: KrScreeningPublication,
): T {
  if (publication.phase === "FINAL") return analysis;
  if (analysis.asOfDate !== publication.asOfDate)
    throw new Error("KR screening publication date mismatch");
  return {
    ...analysis,
    krPublication: publication,
    notes: [
      ...analysis.notes,
      "PRELIMINARY · KRX 공표 대기: 가격 기반 예비 스크리닝입니다. 미공표 항목은 판단 보류하며 Shadow·배분·평가원장을 갱신하지 않습니다.",
    ],
  };
}
