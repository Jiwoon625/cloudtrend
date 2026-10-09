import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { loadActiveSources, listActiveSources } from "../src/lib/screeningSources.server";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { parseUsProspectiveCsv } from "../src/lib/engine/usProspective";
import type { DailyPrice } from "../src/lib/engine/types";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const owner = process.env.SUPABASE_USER_ID;
if (!url || !key || !owner) throw new Error("Audit configuration is missing");
// A hard read-only HTTP boundary also covers accidentally imported storage/DB writers.
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (!["GET", "HEAD"].includes(method.toUpperCase()))
        throw new Error("Audit forbids write requests");
      return fetch(input, init);
    },
  },
});
const { sources, texts } = await loadActiveSources(client, owner);
const full = parseManualMarketData(texts, { allowIncompleteIndex: true }).dataset;
const symbols = full.instruments.map((r) => r.symbol).sort();
const priceHash = (bars: DailyPrice[] | undefined) =>
  createHash("sha256")
    .update(JSON.stringify(bars ?? []))
    .digest("hex");
const expected = new Map(
  symbols.map((symbol) => [
    symbol,
    {
      prices: priceHash(full.bars[symbol]),
      observed: priceHash(full.observedBars?.[symbol]),
    },
  ]),
);
let compared = 0;
// Each disjoint bounded selection emulates the portfolio loader's symbol filter.
for (let offset = 0; offset < 2; offset++) {
  const selected = new Set(symbols.filter((_, index) => index % 2 === offset));
  const bounded = parseManualMarketData(texts, {
    allowIncompleteIndex: true,
    symbols: selected,
  }).dataset;
  if (JSON.stringify(bounded.indexSeries) !== JSON.stringify(full.indexSeries))
    throw new Error("Full/bounded index prices differ");
  for (const symbol of selected) {
    const expectedPrices = expected.get(symbol)!;
    if (
      priceHash(bounded.bars[symbol]) !== expectedPrices.prices ||
      priceHash(bounded.observedBars?.[symbol]) !== expectedPrices.observed
    )
      throw new Error("Full/bounded selected daily prices differ");
    compared++;
  }
}
const coverage = ["STOCK", "ETF"].map((kind) => {
  const instruments = full.instruments.filter((r) => r.instrumentType === kind);
  const counts = instruments.map((r) => full.bars[r.symbol]?.length ?? 0);
  return {
    kind,
    symbols: counts.length,
    bars120: counts.filter((n) => n >= 120).length,
    bars252: counts.filter((n) => n >= 252).length,
    priceRows: counts.reduce((a, b) => a + b, 0),
  };
});
const { data: ingest, error: ingestError } = await client
  .from("us_screening_ingest")
  .select("storage_bucket,storage_path,data_hash,as_of_date")
  .eq("user_id", owner)
  .maybeSingle();
if (ingestError) throw new Error("US source metadata read failed");
let us: Record<string, unknown> = { status: "NO_INPUT" };
if (ingest) {
  const { data, error } = await client.storage
    .from(ingest.storage_bucket)
    .download(ingest.storage_path);
  if (error) throw new Error("US source read failed");
  const text = await data.text();
  if (`sha256:${createHash("sha256").update(text).digest("hex")}` !== ingest.data_hash)
    throw new Error("US source hash mismatch");
  const rows = parseUsProspectiveCsv(text).filter((r) => r.date === ingest.as_of_date);
  us = {
    date: ingest.as_of_date,
    symbols: rows.length,
    ret120Observed: rows.filter((r) => r.ret120 !== null && Number.isFinite(r.ret120)).length,
    ret252Observed: rows.filter((r) => r.ret252 !== null && Number.isFinite(r.ret252)).length,
    scope: "Saved input features; raw 253-price coverage is not inferred",
  };
}
const archive = await client
  .from("screening_run_archive")
  .select("run_id", { count: "exact", head: true })
  .eq("user_id", owner);
if (archive.error) throw new Error("Execution archive read failed");
const sourceIdentity = (items: typeof sources) =>
  JSON.stringify(items.map((s) => [s.id, s.file_hash, s.data_hash, s.activated_at]));
if (sourceIdentity(await listActiveSources(client, owner)) !== sourceIdentity(sources))
  throw new Error("Active inputs changed during the audit; retry for a consistent read");
console.log(
  JSON.stringify(
    {
      mode: "READ_ONLY",
      kr: {
        date: full.asOfDate,
        sourceFiles: sources.length,
        comparedSymbols: compared,
        selectedPricesEqual: true,
        selectedPriceDigest: createHash("sha256")
          .update(JSON.stringify([...expected]))
          .digest("hex"),
        coverage,
      },
      us,
      immutableArchiveRows: archive.count,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
