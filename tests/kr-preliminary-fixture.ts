import { createHash } from "node:crypto";
import { buildKrSourcePublication } from "../src/lib/krScreeningPublication.server";

/** Synthetic public fixture only; contains no account, source or collected-run identifiers. */
export function preliminarySource(asOfDate = "2026-10-06") {
  const previous = new Date(Date.parse(`${asOfDate}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const text = `symbol,date,marketCapSource\nTEST,${asOfDate},KRX_PENDING_PUBLICATION\n`;
  const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const manifestText = JSON.stringify({
    runId: "synthetic-request",
    complete: true,
    mode: "SCREENING",
    missingSymbolCount: 0,
    missingSymbols: [],
    missingIndexSymbols: [],
    actualLatestPriceDate: asOfDate,
    cutoffDateInclusive: asOfDate,
    latestKrxPublicationPending: true,
    latestKrxPendingDate: asOfDate,
    krxPublicationEvidence: {
      version: "krx-publication-readiness-v1",
      phase: "PRELIMINARY",
      calendar: {
        checkedAt: `${asOfDate}T15:30:00Z`,
        latestSession: asOfDate,
        previousSession: previous,
        sessions: [previous, asOfDate],
        source: "TOSS_BOTH_MARKET_INDEX_CANDLES",
      },
      markets: Object.fromEntries(
        ["KOSPI", "KOSDAQ", "ETF"].map((market) => [
          market,
          {
            status: "PENDING_PUBLICATION",
            targetDate: asOfDate,
            lastPublishedDate: previous,
            provider: "KRX_OPENAPI",
            responseStatus: "empty_unconfirmed",
            rawRows: 0,
            usableRows: 0,
            referenceOnlyPrices: false,
          },
        ]),
      ),
    },
  });
  const source = {
    id: "synthetic-pending-source",
    max_date: asOfDate,
    min_date: asOfDate,
    file_hash: hash(text),
    data_hash: hash("synthetic-data"),
    schema_hash: hash("synthetic-schema"),
    storage_bucket: "cloudtrend-data",
    storage_path: "synthetic/source.csv",
    original_filename: "synthetic.csv",
    created_at: `${asOfDate}T15:30:00Z`,
    activated_at: `${asOfDate}T15:30:00Z`,
  };
  return {
    text,
    source: {
      ...source,
      validation_result: {
        krPublication: buildKrSourcePublication(
          {
            version: "kr-screening-publication-v1",
            phase: "PRELIMINARY",
            requestId: "synthetic-request",
            manifestText,
            manifestSha256: hash(manifestText),
          },
          source,
        ),
      },
    },
  };
}
