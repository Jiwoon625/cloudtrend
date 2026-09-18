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

const fileName = "trendscore_input_20250401_20250923 (1).csv";
const { data: record, error: recordError } = await client
  .from("analysis_source_files")
  .select("*")
  .eq("source_type", "screening")
  .eq("original_filename", fileName)
  .eq("status", "active")
  .single();
if (recordError || !record) throw recordError ?? new Error("source record not found");

const { data: blob, error: downloadError } = await client.storage
  .from(record.storage_bucket)
  .download(record.storage_path);
if (downloadError || !blob) throw downloadError ?? new Error("storage object not found");

const bytes = new Uint8Array(await blob.arrayBuffer());
const logicalFileHash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
const validation = await validateSourceBytes({
  bytes,
  filename: record.original_filename,
  contentType: record.content_type,
});

process.stdout.write(JSON.stringify({
  record: {
    id: record.id,
    file_size_bytes: record.file_size_bytes,
    normalized_size_bytes: record.normalized_size_bytes,
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
}, null, 2) + "\n");
