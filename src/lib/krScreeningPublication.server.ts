import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  visitDelimitedRows,
  validateSourceText,
  sourceRowKey,
  type CanonicalSourceRow,
} from "./sourceData";
import {
  classifyKrScreeningPublication,
  unresolvedKrPendingSources,
  krSourcePublication,
  validateKrPublicationManifest,
  type KrPublicationRequest,
  type KrPublicationSource,
  type KrSourcePublication,
} from "./krScreeningPublication";

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
/** A raw pending marker is a fail-closed backstop, never an authorization to publish FINAL. */
export function assertNoUndeclaredKrPending(texts: readonly string[], declaredPending: boolean) {
  for (const text of texts) {
    // JSON legacy sources cannot conceal the marker either. Any retained pending row keeps
    // the source financial-write-ineligible until an explicit exact-source replacement.
    if (/PENDING_PUBLICATION|KRX_PENDING|KRX_PUBLICATION_PENDING/i.test(text) && !declaredPending)
      throw new Error("KRX pending source requires a verified PRELIMINARY publication contract");
  }
}
export function buildKrSourcePublication(
  request: KrPublicationRequest,
  source: {
    max_date: string | null;
    file_hash: string;
    data_hash: string;
    schema_hash: string;
  },
): KrSourcePublication {
  if (!source.max_date || sha(request.manifestText) !== request.manifestSha256)
    throw new Error("KR publication manifest SHA-256 mismatch");
  validateKrPublicationManifest(request, source.max_date);
  const result: KrSourcePublication = {
    version: request.version,
    phase: request.phase,
    requestId: request.requestId,
    manifestText: request.manifestText,
    manifestSha256: request.manifestSha256,
    asOfDate: source.max_date,
    sourceFileHash: source.file_hash,
    sourceDataHash: source.data_hash,
    sourceSchemaHash: source.schema_hash,
  };
  krSourcePublication({ ...source, validation_result: { krPublication: result } });
  return result;
}
export async function verifyKrScreeningPublication(
  _client: SupabaseClient,
  _userId: string,
  sources: readonly KrPublicationSource[],
  texts: readonly string[] = [],
) {
  for (const source of sources) {
    const p = krSourcePublication(source);
    if (p && sha(p.manifestText) !== p.manifestSha256)
      throw new Error("KR publication manifest SHA-256 mismatch");
  }
  const publication = classifyKrScreeningPublication(sources);
  const rawTexts = texts.filter((_, index) => {
    const source = sources[index];
    return (
      !source ||
      krSourcePublication(source)?.phase !== "PRELIMINARY" ||
      unresolvedKrPendingSources(sources).includes(source)
    );
  });
  assertNoUndeclaredKrPending(rawTexts, publication.phase === "PRELIMINARY");
  // Source loaders already verify actual stored bytes against the registry file hash.
  // Also compare the parsed latest CSV date, so altered registry range metadata cannot pass.
  if (publication.phase === "PRELIMINARY" && texts.length) {
    let latest = "";
    for (const text of texts) {
      // Preserve bounded streaming for canonical CSV, which is the large collector path.
      // Other formats use exactly the registrar's supported grammar, not a second parser.
      let sourceLatest = "";
      let canonicalDates = !["[", "{"].includes(text.trimStart()[0] ?? "");
      let dateIndex = -1;
      if (canonicalDates)
        visitDelimitedRows(text, (row, index) => {
          if (index === 0) {
            dateIndex = row.findIndex(
              (value) =>
                value
                  .replace(/^\uFEFF/, "")
                  .trim()
                  .toLowerCase() === "date",
            );
            if (dateIndex < 0) canonicalDates = false;
          } else if (dateIndex >= 0) {
            const date = row[dateIndex] ?? "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) canonicalDates = false;
            else if (date > sourceLatest) sourceLatest = date;
          }
        });
      if (!canonicalDates) {
        const normalized = await validateSourceText(
          text,
          ["[", "{"].includes(text.trimStart()[0] ?? "") ? "source.json" : "source.csv",
        );
        if (!normalized.valid) throw new Error("KR publication raw source normalization failed");
        sourceLatest = normalized.stats.maxDate ?? "";
      }
      if (sourceLatest > latest) latest = sourceLatest;
    }
    if (latest !== publication.asOfDate)
      throw new Error("KR publication actual source latest-date mismatch");
  }
  return publication;
}

/** Only registration can derive this proof, after normalizing and verifying both byte sets. */
export function buildKrPendingSupersessions(
  previous: readonly { source: KrPublicationSource; rows: readonly CanonicalSourceRow[] }[],
  incoming: readonly CanonicalSourceRow[],
  asOfDate: string,
) {
  const incomingRows = new Map(incoming.map((row) => [sourceRowKey(row), row]));
  return previous.flatMap(({ source, rows }) => {
    const prior = krSourcePublication(source);
    if (prior?.phase !== "PRELIMINARY" || prior.asOfDate !== asOfDate || !source.id) return [];
    const covered = rows.every((row) => incomingRows.has(sourceRowKey(row)));
    const targets = rows.filter(
      (row) => row.date === asOfDate && ["STOCK", "ETF"].includes(row.type),
    );
    const repaired =
      targets.length > 0 &&
      targets.every((row) => {
        const next = incomingRows.get(sourceRowKey(row));
        return (
          next &&
          Number(next.marketCap) > 0 &&
          next["marketCapSource"] === (row.type === "ETF" ? "KRX_ETF" : "KRX_STOCK")
        );
      });
    if (!covered || !repaired) return [];
    return [
      {
        sourceId: source.id,
        fileHash: prior.sourceFileHash,
        dataHash: prior.sourceDataHash,
        schemaHash: prior.sourceSchemaHash,
        asOfDate,
      },
    ];
  });
}
