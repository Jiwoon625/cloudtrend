import { trustedSupabaseClient, sha256 } from "./analysis-run-store";
import { listActiveSources, inputFingerprint } from "../src/lib/screeningSources.server";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { verifyKrScreeningPublication } from "../src/lib/krScreeningPublication.server";
import {
  publishCachedDomesticActualHistory,
  publishAllocatedPerformanceHistory,
} from "../src/lib/allocatedPerformanceHistory.server";
import { parseUsProspectiveCsv } from "../src/lib/engine/usProspective";
const userId = process.env["SUPABASE_USER_ID"];
if (!userId) throw new Error("Owner is required");
const client = trustedSupabaseClient();
let failed = false;
for (const currency of ["KRW", "USD"] as const) {
  try {
    let result;
    if (currency === "KRW") {
      const sources = await listActiveSources(client, userId);
      const publication = await verifyKrScreeningPublication(client, userId, sources);
      if (publication.phase !== "FINAL" || !publication.asOfDate)
        throw new Error("Final prices required");
      result = await publishCachedDomesticActualHistory(client, userId, {
        sources,
        throughDate: publication.asOfDate,
        sourceHash: inputFingerprint(sources, DEFAULT_SCORING_CONFIG),
      });
    } else {
      const { data: source, error } = await client
        .from("us_screening_ingest")
        .select("*")
        .eq("user_id", userId)
        .single();
      if (
        error ||
        !source ||
        source.storage_bucket !== "cloudtrend-data" ||
        !source.storage_path.startsWith(userId + "/")
      )
        throw new Error("US source identity rejected");
      const file = await client.storage.from("cloudtrend-data").download(source.storage_path);
      if (file.error) throw new Error("US source read failed");
      const csv = await file.data.text();
      if (`sha256:${sha256(Buffer.from(csv))}` !== source.data_hash)
        throw new Error("US source hash mismatch");
      const rows = parseUsProspectiveCsv(csv);
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      if (
        rows.length !== source.row_count ||
        new Set(rows.map((r) => r.symbol)).size !== source.symbol_count ||
        dates.at(-1) !== source.as_of_date
      )
        throw new Error("US source coverage mismatch");
      result = await publishAllocatedPerformanceHistory(client, userId, {
        currency,
        sourceHash: source.data_hash,
        throughDate: source.as_of_date,
        dates,
        prices: rows
          .filter((r) => r.date >= "2026-10-12")
          .map((r) => ({ symbol: r.symbol, date: r.date, close: r.close })),
      });
    }
    console.log(JSON.stringify({ currency, status: result.status, canonicalLedgerChanged: false }));
    if (result.status !== "UPDATED") failed = true;
  } catch {
    failed = true;
    console.log(JSON.stringify({ currency, status: "FAILED", canonicalLedgerChanged: false }));
  }
}
if (failed) process.exitCode = 1;
