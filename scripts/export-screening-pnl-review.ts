/** Read-only, bounded export for the requested historical screening P&L review. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { trustedSupabaseClient, downloadJson } from "./analysis-run-store";
import { validateSourceBytes } from "../src/lib/sourceData";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
const client = trustedSupabaseClient();
const owner = process.env["SUPABASE_USER_ID"]!;
assert.match(owner, /^[a-f0-9-]{36}$/);
const bundle = await downloadJson<{
  data: { sources: Array<{ objectPath: string; fileName: string; fileHash: string }> };
}>(client, `${owner}/results/screening/20261105004702-a65a294d.json`);
const texts: string[] = [];
for (const s of bundle.data.sources) {
  assert.ok(s.objectPath.startsWith(`${owner}/source/screening/`));
  const { data, error } = await client.storage.from("cloudtrend-data").download(s.objectPath);
  if (error || !data) throw new Error("Source unavailable");
  const bytes = new Uint8Array(await data.arrayBuffer());
  assert.equal("sha256:" + createHash("sha256").update(bytes).digest("hex"), s.fileHash);
  const v = await validateSourceBytes({ bytes, filename: s.fileName, streamingCsv: true });
  assert.ok(v.valid);
  texts.push(v.canonicalCsv);
}
const dataset = parseManualMarketDataWithReferences(texts).dataset;
const bars = Object.fromEntries(
  Object.entries(dataset.bars).map(([s, rows]) => [
    s,
    rows
      .filter((b) => b.tradeDate >= "2026-09-01" && b.tradeDate <= "2026-11-04")
      .map((b) => ({ tradeDate: b.tradeDate, open: b.open, close: b.close, volume: b.volume })),
  ]),
);
await mkdir("pnl-review-output", { recursive: true });
await writeFile(
  "pnl-review-output/kr-bars.json",
  JSON.stringify({ asOf: "2026-11-04", sources: bundle.data.sources, bars }),
);
console.log("Read-only price export complete", Object.keys(bars).length);
// Preserve the original completed run before attempting historical signal repair.
const original = await downloadJson(client, `${owner}/results/screening/20261026173147-974ea726.json`);
await writeFile("pnl-review-output/kr-original-20261026.json", JSON.stringify(original));
