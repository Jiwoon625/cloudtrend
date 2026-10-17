import { collectUnderlyingIndexEvidence } from "../src/lib/underlyingIndexEvidence";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { parseManualMarketDataWithReferences as parseManualMarketData } from "../src/lib/krxReviewReferenceParser";
import {
  calculateIndexDiagnostics,
  parseUnderlyingIndexArtifact,
  validateUnderlyingIndexPreferenceDelta,
  type UnderlyingIndexArtifact,
} from "../src/lib/underlyingIndexSupplement";
import {
  datasetDigest,
  readArtifactText,
  sourceSetDigest,
  indexSha256,
  underlyingIndexPath,
  readUnderlyingIndexDiagnostics,
  installUnderlyingIndexArtifact,
} from "../src/lib/underlyingIndexDiagnostics.server";
import { UNDERLYING_INDEX_RELEASE } from "../src/lib/underlyingIndexSupplementRelease";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateSourceText } from "../src/lib/sourceData";
vi.mock("../src/lib/underlyingIndexSupplementRelease", () => ({
  UNDERLYING_INDEX_RELEASE: {
    enabled: true,
    sha256: "",
    originalArtifactSha256: "",
    cutoffDate: "2026-10-16",
  },
}));
const release = UNDERLYING_INDEX_RELEASE as {
  enabled: boolean;
  sha256: string;
  originalArtifactSha256: string;
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
function preferenceFixture() {
  const f = fixture();
  const original = structuredClone(f.artifact);
  const observation = f.artifact.symbols[0]!.observations[60]!;
  const expected = observation[1]!;
  observation[1] = expected - 1;
  f.artifact.approvedPreference = {
    version: "user-selected-supplement-v1",
    approvedAt: "2026-10-17T03:29:00.000Z",
    basis: "user-selected-vintage-not-official-finality",
    originalArtifactSha256: indexSha256(JSON.stringify(original)),
    expectedSourceSetDigest: "c".repeat(64),
    expectedDatasetSha256: datasetDigest(f.ds),
    expectedAsOfDate: f.ds.asOfDate,
    symbols: ["0046A0"],
    entries: [
      {
        symbol: "0046A0",
        date: observation[0],
        expectedActiveValue: expected,
        selectedValue: observation[1],
        indexName: "INDEX",
        activeProvider: "KRX_ETF",
        supplementSourceId: "archive",
        supplementSourceSha256: "a".repeat(64),
      },
    ],
  };
  f.artifact.availableFrom = "2026-10-17T03:30:00.000Z";
  const context = { sourceSetDigest: "c".repeat(64), datasetSha256: datasetDigest(f.ds), now };
  return { ...f, original, context };
}

describe("explicit user-selected diagnostic vintage", () => {
  it("changes only diagnostic MA60 and retains active values/conflicts", () => {
    const { ds, artifact, context } = preferenceFixture();
    const before = structuredClone({ ds, artifact });
    parseUnderlyingIndexArtifact(artifact, now);
    const row = calculateIndexDiagnostics(ds, artifact, context).rows[0]!;
    expect(row.status).toBe("compared");
    expect(row.diagnosticMa60).toBeCloseTo(135.5 - 1 / 60, 10);
    expect(row.conflicts).toEqual([artifact.calendar[60]]);
    expect(row.approvedPreferenceDates).toEqual(row.conflicts);
    expect(row.userSelectedVintage).toBe(true);
    expect(row.strategyApplied).toBe(false);
    expect({ ds, artifact }).toEqual(before);
  });
  it("counts exact approved choices even when they are below the conflict tolerance", () => {
    const { ds, artifact, context } = preferenceFixture();
    const entry = artifact.approvedPreference!.entries[0]!;
    entry.selectedValue = entry.expectedActiveValue - 1e-8;
    artifact.symbols[0]!.observations[60]![1] = entry.selectedValue;
    const before = structuredClone({ ds, artifact });
    const report = calculateIndexDiagnostics(
      ds,
      parseUnderlyingIndexArtifact(artifact, now),
      context,
    );
    const row = report.rows[0]!;
    expect(row.conflicts).toEqual([]);
    expect(row.diagnosticMa60).toBeLessThan(135.5);
    expect(row.approvedPreferenceDates).toEqual([entry.date]);
    expect(row.userSelectedVintage).toBe(true);
    expect(report.summary.approvedPreferenceSymbols).toBe(1);
    expect(report.summary.approvedPreferenceObservations).toBe(1);
    expect({ ds, artifact }).toEqual(before);
  });
  it("does not count approved keys outside the calculation window or quarantined choices", () => {
    const { ds, artifact, context } = preferenceFixture();
    const entry = artifact.approvedPreference!.entries[0]!;
    entry.date = artifact.calendar[0]!;
    entry.expectedActiveValue = 100;
    entry.selectedValue = 99;
    artifact.symbols[0]!.observations[0]![1] = 99;
    artifact.symbols[0]!.observations[60]![1] = 160;
    const bar = ds.observedBars!["0046A0"]!.find((b) => b.tradeDate === entry.date)!;
    bar.etfUnderlyingIndexClose = 100;
    bar.etfUnderlyingIndexName = "INDEX";
    bar.etfUnderlyingIndexSource = "KRX_ETF";
    context.datasetSha256 = artifact.approvedPreference!.expectedDatasetSha256 = datasetDigest(ds);
    const report = calculateIndexDiagnostics(
      ds,
      parseUnderlyingIndexArtifact(artifact, now),
      context,
    );
    expect(report.rows[0]?.status).toBe("compared");
    expect(report.rows[0]?.conflicts).toEqual([entry.date]);
    expect(report.rows[0]?.approvedPreferenceDates).toEqual([]);
    expect(report.summary.approvedPreferenceObservations).toBe(0);
    artifact.symbols[0]!.name = "UNAPPROVED NAME";
    const quarantined = calculateIndexDiagnostics(ds, artifact, context);
    expect(quarantined.rows[0]?.status).toBe("quarantined");
    expect(quarantined.rows[0]?.approvedPreferenceDates).toEqual([]);
    expect(quarantined.summary.approvedPreferenceSymbols).toBe(0);
  });
  it.each(["source", "dataset", "date", "future", "value", "provider", "name"])(
    "fails closed on %s drift",
    (kind) => {
      const { ds, artifact, context } = preferenceFixture();
      const bar = ds.observedBars!["0046A0"]!.find((b) => b.tradeDate === artifact.calendar[60])!;
      if (kind === "source") context.sourceSetDigest = "d".repeat(64);
      if (kind === "dataset") context.datasetSha256 = "d".repeat(64);
      if (kind === "date") ds.asOfDate = "2026-10-18";
      if (kind === "future") context.now = "2026-10-17T03:00:00.000Z";
      if (kind === "value") bar.etfUnderlyingIndexClose = 1;
      if (kind === "provider") bar.etfUnderlyingIndexSource = undefined;
      if (kind === "name") bar.etfUnderlyingIndexName = "OTHER";
      expect(() => calculateIndexDiagnostics(ds, artifact, context)).toThrow();
    },
  );
  it("requires verified calculation context", () => {
    const { ds, artifact } = preferenceFixture();
    expect(() => calculateIndexDiagnostics(ds, artifact)).toThrow();
  });
  it.each(["duplicate", "selected", "sourceHash", "symbols"])(
    "rejects invalid %s approval artifact",
    (kind) => {
      const { artifact } = preferenceFixture();
      const p = artifact.approvedPreference!;
      if (kind === "duplicate") p.entries.push({ ...p.entries[0]! });
      if (kind === "selected") p.entries[0]!.selectedValue = 1;
      if (kind === "sourceHash") p.entries[0]!.supplementSourceSha256 = "f".repeat(64);
      if (kind === "symbols") p.symbols.push("438100");
      expect(() => parseUnderlyingIndexArtifact(artifact, now)).toThrow();
    },
  );
  it("does not fill missing observations or approve additional conflicts", () => {
    const { ds, artifact, context } = preferenceFixture();
    artifact.symbols[0]!.observations[10]![1] = null;
    expect(calculateIndexDiagnostics(ds, artifact, context).rows[0]?.status).toBe("incomplete");
    artifact.symbols[0]!.observations[61]![1] = 1;
    const row = calculateIndexDiagnostics(ds, artifact, context).rows[0]!;
    expect(row.status).toBe("quarantined");
    expect(row.userSelectedVintage).toBe(false);
    expect(row.approvedPreferenceDates).toEqual([]);
    expect(row.diagnosticMa60).toBeNull();
  });
});

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
  let installation: unknown = null;
  const receipt = {
    select: () => receipt,
    eq: () => receipt,
    upsert: async (value: unknown) => {
      installation ??= value;
      return { error: null };
    },
    maybeSingle: async () => ({ data: installation, error: null }),
  };
  const from = vi.fn((table: string) => {
    if (table === "operational_index_installations") return receipt;
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
  release.originalArtifactSha256 = "b".repeat(64);
  release.cutoffDate = "2026-10-16";
});
describe("approved artifact original-lineage validation", () => {
  it("allows only exact approved values, availability and approval metadata without mutating either input", () => {
    const { artifact, original } = preferenceFixture();
    const before = structuredClone({ artifact, original });
    expect(() => validateUnderlyingIndexPreferenceDelta(artifact, original)).not.toThrow();
    expect({ artifact, original }).toEqual(before);
  });
  it.each([
    "unapproved-value",
    "source-uri",
    "source-hash",
    "index-name",
    "symbol-name",
    "historical-name",
    "observation-removal",
    "calendar",
  ])("rejects %s changes outside the exact approval delta", (kind) => {
    const { artifact, original } = preferenceFixture();
    if (kind === "unapproved-value") artifact.symbols[0]!.observations[10]![1] = 999;
    if (kind === "source-uri") artifact.sources[0]!.uri = "https://example.com/other";
    if (kind === "source-hash") {
      artifact.sources[0]!.sha256 = "f".repeat(64);
      artifact.approvedPreference!.entries[0]!.supplementSourceSha256 = "f".repeat(64);
    }
    if (kind === "index-name") {
      artifact.symbols[0]!.observations[60]![2] = "OTHER INDEX";
      artifact.approvedPreference!.entries[0]!.indexName = "OTHER INDEX";
    }
    if (kind === "symbol-name") artifact.symbols[0]!.name = "OTHER ETF";
    if (kind === "historical-name") artifact.symbols[0]!.historicalIndexNames.push("OTHER");
    if (kind === "observation-removal") artifact.symbols[0]!.observations.splice(10, 1);
    if (kind === "calendar") {
      artifact.calendar.shift();
      artifact.symbols[0]!.observations.shift();
    }
    expect(() =>
      validateUnderlyingIndexPreferenceDelta(parseUnderlyingIndexArtifact(artifact, now), original),
    ).toThrow("원본 지수 자료가 변경");
  });
  it("rejects applying approval to another approved vintage or backdating availability", () => {
    const { artifact, original } = preferenceFixture();
    expect(() => validateUnderlyingIndexPreferenceDelta(artifact, artifact)).toThrow();
    original.availableFrom = "2026-10-17T03:31:00.000Z";
    expect(() => validateUnderlyingIndexPreferenceDelta(artifact, original)).toThrow("앞당길");
  });

  function approvedClient() {
    const { csv, artifact, original } = preferenceFixture();
    const f = fakeClient(csv);
    artifact.approvedPreference!.expectedSourceSetDigest = sourceSetDigest(f.sources);
    release.originalArtifactSha256 = indexSha256(JSON.stringify(original));
    release.sha256 = indexSha256(JSON.stringify(artifact));
    f.bytes.set(underlyingIndexPath(owner), JSON.stringify(artifact));
    f.bytes.set(
      underlyingIndexPath(owner, release.originalArtifactSha256),
      JSON.stringify(original),
    );
    return { ...f, artifact, original };
  }
  it("reads and hashes the pinned original before returning the unchanged approved artifact", async () => {
    const f = approvedClient();
    const before = [...f.bytes];
    expect(await readArtifactText(f.client, owner, now)).toBe(JSON.stringify(f.artifact));
    expect(f.download.mock.calls.map(([path]) => path)).toEqual([
      underlyingIndexPath(owner),
      underlyingIndexPath(owner, release.originalArtifactSha256),
    ]);
    const result = await readUnderlyingIndexDiagnostics(f.client, owner, now);
    expect(result.status).toBe("ready");
    expect(f.upload).not.toHaveBeenCalled();
    expect([...f.bytes]).toEqual(before);
  });
  it.each(["missing", "tampered", "unpinned"])(
    "rejects %s original before consumption or installation",
    async (kind) => {
      const f = approvedClient();
      const originalPath = underlyingIndexPath(owner, release.originalArtifactSha256);
      if (kind === "missing") f.bytes.delete(originalPath);
      if (kind === "tampered")
        f.bytes.set(originalPath, JSON.stringify({ ...f.original, close: 0 }));
      if (kind === "unpinned") {
        f.artifact.approvedPreference!.originalArtifactSha256 = "f".repeat(64);
        release.sha256 = indexSha256(JSON.stringify(f.artifact));
        f.bytes.set(underlyingIndexPath(owner), JSON.stringify(f.artifact));
      }
      await expect(readArtifactText(f.client, owner, now)).rejects.toThrow();
      await expect(
        installUnderlyingIndexArtifact(
          f.client,
          owner,
          gzipSync(JSON.stringify(f.artifact)).toString("base64"),
          now,
        ),
      ).rejects.toThrow();
      expect(f.upload).not.toHaveBeenCalled();
    },
  );
  it("rejects extra content changes even if the approved artifact digest is repinned", async () => {
    const f = approvedClient();
    f.artifact.symbols[0]!.observations[10]![1] = 999;
    release.sha256 = indexSha256(JSON.stringify(f.artifact));
    f.bytes.set(underlyingIndexPath(owner), JSON.stringify(f.artifact));
    await expect(readArtifactText(f.client, owner, now)).rejects.toThrow("원본 지수 자료가 변경");
    f.bytes.delete(underlyingIndexPath(owner));
    await expect(
      installUnderlyingIndexArtifact(
        f.client,
        owner,
        gzipSync(JSON.stringify(f.artifact)).toString("base64"),
        now,
      ),
    ).rejects.toThrow("원본 지수 자료가 변경");
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("installs a validated approved vintage without touching the pinned original", async () => {
    const f = approvedClient();
    f.bytes.delete(underlyingIndexPath(owner));
    const before = [...f.bytes];
    const result = await installUnderlyingIndexArtifact(
      f.client,
      owner,
      gzipSync(JSON.stringify(f.artifact)).toString("base64"),
      now,
    );
    expect(result.reused).toBe(false);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect([...f.bytes].slice(0, before.length)).toEqual(before);
    expect(await readArtifactText(f.client, owner, now)).toBe(JSON.stringify(f.artifact));
  });
  it("provisions a missing pinned original and approved artifact immutably, then reuses both", async () => {
    const f = approvedClient();
    const approvedPath = underlyingIndexPath(owner);
    const originalPath = underlyingIndexPath(owner, release.originalArtifactSha256);
    f.bytes.delete(approvedPath);
    f.bytes.delete(originalPath);
    const before = [...f.bytes];
    const approved = gzipSync(JSON.stringify(f.artifact)).toString("base64");
    const original = gzipSync(JSON.stringify(f.original)).toString("base64");
    const first = await installUnderlyingIndexArtifact(f.client, owner, approved, now, original);
    expect(first.reused).toBe(false);
    expect(f.upload.mock.calls.map(([path]) => path)).toEqual([originalPath, approvedPath]);
    expect(f.upload.mock.calls.every(([, , options]) => options.upsert === false)).toBe(true);
    expect([...f.bytes].slice(0, before.length)).toEqual(before);
    expect(f.bytes.get(originalPath)).toBe(JSON.stringify(f.original));
    expect(await readArtifactText(f.client, owner, now)).toBe(JSON.stringify(f.artifact));
    const second = await installUnderlyingIndexArtifact(f.client, owner, approved, now, original);
    expect(second.reused).toBe(true);
    expect(f.upload).toHaveBeenCalledTimes(2);
  });
  it("reuses an existing verified original even when an optional copy is supplied", async () => {
    const f = approvedClient();
    f.bytes.delete(underlyingIndexPath(owner));
    const originalPath = underlyingIndexPath(owner, release.originalArtifactSha256);
    const originalText = f.bytes.get(originalPath);
    await installUnderlyingIndexArtifact(
      f.client,
      owner,
      gzipSync(JSON.stringify(f.artifact)).toString("base64"),
      now,
      gzipSync(JSON.stringify(f.original)).toString("base64"),
    );
    expect(f.upload.mock.calls.map(([path]) => path)).toEqual([underlyingIndexPath(owner)]);
    expect(f.bytes.get(originalPath)).toBe(originalText);
  });
  it("can provision only the missing original when the approved artifact is already present", async () => {
    const f = approvedClient();
    const originalPath = underlyingIndexPath(owner, release.originalArtifactSha256);
    const approvedText = f.bytes.get(underlyingIndexPath(owner));
    f.bytes.delete(originalPath);
    const result = await installUnderlyingIndexArtifact(
      f.client,
      owner,
      gzipSync(JSON.stringify(f.artifact)).toString("base64"),
      now,
      gzipSync(JSON.stringify(f.original)).toString("base64"),
    );
    expect(result.reused).toBe(true);
    expect(f.upload.mock.calls.map(([path]) => path)).toEqual([originalPath]);
    expect(f.bytes.get(underlyingIndexPath(owner))).toBe(approvedText);
  });
  it.each(["wrong-hash", "invalid-schema", "oversized", "invalid-pair", "source-drift"])(
    "rejects %s before writing either artifact for a new owner",
    async (kind) => {
      const f = approvedClient();
      f.bytes.delete(underlyingIndexPath(owner));
      f.bytes.delete(underlyingIndexPath(owner, release.originalArtifactSha256));
      let originalText = JSON.stringify(f.original);
      if (kind === "wrong-hash") originalText += " ";
      if (kind === "invalid-schema") {
        originalText = JSON.stringify({ ...f.original, close: 0 });
        release.originalArtifactSha256 = indexSha256(originalText);
        f.artifact.approvedPreference!.originalArtifactSha256 = release.originalArtifactSha256;
      }
      if (kind === "invalid-pair") f.artifact.symbols[0]!.observations[10]![1] = 999;
      if (kind === "source-drift") f.sources[0]!.created_at = "2026-10-17T03:00:00.000Z";
      release.sha256 = indexSha256(JSON.stringify(f.artifact));
      const suppliedOriginal =
        kind === "oversized" ? "a".repeat(4_000_001) : gzipSync(originalText).toString("base64");
      const before = [...f.bytes];
      await expect(
        installUnderlyingIndexArtifact(
          f.client,
          owner,
          gzipSync(JSON.stringify(f.artifact)).toString("base64"),
          now,
          suppliedOriginal,
        ),
      ).rejects.toThrow();
      expect(f.upload).not.toHaveBeenCalled();
      expect([...f.bytes]).toEqual(before);
    },
  );
  it("never overwrites a corrupt stored original with the optional valid copy", async () => {
    const f = approvedClient();
    f.bytes.delete(underlyingIndexPath(owner));
    const originalPath = underlyingIndexPath(owner, release.originalArtifactSha256);
    f.bytes.set(originalPath, "tampered original");
    await expect(
      installUnderlyingIndexArtifact(
        f.client,
        owner,
        gzipSync(JSON.stringify(f.artifact)).toString("base64"),
        now,
        gzipSync(JSON.stringify(f.original)).toString("base64"),
      ),
    ).rejects.toThrow("해시");
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.bytes.get(originalPath)).toBe("tampered original");
  });
  it.each([
    "failed",
    "tampered",
    "source-drift",
    "concurrent-identical",
    "uncertain-written",
    "uncertain-unwritten",
  ])("verifies the original upload outcome before approved storage: %s", async (kind) => {
    const f = approvedClient();
    const approvedPath = underlyingIndexPath(owner);
    const originalPath = underlyingIndexPath(owner, release.originalArtifactSha256);
    f.bytes.delete(approvedPath);
    f.bytes.delete(originalPath);
    f.upload.mockImplementationOnce(async (path, body, options) => {
      expect(path).toBe(originalPath);
      expect(options.upsert).toBe(false);
      if (kind === "failed") return { error: { message: "Storage unavailable" } };
      if (kind === "uncertain-unwritten") throw new Error("Connection interrupted");
      f.bytes.set(path, kind === "tampered" ? "corrupt readback" : await body.text());
      if (kind === "uncertain-written") throw new Error("Connection interrupted");
      if (kind === "source-drift") f.sources[0]!.created_at = "2026-10-17T03:00:00.000Z";
      return { error: kind === "concurrent-identical" ? { message: "Already exists" } : null };
    });
    const install = installUnderlyingIndexArtifact(
      f.client,
      owner,
      gzipSync(JSON.stringify(f.artifact)).toString("base64"),
      now,
      gzipSync(JSON.stringify(f.original)).toString("base64"),
    );
    if (kind === "concurrent-identical" || kind === "uncertain-written") {
      await expect(install).resolves.toMatchObject({ installed: true });
      expect(f.upload.mock.calls.map(([path]) => path)).toEqual([originalPath, approvedPath]);
      expect(await readArtifactText(f.client, owner, now)).toBe(JSON.stringify(f.artifact));
    } else {
      await expect(install).rejects.toThrow();
      expect(f.upload.mock.calls.map(([path]) => path)).toEqual([originalPath]);
      expect(f.bytes.has(approvedPath)).toBe(false);
    }
  });
  const originalPath = process.env["UNDERLYING_INDEX_ORIGINAL_FILE"] ?? "";
  const approvedPath = process.env["UNDERLYING_INDEX_APPROVED_FILE"] ?? "";
  it.runIf(existsSync(originalPath) && existsSync(approvedPath))(
    "validates the actual 2026-10-17 pinned original and approved artifact pair when available locally",
    async () => {
      const originalText = readFileSync(originalPath, "utf8");
      const approvedText = readFileSync(approvedPath, "utf8");
      release.originalArtifactSha256 =
        "20e037c1b172091e02d2670b53323978db193529ce370feb3850b1d1a9346b6b";
      release.sha256 = "79e1321b5968b911f6344616a0aa1d63b0b26f2235e09e6dfb53a3d3a1a3f426";
      expect(indexSha256(originalText)).toBe(release.originalArtifactSha256);
      expect(indexSha256(approvedText)).toBe(release.sha256);
      const f = fakeClient("");
      f.bytes.set(underlyingIndexPath(owner), approvedText);
      f.bytes.set(underlyingIndexPath(owner, release.originalArtifactSha256), originalText);
      expect(await readArtifactText(f.client, owner, "2026-10-17T08:00:00.000Z")).toBe(
        approvedText,
      );
      expect(f.upload).not.toHaveBeenCalled();
    },
  );
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
  it("does not confuse an archived historical regime with the single current observation regime", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.historicalIndexNames.push("OLD TR");
    const before = structuredClone({ ds, artifact });
    const row = calculateIndexDiagnostics(ds, artifact).rows[0]!;
    expect(row.status).toBe("compared");
    expect(row.indexName).toBe("INDEX");
    expect(row.diagnosticMa60).toBe(135.5);
    expect({ ds, artifact }).toEqual(before);
  });
  it("still quarantines an actual retained TR/PR transition even if metadata lists only one name", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.observations[0]![2] = "OLD TR";
    expect(calculateIndexDiagnostics(ds, artifact).rows[0]?.status).toBe("quarantined");
  });
  it.each(["name", "index", "value"])(
    "quarantines %s identity/value conflicts instead of replacing",
    (kind) => {
      const { ds, artifact } = fixture();
      if (kind === "name") artifact.symbols[0]!.name = "OTHER";
      if (kind === "index") artifact.symbols[0]!.observations[5]![2] = "OTHER";
      if (kind === "value") artifact.symbols[0]!.observations[65]![1] = 1;
      const row = calculateIndexDiagnostics(ds, artifact).rows[0]!;
      expect(row.status).toBe("quarantined");
      expect(row.diagnosticMa60).toBeNull();
      expect(row.supplementedObservations).toBe(0);
      expect(row.currentIndex).toBe(165);
    },
  );
  it.each([undefined, "OTHER_PROVIDER"])(
    "quarantines untrusted retained overlap outside latest 60: %s",
    (provider) => {
      const { ds, artifact } = fixture();
      artifact.symbols[0]!.historicalIndexNames.push("OLD TR");
      const day = artifact.calendar[0]!;
      const bar = {
        ...ds.bars["0046A0"]!.at(-1)!,
        tradeDate: day,
        etfUnderlyingIndexClose: artifact.symbols[0]!.observations[0]![1]!,
        etfUnderlyingIndexName: "INDEX",
        etfUnderlyingIndexSource: provider,
      };
      ds.bars["0046A0"]!.unshift(bar);
      if (ds.observedBars?.["0046A0"] && ds.observedBars["0046A0"] !== ds.bars["0046A0"])
        ds.observedBars["0046A0"]!.unshift(bar);
      const before = datasetDigest(ds);
      const row = calculateIndexDiagnostics(ds, artifact).rows[0]!;
      expect(row.status).toBe("quarantined");
      expect(row.issues).toContain("보강 중복 관측의 활성 기초지수명·출처 누락 또는 변경");
      expect(row.diagnosticMa60).toBeNull();
      expect(row.supplementedObservations).toBe(0);
      expect(datasetDigest(ds)).toBe(before);
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

describe("bounded evidence and source format disclosure", () => {
  it("discloses JSON source omission without blocking normalized evidence", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.observations.at(-1)![1] = 999;
    const report = calculateIndexDiagnostics(ds, artifact);
    const source = { id: "json-source" } as never;
    const evidence = collectUnderlyingIndexEvidence(
      ds,
      artifact,
      report,
      [source],
      ['[{"symbol":"0046A0"}]'],
    );
    expect(evidence.observations[0]?.activeValue).toBe(165);
    expect(evidence.sourceRows).toEqual([]);
    expect(evidence.sourceEvidenceComplete).toBe(false);
    expect(evidence.limitations[0]).toContain("JSON");
  });
  it("caps raw evidence and explicitly reports omission", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.observations.at(-1)![1] = 999;
    const report = calculateIndexDiagnostics(ds, artifact);
    const header = "symbol,date,etfUnderlyingIndexClose";
    const csv = [header, ...Array(5100).fill(`0046A0,${ds.asOfDate},165`)].join("\n");
    const evidence = collectUnderlyingIndexEvidence(
      ds,
      artifact,
      report,
      [{ id: "bounded" } as never],
      [csv],
    );
    expect(evidence.sourceRows.length).toBeLessThanOrEqual(5000);
    expect(evidence.sourceEvidenceComplete).toBe(false);
    expect(evidence.limitations.join(" ")).toContain("limit");
  });
  it("uses last alias column while explicitly marking ambiguity", () => {
    const { ds, artifact } = fixture();
    artifact.symbols[0]!.observations.at(-1)![1] = 999;
    const report = calculateIndexDiagnostics(ds, artifact);
    const csv = `symbol,code,date,etfUnderlyingIndexClose,etf_underlying_index_close\n000000,0046A0,${ds.asOfDate},1,165`;
    const evidence = collectUnderlyingIndexEvidence(
      ds,
      artifact,
      report,
      [{ id: "alias" } as never],
      [csv],
    );
    expect(evidence.sourceRows[0]?.indexValue).toBe("165");
    expect(evidence.sourceEvidenceComplete).toBe(false);
  });
});
