import { collectUnderlyingIndexEvidence } from "../src/lib/underlyingIndexEvidence";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { parseManualMarketDataWithReferences as parseManualMarketData } from "../src/lib/krxReviewReferenceParser";
import {
  calculateIndexDiagnostics,
  parseUnderlyingIndexArtifact,
  type UnderlyingIndexArtifact,
} from "../src/lib/underlyingIndexSupplement";
import {
  datasetDigest,
  indexSha256,
  underlyingIndexPath,
  readUnderlyingIndexDiagnostics,
  installUnderlyingIndexArtifact,
} from "../src/lib/underlyingIndexDiagnostics.server";
import { UNDERLYING_INDEX_RELEASE } from "../src/lib/underlyingIndexSupplementRelease";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateSourceText } from "../src/lib/sourceData";
vi.mock("../src/lib/underlyingIndexSupplementRelease", () => ({
  UNDERLYING_INDEX_RELEASE: { enabled: true, sha256: "", cutoffDate: "2026-10-16" },
}));
const release = UNDERLYING_INDEX_RELEASE as {
  enabled: boolean;
  sha256: string;
  cutoffDate: string;
};
const owner = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
const now = "2026-10-17T04:00:00.000Z";
function fixture() {
  const calendar = Array.from({ length: 66 }, (_, i) =>
    new Date(Date.UTC(2026, 7, 12 + i)).toISOString().slice(0, 10),
  );
  const end = calendar.at(-1)!;
  const artifact: UnderlyingIndexArtifact = {
    version: "underlying-index-diagnostic-v1",
    usage: "diagnostic-only",
    availableFrom: "2026-10-17T03:28:00.000Z",
    cutoffDate: end,
    calendarKind: "observed-not-exchange-certified",
    calendar,
    independentIndexIdVerified: false,
    currencyAndMethodologyVerified: false,
    sources: [
      {
        id: "archive",
        sha256: "a".repeat(64),
        uri: "https://drive.google.com/file/d/verified/view",
        capturedAt: null,
        provider: "KRX",
        field: "OBJ_STKPRC_IDX",
        minDate: calendar[0]!,
        maxDate: end,
      },
    ],
    symbols: [
      {
        symbol: "0046A0",
        name: "ETF",
        historicalIndexNames: ["INDEX"],
        observations: calendar.map((d, i) => [d, 100 + i, "INDEX", "archive"]),
      },
    ],
  };
  const csv =
    "symbol,name,type,market,date,open,high,low,close,volume,etfUnderlyingIndexClose,etfUnderlyingIndexName,priceSource,marketCapSource\n" +
    calendar
      .map(
        (d, i) =>
          `0046A0,ETF,ETF,ETF,${d},101,102,100,101,1000,${i > 45 ? 100 + i : ""},INDEX,TOSS_ADJUSTED_CANDLE,KRX_ETF`,
      )
      .join("\n") +
    "\n" +
    calendar.map((d) => `KOSPI,KOSPI,INDEX,INDEX,${d},2500,2500,2500,2500,0,,,KRX`).join("\n");
  const ds = parseManualMarketData([csv]).dataset;
  return { artifact, csv, ds };
}
function fakeClient(csv: string, artifact?: UnderlyingIndexArtifact) {
  const bytes = new Map<string, string>();
  const sourcePath = `${owner}/source/screening/frozen/source.csv`;
  bytes.set(sourcePath, csv);
  const sources = [
    {
      id: "source",
      original_filename: "source.csv",
      storage_bucket: "cloudtrend-data",
      storage_path: sourcePath,
      file_hash: `sha256:${indexSha256(csv)}`,
      data_hash: "data",
      schema_hash: "schema",
      min_date: null,
      max_date: "2026-10-16",
      activated_at: null,
      created_at: now,
    },
  ];
  if (artifact) bytes.set(underlyingIndexPath(owner), JSON.stringify(artifact));
  const upload = vi.fn(async (path: string, body: Blob, options: { upsert: boolean }) => {
    expect(options.upsert).toBe(false);
    if (bytes.has(path)) return { error: { message: "Already exists" } };
    bytes.set(path, await body.text());
    return { error: null };
  });
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"]) query[method] = vi.fn(() => query);
  query["then"] = (resolve: (v: unknown) => unknown) => resolve({ data: sources, error: null });
  const from = vi.fn((table: string) => {
    expect(table).toBe("analysis_source_files");
    return query;
  });
  const download = vi.fn(async (path: string) =>
    bytes.has(path)
      ? { data: new Blob([bytes.get(path)!]), error: null }
      : { data: null, error: { statusCode: "404", message: "Object not found" } },
  );
  const client = {
    from,
    storage: {
      from: vi.fn((bucket: string) => {
        expect(bucket).toBe("cloudtrend-data");
        return { download, upload };
      }),
    },
  } as unknown as SupabaseClient;
  return { client, bytes, sources, upload, download, query };
}
beforeEach(() => {
  release.enabled = true;
  release.sha256 = "a".repeat(64);
  release.cutoffDate = "2026-10-16";
});
describe("underlying-only pure diagnostic", () => {
  it("adds independent index observations without any OHLCV/NAV/provenance/row/universe change", () => {
    const { ds, artifact } = fixture();
    const before = datasetDigest(ds),
      copy = structuredClone(ds);
    const report = calculateIndexDiagnostics(ds, parseUnderlyingIndexArtifact(artifact, now));
    expect(report.rows[0]?.diagnosticMa60).toBe(135.5);
    expect(report.rows[0]?.activeMa60).toBeNull();
    expect(report.rows[0]?.supplementedObservations).toBe(40);
    expect(report.rows[0]?.strategyApplied).toBe(false);
    expect(ds).toEqual(copy);
    expect(datasetDigest(ds)).toBe(before);
    expect(calculateIndexDiagnostics(ds, artifact)).toEqual(report);
  });
  it("does not synthesize absent price rows", () => {
    const { ds, artifact } = fixture();
    ds.bars["0046A0"] = ds.bars["0046A0"]!.slice(-20);
    ds.observedBars = { "0046A0": ds.bars["0046A0"]! };
    const before = datasetDigest(ds);
    const row = calculateIndexDiagnostics(ds, artifact).rows[0]!;
    expect(row.priceRowsAbsent).toBe(40);
    expect(row.diagnosticMa60).toBe(135.5);
    expect(ds.bars["0046A0"]).toHaveLength(20);
    expect(datasetDigest(ds)).toBe(before);
  });
  it("missing last-60 values stay missing; never chooses latest 60 valid samples", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.observations[10]![1] = null;
    const row = calculateIndexDiagnostics(ds, artifact).rows[0]!;
    expect(row.diagnosticMa60).toBeNull();
    expect(row.combinedValidCount).toBe(59);
    expect(row.missingDates).toEqual([artifact.calendar[10]]);
  });
  it("null candidate cannot clear an existing positive index", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.observations[65]![1] = null;
    expect(calculateIndexDiagnostics(ds, artifact).rows[0]?.currentIndex).toBe(165);
  });
  it.each(["name", "index", "historical", "value"])(
    "quarantines %s identity/value conflicts instead of replacing",
    (kind) => {
      const { ds, artifact } = fixture();
      if (kind === "name") artifact.symbols[0]!.name = "OTHER";
      if (kind === "index") artifact.symbols[0]!.observations[5]![2] = "OTHER";
      if (kind === "historical") artifact.symbols[0]!.historicalIndexNames.push("OLD TR");
      if (kind === "value") artifact.symbols[0]!.observations[65]![1] = 1;
      const row = calculateIndexDiagnostics(ds, artifact).rows[0]!;
      expect(row.status).toBe("quarantined");
      expect(row.diagnosticMa60).toBeNull();
      expect(row.supplementedObservations).toBe(0);
      expect(row.currentIndex).toBe(165);
    },
  );
  it("quarantines a later active benchmark transition outside the archived date range", () => {
    const { ds, artifact } = fixture();
    ds.asOfDate = "2026-10-17";
    ds.tradeDates.push(ds.asOfDate);
    const extra = {
      ...ds.bars["0046A0"]!.at(-1)!,
      tradeDate: ds.asOfDate,
      etfUnderlyingIndexName: "OTHER PR",
    };
    ds.bars["0046A0"]!.push(extra);
    if (ds.observedBars?.["0046A0"] !== ds.bars["0046A0"]) ds.observedBars?.["0046A0"]?.push(extra);
    expect(calculateIndexDiagnostics(ds, artifact).rows[0]?.status).toBe("quarantined");
  });
  it("never adds absent universe members or changes membership", () => {
    const { ds, artifact } = fixture();
    ds.instruments = [];
    expect(calculateIndexDiagnostics(ds, artifact).rows[0]?.status).toBe("not-in-live-universe");
    expect(ds.instruments).toEqual([]);
  });
  it.each([0, -1, Infinity, NaN])("rejects non-positive or nonfinite index %s", (value) => {
    const { artifact } = fixture();
    artifact.symbols[0]!.observations[0]![1] = value;
    expect(() => parseUnderlyingIndexArtifact(artifact, now)).toThrow();
  });
  it("rejects future vintages, future rows, wrong sources, duplicates and forbidden price fields", () => {
    const { artifact, ds } = fixture();
    expect(() => parseUnderlyingIndexArtifact(artifact, "2026-10-17T00:00:00Z")).toThrow();
    ds.asOfDate = "2026-10-15";
    expect(() => calculateIndexDiagnostics(ds, artifact)).toThrow();
    for (const change of [
      (a: UnderlyingIndexArtifact) => {
        a.symbols[0]!.observations[0]![3] = "NAV";
      },
      (a: UnderlyingIndexArtifact) => {
        a.symbols[0]!.observations[0]![0] = "2026-10-18";
      },
      (a: UnderlyingIndexArtifact) => {
        a.symbols[0]!.observations.push(a.symbols[0]!.observations[0]!);
      },
      (a: UnderlyingIndexArtifact) => {
        Object.assign(a.symbols[0]!, { close: 0 });
      },
      (a: UnderlyingIndexArtifact) => {
        Object.assign(a.sources[0]!, { field: "NAV" });
      },
    ]) {
      const a = structuredClone(artifact);
      change(a);
      expect(() => parseUnderlyingIndexArtifact(a, now)).toThrow();
    }
  });
});
describe("dedicated authenticated server implementation", () => {
  it("reads actual sidecar and original bytes, calculates twice identically with zero writes", async () => {
    const { artifact, csv } = fixture();
    release.sha256 = indexSha256(JSON.stringify(artifact));
    const f = fakeClient(csv, artifact);
    const before = [...f.bytes];
    const result = await readUnderlyingIndexDiagnostics(f.client, owner, now);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("not ready");
    expect(result.report.summary.newlyAvailable).toBe(1);
    expect(result.datasetBeforeSha256).toBe(result.datasetAfterSha256);
    expect(result.writesPerformed).toBe(0);
    expect(await readUnderlyingIndexDiagnostics(f.client, owner, now)).toEqual(result);
    expect(f.upload).not.toHaveBeenCalled();
    expect([...f.bytes]).toEqual(before);
  });
  it("rejects tampered sidecar and original bytes", async () => {
    const { artifact, csv } = fixture();
    release.sha256 = indexSha256(JSON.stringify(artifact));
    const f = fakeClient(csv, artifact);
    f.bytes.set(underlyingIndexPath(owner), JSON.stringify({ ...artifact, close: 0 }));
    await expect(readUnderlyingIndexDiagnostics(f.client, owner, now)).rejects.toThrow("해시");
    f.bytes.set(underlyingIndexPath(owner), JSON.stringify(artifact));
    f.sources[0]!.file_hash = "sha256:wrong";
    await expect(readUnderlyingIndexDiagnostics(f.client, owner, now)).rejects.toThrow("해시");
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("installs once with no pointer/registry/source changes and verifies identical retry", async () => {
    const { artifact, csv } = fixture();
    const text = JSON.stringify(artifact);
    release.sha256 = indexSha256(text);
    const f = fakeClient(csv);
    const before = [...f.bytes];
    const compressed = gzipSync(text).toString("base64");
    const first = await installUnderlyingIndexArtifact(f.client, owner, compressed, now);
    const second = await installUnderlyingIndexArtifact(f.client, owner, compressed, now);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect([...f.bytes].slice(0, before.length)).toEqual(before);
    expect([...f.bytes.keys()].filter((k) => !before.some(([p]) => p === k))).toEqual([
      underlyingIndexPath(owner),
    ]);
  });
  it("disabling release rolls back consumption without deleting or rewriting data", async () => {
    const { artifact, csv } = fixture();
    release.sha256 = indexSha256(JSON.stringify(artifact));
    const f = fakeClient(csv, artifact);
    const before = [...f.bytes];
    release.enabled = false;
    expect(await readUnderlyingIndexDiagnostics(f.client, owner, now)).toEqual({
      status: "disabled",
    });
    expect([...f.bytes]).toEqual(before);
    expect(f.download).not.toHaveBeenCalled();
  });
  it("rejects arbitrary paths and unreviewed payloads", async () => {
    expect(() => underlyingIndexPath("../other")).toThrow();
    const { csv, artifact } = fixture();
    const f = fakeClient(csv);
    await expect(
      installUnderlyingIndexArtifact(
        f.client,
        owner,
        gzipSync(JSON.stringify(artifact)).toString("base64"),
        now,
      ),
    ).rejects.toThrow("해시");
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("keeps dedicated endpoints isolated from price source registration and all publishers", () => {
    const server = readFileSync(
      new URL("../src/lib/underlyingIndexDiagnostics.server.ts", import.meta.url),
      "utf8",
    );
    for (const name of [
      "registerSource",
      "activateSource",
      "runWebScreening",
      "persistScreeningSnapshot",
      "recordWebOctoberShadow",
      "refreshPortfolioAfterScreening",
      "runFullMarketAnalysis",
      ".rpc(",
      ".upsert(",
    ])
      expect(server).not.toContain(name);
    const functions = readFileSync(
      new URL("../src/lib/underlyingIndexDiagnostics.functions.ts", import.meta.url),
      "utf8",
    );
    expect(functions).toContain("auth.getUser");
    expect(functions).toContain("owner: data.user.id");
    expect(functions).not.toContain("input.owner");
  });
  it("documents and does not use the unsafe ordinary sparse CSV route", async () => {
    const result = await validateSourceText(
      "symbol,name,type,market,date,etfUnderlyingIndexClose\n0046A0,ETF,ETF,ETF,2026-10-16,165",
      "sparse.csv",
    );
    expect(result.valid).toBe(true);
    expect(Number(result.rows[0]?.["close"])).toBe(0);
    const { ds, artifact } = fixture();
    expect(calculateIndexDiagnostics(ds, artifact).rows[0]?.diagnosticMa60).toBe(135.5);
    expect(ds.bars["0046A0"]?.at(-1)?.close).toBe(101);
  });
});

describe("quarantine evidence export", () => {
  it("exports both values and source candidates without changing diagnosis or inputs", () => {
    const { ds, artifact, csv } = fixture();
    const day = artifact.calendar.at(-1)!;
    artifact.symbols[0]!.observations.at(-1)![1] = 999;
    const before = datasetDigest(ds);
    const report = calculateIndexDiagnostics(ds, artifact);
    const source = {
      id: "source1",
      original_filename: "input.csv",
      file_hash: "sha256:verified",
      activated_at: null,
      created_at: now,
    } as never;
    const evidence = collectUnderlyingIndexEvidence(ds, artifact, report, [source], [csv]);
    const pair = evidence.observations.find((o) => o.date === day)!;
    expect(pair).toMatchObject({
      symbol: "0046A0",
      activeValue: 165,
      supplementValue: 999,
      valueConflict: true,
    });
    expect(evidence.sourceRows.find((o) => o.date === day)).toMatchObject({
      sourceId: "source1",
      indexValue: "165",
      indexName: "INDEX",
    });
    expect(evidence.sourceRows.every((o) => !("close" in o) && !("volume" in o))).toBe(true);
    expect(evidence.activeSources[0]).toMatchObject({
      filename: "input.csv",
      sha256: "sha256:verified",
    });
    expect(evidence.sourceRowsAreCandidatesNotWinningProvenance).toBe(true);
    expect(datasetDigest(ds)).toBe(before);
    expect(calculateIndexDiagnostics(ds, artifact)).toEqual(report);
  });
  it("does not export clean instruments and rejects misaligned source metadata", () => {
    const { ds, artifact, csv } = fixture();
    const report = calculateIndexDiagnostics(ds, artifact);
    expect(collectUnderlyingIndexEvidence(ds, artifact, report, [], []).observations).toEqual([]);
    expect(() => collectUnderlyingIndexEvidence(ds, artifact, report, [], [csv])).toThrow();
  });
});
