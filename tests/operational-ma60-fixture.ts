import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import type { UnderlyingIndexArtifact } from "../src/lib/underlyingIndexSupplement";
export function operationalFixture(symbol = "360750") {
  const calendar = Array.from({ length: 66 }, (_, i) =>
    new Date(Date.UTC(2026, 7, 12 + i)).toISOString().slice(0, 10),
  );
  const artifact: UnderlyingIndexArtifact = {
    version: "underlying-index-diagnostic-v1",
    usage: "diagnostic-only",
    availableFrom: "2026-10-17T07:21:29Z",
    cutoffDate: "2026-10-16",
    calendar,
    calendarKind: "observed-not-exchange-certified",
    independentIndexIdVerified: false,
    currencyAndMethodologyVerified: false,
    sources: [
      {
        id: "archive",
        sha256: "a".repeat(64),
        uri: "https://example.com/data",
        capturedAt: null,
        provider: "KRX",
        field: "OBJ_STKPRC_IDX",
        minDate: calendar[0]!,
        maxDate: "2026-10-16",
      },
    ],
    symbols: [
      {
        symbol,
        name: "ETF",
        historicalIndexNames: ["INDEX"],
        observations: calendar.map((d) => [d, 100, "INDEX", "archive"]),
      },
    ],
  };
  const dates = [...calendar, "2026-10-19"];
  const csv =
    "symbol,name,type,market,date,open,high,low,close,volume,etfUnderlyingIndexClose,etfUnderlyingIndexName,priceSource,marketCapSource\n" +
    dates
      .map(
        (d, i) =>
          `${symbol},ETF,ETF,ETF,${d},101,102,100,101,1000,${i > 45 ? 100 : ""},INDEX,TOSS_ADJUSTED_CANDLE,KRX_ETF`,
      )
      .join("\n") +
    "\n" +
    dates.map((d) => `KOSPI,KOSPI,INDEX,INDEX,${d},2500,2500,2500,2500,0,,,KRX`).join("\n");
  return { artifact, csv, ds: parseManualMarketDataWithReferences([csv]).dataset };
}
