import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { validateSourceBytes } from "../src/lib/sourceData";

const projectUrl = process.env["SUPABASE_URL"];
const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
if (!projectUrl || !serviceKey) throw new Error("Missing Supabase credentials");

const client = createClient(projectUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: records, error: recordError } = await client
  .from("analysis_source_files")
  .select("*")
  .eq("source_type", "screening")
  .eq("status", "active")
  .order("activated_at", { ascending: true });
if (recordError || !records) throw recordError ?? new Error("screening source records not found");

const results = [];
for (const record of records) {
  const { data: blob, error: downloadError } = await client.storage
    .from(record.storage_bucket)
    .download(record.storage_path);
  if (downloadError || !blob) throw downloadError ?? new Error(`storage object not found: ${record.original_filename}`);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const logicalFileHash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const validation = await validateSourceBytes({
    bytes,
    filename: record.original_filename,
    contentType: record.content_type,
  });

  results.push({
    record: {
      id: record.id,
      original_filename: record.original_filename,
      file_size_bytes: record.file_size_bytes,
      file_hash: record.file_hash,
      data_hash: record.data_hash,
      schema_hash: record.schema_hash,
      row_count: record.row_count,
      symbol_count: record.symbol_count,
      min_date: record.min_date,
      max_date: record.max_date,
    },
    actual: {
      bytes: bytes.byteLength,
      logicalFileHash,
      valid: validation.valid,
      fileHash: validation.fileHash,
      dataHash: validation.dataHash,
      schemaHash: validation.schemaHash,
      rowCount: validation.stats.rowCount,
      symbolCount: validation.stats.symbolCount,
      minDate: validation.stats.minDate,
      maxDate: validation.stats.maxDate,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    matches: {
      bytes: Number(record.file_size_bytes) === bytes.byteLength,
      fileHash: record.file_hash === logicalFileHash && record.file_hash === validation.fileHash,
      dataHash: record.data_hash === validation.dataHash,
      schemaHash: record.schema_hash === validation.schemaHash,
      rowCount: Number(record.row_count) === validation.stats.rowCount,
      symbolCount: Number(record.symbol_count) === validation.stats.symbolCount,
      minDate: record.min_date === validation.stats.minDate,
      maxDate: record.max_date === validation.stats.maxDate,
    },
  });
}

process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
