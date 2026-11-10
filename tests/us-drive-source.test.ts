import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadUsScreeningSourceFromFiles,
  runUsScreening,
} from "../scripts/run-us-screening";
import { bytesHash } from "../scripts/us-replay-source";
import { sourceCsv } from "./us-replay-fixtures";
import type { trustedSupabaseClient } from "../scripts/analysis-run-store";

const mocks = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("../src/lib/usSignalJournal.server", () => ({
  publishUsSignalJournal: async () => ({ pending: [] }),
}));
vi.mock("../scripts/us-screening-publication", () => ({
  compactRow: (row: unknown) => row,
  publishBrowserViews: mocks.publish,
}));
vi.mock("../scripts/us-recovery-publication", () => ({
  loadPublishedUsRecoveryView: async () => null,
}));

const DATE = "2026-11-10";
const PREVIOUS = "2026-11-07";

function driveFolder() {
  const dir = mkdtempSync(join(tmpdir(), "us-drive-source-"));
  return {
    dir,
    write: (name: string, body: string | Buffer) => {
      const path = join(dir, name);
      writeFileSync(path, body);
      return path;
    },
  };
}

function sourceRecord(csv: string, overrides: Record<string, unknown> = {}) {
  return {
    user_id: "owner",
    as_of_date: DATE,
    storage_bucket: "google-drive",
    storage_path: "drive://1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
    row_count: 2,
    symbol_count: 2,
    data_hash: bytesHash(csv),
    schema_version: "us-prospective-v1",
    source_provider: "TOSS_OPEN_API",
    collected_at: `${DATE}T21:00:00+00:00`,
    metadata: {
      confirmedRegularClose: true,
      failedSymbols: 0,
      previousSessionDate: PREVIOUS,
      sourceCoverageComplete: true,
    },
    ...overrides,
  };
}

function handover(overrides: Record<string, unknown> = {}) {
  const csv = sourceCsv(DATE);
  const files = driveFolder();
  const csvPath = files.write("us_screening_input_20261110.csv", csv);
  const metadataPath = files.write(
    "us_screening_source_20261110.json",
    JSON.stringify(sourceRecord(csv, overrides)),
  );
  return { csv, csvPath, metadataPath, files };
}

describe("private Drive screening handover", () => {
  it("accepts the collector record when the CSV bytes, counts and date agree", () => {
    const h = handover();
    const { source, csv } = loadUsScreeningSourceFromFiles(h.csvPath, h.metadataPath);
    expect(csv).toBe(h.csv);
    expect(source.as_of_date).toBe(DATE);
    expect(source.data_hash).toBe(bytesHash(h.csv));
    expect(source.storage_bucket).toBe("google-drive");
    expect(source.row_count).toBe(2);
    expect(source.symbol_count).toBe(2);
    expect(source.metadata["previousSessionDate"]).toBe(PREVIOUS);
  });

  it("accepts an independent hash assertion from the workflow", () => {
    const h = handover();
    expect(() =>
      loadUsScreeningSourceFromFiles(h.csvPath, h.metadataPath, bytesHash(h.csv)),
    ).not.toThrow();
    expect(() =>
      loadUsScreeningSourceFromFiles(
        h.csvPath,
        h.metadataPath,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).toThrow(/해시 불일치/);
  });

  it.each([
    ["hash", { data_hash: `sha256:${"1".repeat(64)}` }, /해시 불일치/],
    ["date", { as_of_date: PREVIOUS }, /기준일/],
    ["rows", { row_count: 3 }, /행\/종목/],
    ["symbols", { symbol_count: 1 }, /행\/종목/],
    ["metadata", { metadata: {} }, /US source is not a confirmed session/],
  ])("refuses a handover whose %s evidence disagrees with the CSV", (_name, patch, error) => {
    const h = handover(patch);
    expect(() => loadUsScreeningSourceFromFiles(h.csvPath, h.metadataPath)).toThrow(error);
  });

  it("refuses a CSV carrying more than one session", () => {
    const csv = `${sourceCsv(PREVIOUS)}${sourceCsv(DATE).split("\n").slice(1).join("\n")}`;
    const files = driveFolder();
    const csvPath = files.write("multi.csv", csv);
    const metadataPath = files.write(
      "multi.json",
      JSON.stringify(sourceRecord(csv, { row_count: 4, symbol_count: 2 })),
    );
    expect(() => loadUsScreeningSourceFromFiles(csvPath, metadataPath)).toThrow(/단일 기준일/);
  });

  it("requires the collector record and the CSV together", () => {
    const h = handover();
    expect(() => loadUsScreeningSourceFromFiles(h.csvPath, join(h.files.dir, "missing.json"))).toThrow();
  });
});

describe("screening from a Drive handover", () => {
  function client() {
    const tables: string[] = [],
      writes: string[] = [],
      downloads: string[] = [];
    const files = new Map<string, string>();
    let history: Record<string, unknown> | null = { date: PREVIOUS };
    const q = () => {
      let before: string | undefined;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        lt: (_key: string, value: string) => {
          before = value;
          return chain;
        },
        maybeSingle: async () => ({
          data: before ? { date: PREVIOUS } : history,
          error: null,
        }),
        insert: async (value: Record<string, unknown>) => {
          writes.push("us_screening_history");
          history = value;
          return { error: null };
        },
      };
      return chain;
    };
    const fake = {
      from(table: string) {
        tables.push(table);
        if (table !== "us_screening_history") throw new Error(`Unexpected table: ${table}`);
        return q();
      },
      storage: {
        from: () => ({
          download: async (path: string) => {
            downloads.push(path);
            return files.has(path)
              ? { data: { text: async () => files.get(path)! }, error: null }
              : { data: null, error: { message: "404 Object not found" } };
          },
          upload: async (path: string, body: string | Blob) => {
            writes.push(path);
            files.set(path, typeof body === "string" ? body : "blob");
            return { error: null };
          },
        }),
      },
    };
    files.set(
      `owner/results/us-screening/${PREVIOUS}.json`,
      JSON.stringify({
        analysis: { state: { lastDate: PREVIOUS, coreRanks: { TEST: 0.7 }, betaWeakStreak: {} } },
      }),
    );
    return {
      client: fake as unknown as ReturnType<typeof trustedSupabaseClient>,
      tables,
      writes,
      downloads,
      files,
    };
  }

  it("publishes the Drive input without reading or writing the Supabase source", async () => {
    const f = client();
    const h = handover();
    const { source, csv } = loadUsScreeningSourceFromFiles(h.csvPath, h.metadataPath);
    await runUsScreening(f.client, "owner", { source, csv });
    expect(f.tables).not.toContain("us_screening_ingest");
    expect(f.downloads.some((path) => path.includes("/source/us-screening/"))).toBe(false);
    expect(f.downloads).not.toContain(source.storage_path);
    expect(f.writes).toContain("us_screening_history");
    expect(f.writes).toContain("owner/cache/us-screening/latest.json");
    expect(f.files.get(`owner/results/us-screening/${DATE}.json`)).toBeTruthy();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("still asks the registered source for an ordinary run", async () => {
    const f = client();
    await expect(runUsScreening(f.client, "owner")).rejects.toThrow(/Unexpected table/);
    expect(f.tables).toEqual(["us_screening_ingest"]);
  });
});
