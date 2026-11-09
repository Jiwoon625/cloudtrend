import { describe, expect, it } from "vitest";
import { liveRegistryInput, liveRegistryTimestamp } from "../scripts/live-registry-timestamp";
import type { LoadedSourceInput } from "../scripts/source-registry-store";

const record = {
  id: "3044f19e-e53a-4843-a82c-0561e352e1a5",
  user_id: "owner",
  source_type: "screening",
  original_filename: "publish_20260922_20261104_000.csv",
  storage_bucket: "cloudtrend-data",
  storage_path: "owner/source/screening/3044f19e/x.csv",
  content_type: "text/csv",
  canonical_format: "csv",
  file_hash: "sha256:69",
  data_hash: "sha256:29",
  schema_hash: "sha256:72",
  file_size_bytes: 1,
  normalized_size_bytes: 1,
  row_count: 1,
  symbol_count: 1,
  min_date: "2026-09-22",
  max_date: "2026-09-22",
  status: "active" as const,
  upload_source: "web" as const,
  overlap_result: {},
  validation_result: {},
  created_at: "2026-10-06 21:11:53.617009+00",
  activated_at: "2026-10-06 21:13:10.879416+00",
  superseded_by: null,
} as unknown as NonNullable<LoadedSourceInput["sourceRecord"]>;

describe("liveRegistryTimestamp", () => {
  it("rewrites psql text timestamps into the live registry form", () => {
    expect(liveRegistryTimestamp("2026-10-06 21:13:10.879416+00")).toBe(
      "2026-10-06T21:13:10.879416+00:00",
    );
    expect(liveRegistryTimestamp("2026-10-06 21:13:10+00")).toBe("2026-10-06T21:13:10+00:00");
    expect(liveRegistryTimestamp("2026-10-06 21:13:10.5-05:00")).toBe(
      "2026-10-06T21:13:10.5-05:00",
    );
  });

  it("leaves live-form and null timestamps untouched", () => {
    expect(liveRegistryTimestamp("2026-10-06T21:13:10.879416+00:00")).toBe(
      "2026-10-06T21:13:10.879416+00:00",
    );
    expect(liveRegistryTimestamp(null)).toBe(null);
    expect(liveRegistryTimestamp(undefined)).toBe(undefined);
  });
});

describe("liveRegistryInput", () => {
  it("keeps identity and hashes while normalizing both timestamps", () => {
    const input = { id: record.id, sourceRecord: record } as unknown as LoadedSourceInput;
    const normalized = liveRegistryInput(input);
    expect(normalized.sourceRecord).toMatchObject({
      id: record.id,
      data_hash: record.data_hash,
      schema_hash: record.schema_hash,
      created_at: "2026-10-06T21:11:53.617009+00:00",
      activated_at: "2026-10-06T21:13:10.879416+00:00",
    });
    // An already-normalized input is returned as the same object.
    expect(liveRegistryInput(normalized)).toBe(normalized);
  });
});
