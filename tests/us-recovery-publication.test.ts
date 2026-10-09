import { createImmutableArchiveFixture } from "./immutable-archive-fixture";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  loadPublishedUsRecoveryView,
  preflightUsRecoveryPublication,
  publishUsRecoveryViews,
  type UsRecoveryPublicationInput,
} from "../scripts/us-recovery-publication";
import { compactRow } from "../scripts/us-screening-publication";
import { sha256, stableJson } from "../scripts/analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
import type { UsReplaySessionSource } from "../scripts/us-replay-source";
import { sourceCsv } from "./us-replay-fixtures";

const uid = "11111111-1111-4111-8111-111111111111";
const day = "2026-10-07";
const originalHash = `sha256:${"a".repeat(64)}`;
const recoveredHash = `sha256:${"b".repeat(64)}`;
const artifactPath = `${uid}/results/us-recovered-screening/${day}.json`;
const latestPath = `${uid}/cache/us-screening/latest.json`;
const viewPath = `${uid}/cache/us-screening/view-v1.json.gz`;
const summaryPath = `${uid}/cache/us-screening/summary-v1.json`;
const identity = { date: day, dataHash: originalHash, ruleVersion: US_PROSPECTIVE_RULE_VERSION };

function setup() {
  const rows = parseUsProspectiveCsv(sourceCsv(day));
  const analysis = runUsProspectiveAnalysis(rows, {
    lastDate: "2026-10-06",
    coreRanks: { TEST: 0.1 },
    betaWeakStreak: { TEST: 1 },
  });
  const source: UsReplaySessionSource = {
    date: day,
    previousSessionDate: "2026-10-06",
    storagePath: `${uid}/us-replay/${day}.csv`,
    dataHash: recoveredHash,
    rowCount: rows.length,
    symbolCount: rows.length,
    sourceCapturedAt: `${day}T21:00:00Z`,
    confirmedRegularClose: true,
    failedSymbols: 0,
    sourceCoverageComplete: true,
    quarantinedSymbols: [],
    pit: {
      kind: "ATOMIC_DATED_SNAPSHOT",
      asOfDate: day,
      rosterCapturedAt: `${day}T21:00:00Z`,
      rosterStoragePath: `${uid}/us-replay/${day}.roster.json`,
      rosterHash: `sha256:${"c".repeat(64)}`,
    },
  };
  const original = JSON.stringify({
    dataHash: originalHash,
    analysis: {
      ...analysis,
      rows: analysis.rows.map((r) => ({ ...r, a0Entry: false, a2Entry: false, b3Entry: false })),
    },
  });
  const files = new Map<string, string | Buffer>([
    [`${uid}/results/us-screening/${day}.json`, original],
    [`${uid}/results/us-screening/${day}.manifest.json`, "unchanged manifest"],
    [`${uid}/sources/original.csv`, "unchanged input"],
    [latestPath, original],
  ]);
  const ingest = {
    as_of_date: day,
    data_hash: originalHash,
    storage_bucket: "cloudtrend-data",
    source_provider: "Toss",
    schema_version: "us-source-v1",
  };
  let history: Record<string, string> | null = {
    date: day,
    data_hash: originalHash,
    rule_version: US_PROSPECTIVE_RULE_VERSION,
  };
  const writes: Array<{ path: string; upsert: boolean }> = [];
  const reads: string[] = [];
  let failPath: string | null = null;
  let onArtifactWrite: (() => void) | null = null;
  const mutateDatabase = vi.fn(() => {
    throw new Error("Database writes are forbidden");
  });
  const archive = createImmutableArchiveFixture();
  const c = {
    from(table: string) {
      if (table === "screening_run_archive") return archive();
      reads.push(table);
      if (!["us_screening_ingest", "us_screening_history"].includes(table))
        throw new Error(`Unexpected database read: ${table}`);
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "us_screening_ingest" ? ingest : history,
          error: null,
        }),
        insert: mutateDatabase,
        update: mutateDatabase,
        upsert: mutateDatabase,
        delete: mutateDatabase,
      };
      return q;
    },
    rpc: mutateDatabase,
    storage: {
      from(bucket: string) {
        expect(bucket).toBe("cloudtrend-data");
        return {
          async download(path: string) {
            reads.push(path);
            const data = files.get(path);
            return data === undefined
              ? { data: null, error: { message: "404 Object not found" } }
              : { data: { text: async () => data.toString() }, error: null };
          },
          async upload(path: string, body: string | Buffer, options: { upsert: boolean }) {
            writes.push({ path, upsert: options.upsert });
            if (path === failPath) {
              failPath = null;
              return { error: { message: "Deliberate failure" } };
            }
            if (!options.upsert && files.has(path)) return { error: { message: "Already exists" } };
            files.set(path, body);
            if (path === artifactPath) onArtifactWrite?.();
            return { error: null };
          },
        };
      },
    },
  };
  const input: UsRecoveryPublicationInput = {
    client: c as unknown as UsRecoveryPublicationInput["client"],
    userId: uid,
    analysis,
    source,
    manifestHash: `sha256:${"d".repeat(64)}`,
    operatingPlanHash: `sha256:${"e".repeat(64)}`,
    generatedAt: "2026-10-08T02:00:00Z",
    protectedOriginal: {
      date: day,
      data_hash: originalHash,
      rule_version: US_PROSPECTIVE_RULE_VERSION,
      resultHash: `sha256:${sha256(original)}`,
    },
  };
  return {
    input,
    files,
    writes,
    reads,
    mutateDatabase,
    ingest,
    original,
    setHistory: (h: Record<string, string> | null) => {
      history = h;
    },
    failNext: (path: string) => {
      failPath = path;
    },
    onArtifact: (fn: () => void) => {
      onArtifactWrite = fn;
    },
    json: (path: string) => JSON.parse(files.get(path)!.toString()),
  };
}

describe("publish-only recovered US screening", () => {
  it("preflights without writes, engines, source rereads, or full original result rereads", async () => {
    const f = setup();
    const source = readFileSync(
      new URL("../scripts/us-recovery-publication.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /runUsProspectiveAnalysis|stepUsProspective|replayUsShadow|planUs|\.rpc\(|\.insert\(|\.update\(|\.upsert\(/,
    );
    const payload = await preflightUsRecoveryPublication(f.input);
    expect(payload.analysis.rows).toEqual(f.input.analysis.rows.map(compactRow));
    expect(f.writes).toEqual([]);
    expect(f.mutateDatabase).not.toHaveBeenCalled();
    expect(f.reads).toEqual([
      "us_screening_ingest",
      latestPath,
      "us_screening_history",
      artifactPath,
    ]);
  });

  it("preserves final entries and original data while publishing the exact normal compact rows", async () => {
    const f = setup();
    const protectedFiles = [...f.files].filter(([path]) => path !== latestPath);
    const inputBefore = stableJson({ ...f.input, client: undefined });
    expect(f.input.analysis.rows.some((r) => r.a0Entry)).toBe(true);
    const result = await publishUsRecoveryViews(f.input);
    expect(result.analysis.rows).toEqual(f.input.analysis.rows.map(compactRow));
    expect(result.analysis).not.toHaveProperty("state");
    expect(f.json(latestPath)).toEqual(result);
    expect(f.json(artifactPath)).toEqual(result);
    expect(f.writes.map((w) => w.path)).toEqual([artifactPath, latestPath, viewPath, summaryPath]);
    expect(f.writes[0]!.upsert).toBe(false);
    const browser = JSON.parse(gunzipSync(f.files.get(viewPath) as Buffer).toString());
    const summary = f.json(summaryPath);
    expect(browser.analysis.rows).toEqual(result.analysis.rows);
    expect(browser.analysis).not.toHaveProperty("state");
    expect(summary.analysis).not.toHaveProperty("rows");
    expect(summary.analysis.rowCount).toBe(result.analysis.rows.length);
    for (const [path, content] of protectedFiles) expect(f.files.get(path)).toBe(content);
    expect(stableJson({ ...f.input, client: undefined })).toBe(inputBefore);
    expect(f.mutateDatabase).not.toHaveBeenCalled();
  });

  it("round-trips recovery metadata and keeps incomplete source coverage truthful", async () => {
    const f = setup();
    const quarantined = f.input.analysis.rows.find((r) => r.symbol === "TEST")!;
    Object.assign(quarantined, {
      open: null,
      close: null,
      ret120: null,
      ret252: null,
      a0Entry: false,
      a2Entry: false,
      b3Entry: false,
    });
    Object.assign(f.input.source, {
      sourceCoverageComplete: false,
      quarantinedSymbols: ["TEST"],
      originalSource: {
        storagePath: `${uid}/sources/original.csv`,
        dataHash: originalHash,
        sourceCapturedAt: `${day}T21:00:00Z`,
      },
    });
    f.input.source.pit.kind = "REVIEWED_ATOMIC_QUARANTINE";
    const result = await publishUsRecoveryViews(f.input);
    const loaded = await loadPublishedUsRecoveryView(f.input.client, uid, identity);
    expect(loaded).toEqual(result);
    expect(result.dataHash).toBe(recoveredHash);
    expect(result.source.metadata).toMatchObject({
      sourceCoverageComplete: false,
      quarantinedSymbols: ["TEST"],
      recoveryPublication: {
        version: "us-recovery-publication-v1",
        manifestHash: f.input.manifestHash,
        operatingPlanHash: f.input.operatingPlanHash,
        originalDataHash: originalHash,
        originalResultHash: f.input.protectedOriginal.resultHash,
        sourceKind: "REVIEWED_ATOMIC_QUARANTINE",
      },
    });
    expect(f.json(summaryPath).source).toEqual(result.source);
    expect(JSON.parse(gunzipSync(f.files.get(viewPath) as Buffer).toString()).source).toEqual(
      result.source,
    );
  });

  it("rejects a newer latest cache before any write", async () => {
    const f = setup();
    f.files.set(latestPath, JSON.stringify({ analysis: { date: "2026-10-08" } }));
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("newer latest cache");
    expect(f.writes).toEqual([]);
  });

  it("rechecks the current ingest/latest after immutable storage before cache writes", async () => {
    const f = setup();
    f.onArtifact(() => {
      f.ingest.as_of_date = "2026-10-08";
    });
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("Current US ingest");
    expect(f.writes.map((w) => w.path)).toEqual([artifactPath]);
    expect(f.files.get(latestPath)).toBe(f.original);
  });

  it.each(["data_hash", "as_of_date"] as const)(
    "rejects changed ingest %s before publication",
    async (field) => {
      const f = setup();
      f.ingest[field] = "changed";
      await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("Current US ingest");
      expect(f.writes).toEqual([]);
    },
  );

  it("rejects absent original history rather than inventing a completion marker", async () => {
    const f = setup();
    f.setHistory(null);
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("history marker");
    expect(f.writes).toEqual([]);
  });

  it("rejects conflicting immutable date artifacts before touching cache", async () => {
    const f = setup();
    await publishUsRecoveryViews(f.input);
    const priorWrites = f.writes.length;
    f.input.operatingPlanHash = `sha256:${"f".repeat(64)}`;
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("publication conflict");
    expect(f.writes).toHaveLength(priorWrites);
  });

  it("retries idempotently after a partial cache failure without rewriting original artifacts", async () => {
    const f = setup();
    f.failNext(viewPath);
    await expect(publishUsRecoveryViews(f.input)).rejects.toEqual({
      message: "Deliberate failure",
    });
    const immutable = f.files.get(artifactPath);
    const result = await publishUsRecoveryViews(f.input);
    expect(f.files.get(artifactPath)).toBe(immutable);
    expect(result.generatedAt).toBe(f.input.generatedAt);
    expect(f.json(summaryPath).source.metadata).toEqual(result.source.metadata);
    expect(f.files.get(`${uid}/results/us-screening/${day}.json`)).toBe(f.original);
    expect(f.mutateDatabase).not.toHaveBeenCalled();
  });

  it("returns null only for missing publication and rejects malformed or mismatched saved views", async () => {
    const f = setup();
    expect(await loadPublishedUsRecoveryView(f.input.client, uid, identity)).toBeNull();
    f.files.set(artifactPath, "{}");
    await expect(loadPublishedUsRecoveryView(f.input.client, uid, identity)).rejects.toThrow(
      "Malformed",
    );
    f.files.delete(artifactPath);
    const result = await publishUsRecoveryViews(f.input);
    await expect(
      loadPublishedUsRecoveryView(f.input.client, uid, { ...identity, dataHash: recoveredHash }),
    ).rejects.toThrow("mismatched");
    f.files.set(
      artifactPath,
      JSON.stringify({ ...result, analysis: { ...result.analysis, state: { positions: [] } } }),
    );
    await expect(loadPublishedUsRecoveryView(f.input.client, uid, identity)).rejects.toThrow(
      "Malformed",
    );
  });

  it.each(["manifestHash", "operatingPlanHash"] as const)(
    "rejects malformed %s without writes",
    async (field) => {
      const f = setup();
      f.input[field] = "unverified";
      await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("source/date/hash/rule");
      expect(f.writes).toEqual([]);
    },
  );

  it("rejects source/date/rule mismatch and false coverage claims without writes", async () => {
    const f = setup();
    f.input.source.date = "2026-10-06";
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("source/date/hash/rule");
    f.input.source.date = day;
    f.input.analysis.ruleVersion = "changed";
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("source/date/hash/rule");
    f.input.analysis.ruleVersion = US_PROSPECTIVE_RULE_VERSION;
    f.input.source.quarantinedSymbols = ["TEST"];
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("Malformed");
    expect(f.writes).toEqual([]);
  });

  it("blocks a newer latest cache that arrives after the immutable upload", async () => {
    const f = setup();
    f.onArtifact(() => {
      f.files.set(latestPath, JSON.stringify({ analysis: { date: "2026-10-08" } }));
    });
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("newer latest cache");
    expect(f.writes.map((w) => w.path)).toEqual([artifactPath]);
  });

  it("blocks a conflicting readback without publishing any cache", async () => {
    const f = setup();
    f.onArtifact(() => {
      f.files.set(artifactPath, JSON.stringify({ conflict: true }));
    });
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("readback mismatch");
    expect(f.writes.map((w) => w.path)).toEqual([artifactPath]);
  });

  it("rejects an invalid source hash or missing protected original before I/O", async () => {
    const f = setup();
    f.input.source.dataHash = "invalid";
    await expect(publishUsRecoveryViews(f.input)).rejects.toThrow("source/date/hash/rule");
    await expect(
      publishUsRecoveryViews({
        ...f.input,
        protectedOriginal: undefined,
      } as unknown as UsRecoveryPublicationInput),
    ).rejects.toThrow("protected original marker");
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("rejects full plans, engine fields, and malformed rows in a saved publication", async () => {
    const f = setup();
    const result = await publishUsRecoveryViews(f.input);
    const malformed = [
      { ...result, source: { ...result.source, fullPlan: { positions: [] } } },
      {
        ...result,
        source: { ...result.source, metadata: { ...result.source.metadata, fullPlan: {} } },
      },
      {
        ...result,
        analysis: {
          ...result.analysis,
          rows: result.analysis.rows.map((r) => ({ ...r, sharesOutstanding: 1000 })),
        },
      },
      {
        ...result,
        analysis: {
          ...result.analysis,
          rows: result.analysis.rows.map((r) => ({ ...r, a0Entry: "true" })),
        },
      },
    ];
    for (const bad of malformed) {
      f.files.set(artifactPath, JSON.stringify(bad));
      await expect(loadPublishedUsRecoveryView(f.input.client, uid, identity)).rejects.toThrow(
        "Malformed",
      );
    }
  });
});
