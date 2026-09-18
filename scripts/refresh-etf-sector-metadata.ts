import { trustedSupabaseClient, codeVersion } from "./analysis-run-store";
import { validateSourceBytes } from "../src/lib/sourceData";
import { ETF_SECTOR_BY_SYMBOL, SECTOR_NAME_BY_CODE } from "../src/lib/engine/sectors";

// Read immutable source objects; refresh only derived sector counts and an audit record.
const client = trustedSupabaseClient();
const userId = process.env["SUPABASE_USER_ID"];
if (!userId) throw new Error("SUPABASE_USER_ID is required");
const { data: files, error } = await client.from("analysis_source_files")
  .select("id,original_filename,storage_bucket,storage_path,source_type,updated_at,validation_result")
  .eq("user_id", userId).eq("status", "active").in("source_type", ["backtest", "screening"]);
if (error) throw error;
const etfs = new Map<string, { name: string; code: string }>();
for (const file of files ?? []) {
  const { data: blob, error: downloadError } = await client.storage.from(file.storage_bucket).download(file.storage_path);
  if (downloadError || !blob) throw downloadError ?? new Error("Missing source");
  const result = await validateSourceBytes({ bytes: new Uint8Array(await blob.arrayBuffer()), filename: file.original_filename });
  if (!result.valid) throw new Error(`Invalid source ${file.original_filename}: ${JSON.stringify(result.errors.slice(0, 3))}`);
  const instruments = [...new Map(result.rows.filter(r => r.type !== "INDEX").map(r => [r.symbol, r])).values()];
  const unmapped = instruments.filter(i => i.sector === "ETC" || i.sector === "기타");
  const mappedCount = instruments.length - unmapped.length;
  const targets = instruments.filter(i => i.type === "ETF" && ETF_SECTOR_BY_SYMBOL[i.symbol]);
  for (const i of instruments.filter(i => i.type === "ETF")) etfs.set(i.symbol, { name: i.name, code: i.sector });
  const validation = file.validation_result ?? {};
  const refreshed = {
    ...validation,
    stats: { ...validation.stats, sectorMappedCount: mappedCount, sectorUnmappedCount: unmapped.length },
    sectorMappingRefresh: {
      version: "etf-sector-20260918", codeVersion: codeVersion(), checkedAt: new Date().toISOString(),
      sourceObjectsUnchanged: true,
      targets: targets.map(i => ({ symbol: i.symbol, name: i.name, sectorCode: i.sector, sectorName: SECTOR_NAME_BY_CODE[i.sector] })),
      unmapped: unmapped.map(i => ({ symbol: i.symbol, name: i.name })),
    },
  };
  const { data: updated, error: updateError } = await client.from("analysis_source_files")
    .update({ sector_mapped_count: mappedCount, sector_unmapped_count: unmapped.length, validation_result: refreshed })
    .eq("id", file.id).eq("user_id", userId).eq("status", "active").eq("updated_at", file.updated_at).select("id");
  if (updateError || updated?.length !== 1) throw updateError ?? new Error(`Concurrent update: ${file.id}`);
  console.log(JSON.stringify({ file: file.original_filename, type: file.source_type, mappedCount, unmappedCount: unmapped.length, targets: targets.length }));
}
console.log(JSON.stringify({ etfCount: etfs.size, etfUnmapped: [...etfs].filter(([, i]) => i.code === "ETC"), targets: [...etfs].filter(([s]) => ETF_SECTOR_BY_SYMBOL[s]) }));
