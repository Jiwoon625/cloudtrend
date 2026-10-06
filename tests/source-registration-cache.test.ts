import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { validateSourceBytes, sourceRowKey, toCanonicalCsv } from "../src/lib/sourceData";
import { registerSourceBytes, type SourceRecord } from "../scripts/source-registry-store";
import { SourceValidationCache } from "../scripts/source-validation-cache";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { deterministicAnalysis } from "../src/lib/screeningCacheContract";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header =
  "symbol,name,market,type,date,close,volume,marketCap,foreignNetBuyValue,institutionNetBuyValue,sector";
function history(start: number, count: number) {
  const lines = [header];
  for (let i = start; i < start + count; i++) {
    const date = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
    lines.push(`KOSPI,코스피,INDEX,INDEX,${date},${2000 + i},0,,,,MARKET_IDX`);
    lines.push(
      `005930,삼성전자,KOSPI,STOCK,${date},${10000 + i * 20},1000000,10000000000000,100000,100000,SEMI`,
    );
  }
  return lines.join("\n") + "\n";
}
const validate = (csv: string, filename: string) =>
  validateSourceBytes({ bytes: new TextEncoder().encode(csv), filename });

test("registration and legacy sync reuse unchanged generations; warm next upload validates only the new source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "registration-cache-"));
  try {
    const texts = [history(0, 65), history(60, 40).replace(",11200,", ",21200,")];
    const initial = await Promise.all(texts.map((text, i) => validate(text, `history-${i}.csv`)));
    expect(initial.every((v) => v.valid)).toBe(true);
    const records: SourceRecord[] = initial.map(
      (v, i) =>
        ({
          id: uuid(i + 1),
          user_id: "user",
          source_type: "screening",
          status: "active",
          original_filename: v.originalFilename,
          storage_bucket: "cloudtrend-data",
          storage_path: `user/source/${i}.csv`,
          canonical_format: "csv",
          content_type: "text/csv",
          file_hash: v.fileHash,
          data_hash: v.dataHash,
          schema_hash: v.schemaHash,
          validation_result: { stats: v.stats },
          file_size_bytes: v.originalSizeBytes,
          normalized_size_bytes: v.normalizedSizeBytes,
          row_count: v.stats.rowCount,
          symbol_count: v.stats.symbolCount,
          market_count: v.stats.marketCount,
          kospi_count: v.stats.kospiCount,
          kosdaq_count: v.stats.kosdaqCount,
          stock_count: v.stats.stockCount,
          etf_count: v.stats.etfCount,
          sector_mapped_count: v.stats.sectorMappedCount,
          sector_unmapped_count: v.stats.sectorUnmappedCount,
          upload_source: "gpt",
          updated_at: "2026-01-01T00:00:00Z",
          overlap_result: null,
          superseded_by: null,
          activated_at: `2026-01-0${i + 1}T00:00:00Z`,
          created_at: `2026-01-0${i + 1}T00:00:00Z`,
          min_date: v.stats.minDate,
          max_date: v.stats.maxDate,
        }) as SourceRecord,
    );
    const objects = new Map<string, { bytes: Uint8Array; id: string; version: string }>();
    let serial = 20;
    const put = (key: string, body: string | Uint8Array) => {
      objects.set(key, {
        bytes: typeof body === "string" ? new TextEncoder().encode(body) : body,
        id: uuid(serial++),
        version: uuid(serial++),
      });
    };
    records.forEach((record, i) => put(record.storage_path, texts[i]!));
    const download = vi.fn(async (key: string) => ({
      data: new Blob([new Uint8Array(objects.get(key)!.bytes)]),
      error: null,
    }));
    const upload = vi.fn(async (key: string, body: string | Uint8Array) => {
      put(key, body);
      return { error: null };
    });
    const info = vi.fn(async (key: string) => {
      const o = objects.get(key)!;
      return {
        data: { id: o.id, version: o.version, name: key, bucketId: "cloudtrend-data" },
        error: null,
      };
    });
    records.reverse(); // Query ordering, not array order, must control precedence.
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order"]) chain[method] = () => chain;
    chain["then"] = (resolve: (value: { data: SourceRecord[]; error: null }) => unknown) =>
      Promise.resolve({
        data: records
          .filter((r) => r.status === "active")
          .sort(
            (a, b) =>
              (a.activated_at ?? "").localeCompare(b.activated_at ?? "") ||
              a.created_at.localeCompare(b.created_at),
          )
          .map((r) => ({ ...r })),
        error: null,
      }).then(resolve);
    chain["insert"] = async (value: SourceRecord) => {
      records.push({ ...value, created_at: `2026-10-06T00:00:${records.length}Z` });
      return { error: null };
    };
    const client = {
      from: () => chain,
      storage: { from: () => ({ download, upload, info }) },
      rpc: async (_name: string, args: { p_source_id: string }) => {
        const record = records.find((r) => r.id === args.p_source_id)!;
        record.status = "active";
        record.activated_at = record.created_at;
        return { data: { ...record }, error: null };
      },
    } as unknown as SupabaseClient;
    const incoming = history(98, 4).replace(",11960,", ",21960,"),
      v = await validate(incoming, "new.csv");
    const before = initial.flatMap((value) => value.rows),
      expectedRows = new Map();
    for (const row of [...before, ...v.rows]) expectedRows.set(sourceRowKey(row), row);
    const expectedCsv = toCanonicalCsv([...expectedRows.values()]);
    const cache = new SourceValidationCache({ directory });
    const result = await registerSourceBytes({
      client,
      userId: "user",
      sourceType: "screening",
      mode: "merge",
      origin: "gpt",
      bytes: new TextEncoder().encode(incoming),
      filename: "new.csv",
      validationCache: cache,
    });
    expect(result.source.status).toBe("active");
    expect(result.overlap.conflictingRows).toBeGreaterThan(0);
    // Two old downloads + one verified new upload, rather than 2+3 complete passes.
    expect(download).toHaveBeenCalledTimes(3);
    expect(cache.metrics.hits).toBe(3);
    const legacy = JSON.parse(new TextDecoder().decode(objects.get("user/kr.json")!.bytes));
    expect(legacy.text).toBe(expectedCsv);
    const expectedAnalysis = runFullMarketAnalysis(
      parseManualMarketData(expectedCsv).dataset,
    ).analysis;
    const actualAnalysis = runFullMarketAnalysis(
      parseManualMarketData(legacy.text).dataset,
    ).analysis;
    expect(deterministicAnalysis(actualAnalysis)).toEqual(deterministicAnalysis(expectedAnalysis));

    // A separate process uses persisted proofs, but still checks current generations.
    download.mockClear();
    const next = history(102, 1),
      warm = new SourceValidationCache({ directory });
    const second = await registerSourceBytes({
      client,
      userId: "user",
      sourceType: "screening",
      mode: "merge",
      origin: "gpt",
      bytes: new TextEncoder().encode(next),
      filename: "next.csv",
      validationCache: warm,
    });
    expect(second.source.status).toBe("active");
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toBe(second.source.storage_path);
    expect(warm.metrics.hits).toBe(7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
