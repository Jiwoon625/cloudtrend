import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkKospiPreopen, preopenTarget } from "../scripts/check-kospi-preopen";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { sha256 } from "../scripts/analysis-run-store";
const H = `sha256:${"a".repeat(64)}`;
const now = "2026-11-03T23:35:00Z";
function fixture(at = "2026-11-03T23:20:00Z") {
  const record = {
    id: "source",
    user_id: "owner",
    source_type: "screening",
    status: "active",
    storage_bucket: "cloudtrend-data",
    storage_path: "owner/source/screening/source.csv",
    activated_at: at,
    created_at: at,
    updated_at: at,
    file_hash: H,
    data_hash: H,
    schema_hash: H,
    min_date: "2026-09-01",
    max_date: "2026-11-03",
  };
  const version = `sha256:${sha256(H)}`;
  const bundle = {
    run: {
      id: "run",
      kind: "SCREENING",
      createdAt: "2026-11-03T23:25:00Z",
      codeVersion: "code",
      dataVersion: version,
    },
    data: {
      asOfDate: "2026-11-03",
      sources: [
        {
          id: record.id,
          objectPath: record.storage_path,
          savedAt: at,
          fileHash: H,
          dataHash: H,
          schemaHash: H,
        },
      ],
    },
    config: DEFAULT_SCORING_CONFIG,
  };
  const runs = [
    {
      id: "screening-run",
      created_at: bundle.run.createdAt,
      completed_at: "2026-11-03T23:26:00Z",
      data_version: version,
      result_path: "owner/results/screening/run.json",
      code_version: "code",
    },
  ];
  const records = [record];
  const from = vi.fn((table: string) => {
    const data = table === "analysis_runs" ? runs : records;
    const result = { data, count: data.length, error: null };
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ["select", "eq", "order"]) chain[method] = () => chain;
    return chain;
  });
  const download = vi.fn(async () => ({ data: new Blob([JSON.stringify(bundle)]), error: null }));
  const client = { from, storage: { from: () => ({ download }) } } as unknown as SupabaseClient;
  return { client, records, runs, bundle, download };
}
describe("read-only pre-open watchdog", () => {
  it("uses the preceding exchange session including weekends", async () => {
    expect(await preopenTarget(now)).toEqual({
      date: "2026-11-03",
      cutoff: "2026-11-04T00:00:00Z",
    });
    expect((await preopenTarget("2026-11-01T23:35:00Z"))?.date).toBe("2026-10-30");
    expect(await preopenTarget("2026-10-31T23:35:00Z")).toBeNull();
  });
  it("rejects delayed schedule execution, premature checks, and uncovered dates", async () => {
    await expect(preopenTarget("2026-11-04T00:00:00Z")).rejects.toThrow("already closed");
    await expect(preopenTarget("2026-11-03T22:59:00Z")).rejects.toThrow("not started");
    await expect(preopenTarget("2099-11-03T23:35:00Z")).rejects.toThrow("calendar");
  });
  it("verifies full manifest without claiming byte or ledger publication verification", async () => {
    const f = fixture();
    const result = await checkKospiPreopen(f.client, "owner", now);
    expect(result).toMatchObject({
      status: "PREOPEN_MANIFEST_VERIFIED",
      readOnly: true,
      date: "2026-11-03",
      sourceCount: 1,
      publicationVerified: false,
    });
    expect(f.download).toHaveBeenCalledTimes(1);
    // The mock exposes no mutation methods: any attempted write fails this test.
  });
  it("reports missing morning evidence rather than authorizing a retrospective append", async () => {
    const f = fixture();
    f.runs.length = 0;
    await expect(checkKospiPreopen(f.client, "owner", now)).rejects.toThrow(
      "No exact-date completed screening run",
    );
    expect(f.download).not.toHaveBeenCalled();
    const evening = fixture("2026-11-03T12:00:00Z");
    await expect(checkKospiPreopen(evening.client, "owner", now)).rejects.toThrow(
      "No verified pre-open morning refresh",
    );
  });
  it("fails closed on missing counts and query truncation", async () => {
    for (const count of [null, 2]) {
      const f = fixture();
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: f.records, count, error: null }).then(resolve),
      };
      for (const method of ["select", "eq", "order"]) chain[method] = () => chain;
      vi.mocked(f.client.from).mockReturnValue(chain as never);
      await expect(checkKospiPreopen(f.client, "owner", now)).rejects.toThrow(
        "registry incomplete",
      );
      expect(f.download).not.toHaveBeenCalled();
    }
  });
  it("rejects future and after-open sources, forged manifests, and cross-owner paths", async () => {
    for (const at of ["2026-11-03T23:40:00Z", "2026-11-04T01:17:31Z"]) {
      const f = fixture(at);
      await expect(checkKospiPreopen(f.client, "owner", now)).rejects.toThrow("future timestamps");
    }
    const f = fixture();
    f.bundle.data.sources[0]!.fileHash = `sha256:${"b".repeat(64)}`;
    await expect(checkKospiPreopen(f.client, "owner", now)).rejects.toThrow("hash changed");
    const sourceOwner = fixture();
    sourceOwner.records[0]!.storage_path = "other/source/screening/source.csv";
    await expect(checkKospiPreopen(sourceOwner.client, "owner", now)).rejects.toThrow(
      "Cross-owner source",
    );
    const cross = fixture();
    cross.runs[0]!.result_path = "other/results/screening/run.json";
    await expect(checkKospiPreopen(cross.client, "owner", now)).rejects.toThrow("owner-scoped");
    expect(cross.download).not.toHaveBeenCalled();
  });
});
