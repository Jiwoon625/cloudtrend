import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ETF_POLICY, type EtfStrategySnapshot } from "../engine/etfStrategy";
import { getOperationalSignals } from "../engine/operationalStrategy";
import type { DailyPrice } from "../engine/types";
import { decimal, format, multiply } from "../ledger/decimal";
import type { SeriesHash } from "../ledger/modelSeries";
import type { ScreeningSnapshot, SnapshotEntry } from "../screeningSnapshot";
import { kospiGate } from "../../../tests/kospi-policy-fixtures";
import { runAdoptedEtfBacktest, type AdoptedEtfBacktestInput } from "./adoptedEtfBacktest";
import { runAdoptedKrBacktest, type AdoptedKrBacktestInput } from "./adoptedKrBacktest";
import {
  SIGNAL_CACHE_INDEX_VERSION,
  SIGNAL_CACHE_VERSION,
  accumulateSignalQuality,
  assertAdoptedSignalRecord,
  createAdoptedSignalIdentity,
  openAdoptedSignalCache,
  signalCacheHash,
  signalQualityAccumulator,
  stableSignalHash,
  writeAdoptedSignalCache,
  type AdoptedSignalCacheIndex,
  type AdoptedSignalCacheManifest,
  type AdoptedSignalIdentity,
  type AdoptedSignalRecord,
  type SignalCacheFile,
} from "./adoptedSignalCache";

const dates = [
  "2019-12-26",
  "2019-12-27",
  "2019-12-30",
  "2019-12-31",
  "2020-01-02",
  "2020-01-03",
  "2020-01-06",
  "2020-01-07",
];
const fullSessions = ["2019-12-24", ...dates, "2020-01-08"];
const etfSymbols = ["360750", "069500", "091160", "102110"];
const hash = (digit: string): SeriesHash => `sha256:${digit.repeat(64)}`;
const hashBytes = (bytes: Buffer): SeriesHash =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const identityInput = () => ({
  sourceKind: "CANONICAL_CSV" as const,
  files: [
    { bytes: 17, sha256: hash("a") },
    { bytes: 29, sha256: hash("b") },
  ],
  sessions: fullSessions,
  actualSessions: fullSessions,
  extension: { afterDate: "2020-01-07", rows: 1 },
  codeHash: hash("c"),
  policy: { context: "CURRENT_RULES_RESEARCH", kr: { slots: 30 }, etf: ETF_POLICY },
});
const identity = () => createAdoptedSignalIdentity(identityInput());
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "adopted-signal-cache-test-"));
  roots.push(root);
  return root;
}
function stockEntry(symbol: string, changes: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    symbol,
    name: symbol,
    instrumentType: "STOCK",
    sectorCode: symbol,
    sectorName: symbol,
    grade: "A",
    status: "",
    totalScore: 80,
    scoreDelta1d: 5,
    technicalPoints: 8,
    priorityPoints: 5,
    hardFilterPassed: true,
    ...getOperationalSignals("KOSDAQ", 7.5, 8, true),
    ...changes,
  };
}
function strategy(date: string, previousDate: string, onsetIndex: number, index: number) {
  const state = index === onsetIndex ? "pending" : index === onsetIndex + 1 ? "confirmed" : "none";
  return {
    version: ETF_POLICY.version,
    date,
    previousDate,
    eligible: true,
    score: 85,
    previousScore: state === "pending" ? 79 : 81,
    technical: 85,
    priority: 7,
    health: 14,
    environment: 14,
    environmentSource: "stock_sector",
    region: "KR",
    sector: "TECH",
    annualVolatility: onsetIndex === 4 ? 0.15 : 0.3,
    entryWeight: 0.05,
    underlyingClose: 100,
    underlyingMa60: 95,
    onset: state === "confirmed",
    rawOnset: state === "pending",
    entryState: state,
    originDate: state === "pending" ? date : state === "confirmed" ? previousDate : null,
    confirmationDate: state === "confirmed" ? date : null,
    confirmationIssues: [],
    averageTradingValue20: 1e9,
    dataStatus: "ready",
    krxReferenceDate: null,
    exit: onsetIndex === 0 && index === 6 ? "MA60" : null,
    issues: [],
  } satisfies EtfStrategySnapshot;
}
function records(): AdoptedSignalRecord[] {
  return dates.map((date, index) => {
    const entries =
      index === 0
        ? [stockEntry("A")]
        : index === 3
          ? [stockEntry("B")]
          : index === 5
            ? [stockEntry("C")]
            : index === 6
              ? [stockEntry("A", { kosdaq80Onset: false, exitSignal: "UP90" })]
              : index === 7
                ? [stockEntry("D")]
                : [];
    const strategies = etfSymbols.map((symbol, symbolIndex) => ({
      symbol,
      strategy: strategy(date, dates[index - 1] ?? "2019-12-24", symbolIndex * 2, index),
    }));
    return {
      date,
      krSnapshot: {
        date,
        asOfDate: date,
        marketGateStatus: "RISK_ON",
        entries,
        totalCount: entries.length,
        passedCount: entries.length,
        gradeACount: entries.length,
        gradeBCount: 0,
      },
      krGate: kospiGate(date),
      etfSnapshot: { date, strategies },
      counters: {
        scoredEntries: entries.length + strategies.length,
        pendingStockEntries: 0,
        missingStockScores: 0,
        incompleteKospiGateSessions: 0,
        validScores: { KOSPI: 0, KOSDAQ: entries.length, ETF: strategies.length },
        entryReady: {
          KOSPI: 0,
          KOSDAQ: entries.filter((entry) => entry.kosdaq80Onset).length,
          ETF: strategies.filter((entry) => entry.strategy.onset).length,
        },
      },
    };
  });
}
async function descriptor(file: string, relativeTo: string): Promise<SignalCacheFile> {
  const bytes = await readFile(file);
  return { path: path.relative(relativeTo, file), bytes: bytes.length, sha256: hashBytes(bytes) };
}
async function cacheFixture(
  slices = [
    [0, 1],
    [1, 4],
    [4, 5],
    [5, dates.length],
  ],
  sourceRecords = records(),
) {
  const root = await tempDir();
  const cacheIdentity = identity();
  const manifests: AdoptedSignalCacheManifest[] = [];
  const manifestPaths: string[] = [];
  for (const [index, [start, end]] of slices.entries()) {
    const out = path.join(root, `chunk-${index}`);
    await mkdir(out);
    const selected = sourceRecords.slice(start, end);
    async function* stream() {
      for (const record of selected) yield record;
    }
    manifests.push(
      await writeAdoptedSignalCache({
        out,
        identity: cacheIdentity,
        evaluationDates: selected.map((row) => row.date),
        records: stream(),
      }),
    );
    manifestPaths.push(path.join(out, "signal-cache.manifest.json"));
  }
  const indexPath = path.join(root, "signal-cache.index.json");
  const index: AdoptedSignalCacheIndex = {
    version: SIGNAL_CACHE_INDEX_VERSION,
    chunks: await Promise.all(manifestPaths.map((file) => descriptor(file, root))),
  };
  const saveIndex = () => writeFile(indexPath, JSON.stringify(index));
  await saveIndex();
  const open = (
    selectedSessions = dates,
    overrides: Partial<Parameters<typeof openAdoptedSignalCache>[0]> = {},
  ) =>
    openAdoptedSignalCache({
      indexPath,
      identity: cacheIdentity,
      actualSessions: fullSessions,
      selectedSessions,
      ...overrides,
    });
  async function saveManifest(chunk: number) {
    await writeFile(manifestPaths[chunk]!, JSON.stringify(manifests[chunk]));
    index.chunks[chunk] = await descriptor(manifestPaths[chunk]!, root);
    await saveIndex();
  }
  async function replacePayload(chunk: number, text: string) {
    const manifest = manifests[chunk]!;
    const file = path.resolve(path.dirname(manifestPaths[chunk]!), manifest.data.path);
    await writeFile(file, gzipSync(text));
    manifest.data = await descriptor(file, path.dirname(manifestPaths[chunk]!));
    await saveManifest(chunk);
  }
  return {
    root,
    indexPath,
    index,
    manifests,
    manifestPaths,
    open,
    saveIndex,
    saveManifest,
    replacePayload,
  };
}
async function collect(opened: Awaited<ReturnType<typeof openAdoptedSignalCache>>) {
  const rows = [];
  for await (const row of opened.records()) rows.push(row);
  return rows;
}
const drain = async (cache: Awaited<ReturnType<typeof cacheFixture>>, selected = dates) =>
  collect(await cache.open(selected));

function bar(tradeDate: string, open = 100, close = open): DailyPrice {
  return {
    tradeDate,
    open,
    close,
    high: Math.max(open, close),
    low: Math.min(open, close),
    volume: 1000,
    tradingValue: close * 1000,
    marketCap: 1e12,
    foreignNetBuyValue: 1000,
    institutionNetBuyValue: 100,
    openObserved: true,
    volumeObserved: true,
  };
}
function krInput(
  rows: Array<{ record: AdoptedSignalRecord; generatedAt: string }>,
): AdoptedKrBacktestInput {
  const symbols = ["A", "B", "C", "D"];
  const bars = Object.fromEntries(
    symbols.map((symbol) => [symbol, dates.map((date) => bar(date))]),
  );
  bars["A"] = dates.map((date, index) => bar(date, index >= 2 ? 200 : 100));
  bars["B"]![4]!.openObserved = false;
  return {
    startDate: dates[0]!,
    throughDate: dates.at(-1)!,
    scope: "MIXED",
    marketDates: dates,
    snapshots: rows.map(({ record, generatedAt }): ScreeningSnapshot => ({
      ...record.krSnapshot,
      savedAt: generatedAt,
    })),
    marketGates: Object.fromEntries(
      rows.flatMap(({ record }) => (record.krGate ? [[record.date, record.krGate]] : [])),
    ),
    bars,
    markets: Object.fromEntries(symbols.map((symbol) => [symbol, "KOSDAQ" as const])),
  };
}
function etfInput(rows: AdoptedEtfBacktestInput["snapshots"]): AdoptedEtfBacktestInput {
  const observedBars = Object.fromEntries(
    etfSymbols.map((symbol) => [
      symbol,
      dates.map((tradeDate, index) => ({
        tradeDate,
        open: symbol === etfSymbols[1] && index === 4 ? null : 10000,
        close: symbol === etfSymbols[0] && index >= 2 ? (index < 4 ? 20000 : 50000) : 10000,
        volume: 1000,
      })),
    ]),
  );
  return {
    runId: "signal-cache-economic-equivalence",
    startDate: dates[0]!,
    endDate: dates.at(-1)!,
    codeHash: hash("c"),
    sourceHash: hash("a"),
    calendar: {
      market: "KR",
      sourceHash: hash("d"),
      coverageStart: dates[0]!,
      coverageEnd: dates.at(-1)!,
      regularSessions: dates,
    },
    etfSymbols,
    observedBars,
    snapshots: rows,
    includeRecords: true,
  };
}

describe("adopted signal cache identity", () => {
  it("binds ordered input bytes, complete calendars, code and policy, excluding paths and generation metadata", () => {
    const original = identityInput();
    const first = createAdoptedSignalIdentity({
      ...original,
      files: original.files.map((file, index) => ({
        ...file,
        path: `/old/${index}.csv`,
        registeredAt: "2025-01-01T00:00:00Z",
      })),
    });
    const moved = {
      ...original,
      files: original.files.map((file, index) => ({
        ...file,
        path: `/moved/${index}.csv`,
        registeredAt: "2026-10-09T00:00:00Z",
      })),
      createdAt: "2026-10-09T22:00:00Z",
      preparationMs: 54321,
      policy: { etf: ETF_POLICY, kr: { slots: 30 }, context: "CURRENT_RULES_RESEARCH" },
    };
    expect(createAdoptedSignalIdentity(moved)).toEqual(first);
    expect(first).toMatchObject({
      version: SIGNAL_CACHE_VERSION,
      calendarHash: stableSignalHash(fullSessions),
      actualCalendarHash: stableSignalHash(fullSessions),
      codeHash: hash("c"),
    });
    expect(signalCacheHash(Buffer.from("input bytes"))).toBe(hashBytes(Buffer.from("input bytes")));
  });

  it.each([
    [
      "source bytes",
      (input: ReturnType<typeof identityInput>) => {
        input.files[0]!.bytes++;
      },
    ],
    [
      "source content hash",
      (input: ReturnType<typeof identityInput>) => {
        input.files[0]!.sha256 = hash("e");
      },
    ],
    [
      "source file order",
      (input: ReturnType<typeof identityInput>) => {
        input.files.reverse();
      },
    ],
    [
      "warmup calendar",
      (input: ReturnType<typeof identityInput>) => {
        input.sessions = input.sessions.slice(1);
      },
    ],
    [
      "full actual calendar",
      (input: ReturnType<typeof identityInput>) => {
        input.actualSessions = input.actualSessions.slice(0, -1);
      },
    ],
    [
      "extension",
      (input: ReturnType<typeof identityInput>) => {
        input.extension.rows++;
      },
    ],
    [
      "code",
      (input: ReturnType<typeof identityInput>) => {
        input.codeHash = hash("f");
      },
    ],
    [
      "policy",
      (input: ReturnType<typeof identityInput>) => {
        input.policy.kr.slots = 29;
      },
    ],
  ])(
    "changes identity when %s changes outside or inside the selected interval",
    (_name, mutate) => {
      const changed = identityInput();
      mutate(changed);
      expect(createAdoptedSignalIdentity(changed)).not.toEqual(identity());
    },
  );

  it("rejects malformed fingerprints, nonfinite policy and nonchronological calendars", () => {
    expect(() =>
      createAdoptedSignalIdentity({
        ...identityInput(),
        files: [{ bytes: -1, sha256: hash("a") }],
      }),
    ).toThrow();
    expect(() =>
      createAdoptedSignalIdentity({
        ...identityInput(),
        files: [{ bytes: 1, sha256: "not-a-hash" }],
      }),
    ).toThrow();
    expect(() =>
      createAdoptedSignalIdentity({ ...identityInput(), policy: { weight: Number.NaN } }),
    ).toThrow();
    expect(() =>
      createAdoptedSignalIdentity({ ...identityInput(), sessions: [...dates].reverse() }),
    ).toThrow();
    expect(() =>
      createAdoptedSignalIdentity({ ...identityInput(), actualSessions: [dates[0]!, dates[0]!] }),
    ).toThrow();
  });
});

describe("chunked local-only adopted signal transport", () => {
  it("writes gzip chunks, verifies index manifest bytes/hashes and restores chronological selected records", async () => {
    const cache = await cacheFixture();
    for (let i = 0; i < cache.manifests.length; i++) {
      const manifest = cache.manifests[i]!;
      const manifestBytes = await readFile(cache.manifestPaths[i]!);
      expect(cache.index.chunks[i]).toMatchObject({
        bytes: manifestBytes.length,
        sha256: hashBytes(manifestBytes),
      });
      const dataPath = path.resolve(path.dirname(cache.manifestPaths[i]!), manifest.data.path);
      const compressed = await readFile(dataPath);
      expect([...compressed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
      expect(manifest.data).toMatchObject({
        bytes: compressed.length,
        sha256: hashBytes(compressed),
      });
      expect(gunzipSync(compressed).toString()).not.toContain("savedAt");
      expect(manifest.audit.timestampRole).toBe("GENERATION_TIME_ONLY_NOT_MARKET_EVIDENCE");
      expect((await stat(dataPath)).mode & 0o777).toBe(0o600);
    }
    cache.index.chunks.reverse();
    await cache.saveIndex();
    const opened = await cache.open(dates.slice(2, 7));
    expect(opened).toMatchObject({
      chunks: 4,
      availableSessions: dates.length,
      selectedSessions: 5,
      identityHash: stableSignalHash(identity()),
    });
    const restored = await collect(opened);
    expect(restored.map(({ record }) => record)).toEqual(records().slice(2, 7));
    for (const { record, generatedAt } of restored) {
      expect(generatedAt).toBe(
        cache.manifests.find((chunk) => chunk.evaluationDates.includes(record.date))!.audit
          .createdAt,
      );
      expect(generatedAt.slice(0, 10)).not.toBe(record.date);
    }
    const directQuality = signalQualityAccumulator();
    const cachedQuality = signalQualityAccumulator();
    for (const row of records().slice(2, 7)) accumulateSignalQuality(directQuality, row);
    for (const { record } of restored) accumulateSignalQuality(cachedQuality, record);
    expect(cachedQuality).toEqual(directQuality);
  });

  it.each(["manifest bytes", "manifest hash", "data bytes", "data hash"])(
    "rejects altered %s before exposing records",
    async (kind) => {
      const cache = await cacheFixture();
      const file = kind.startsWith("manifest")
        ? cache.manifestPaths[0]!
        : path.resolve(path.dirname(cache.manifestPaths[0]!), cache.manifests[0]!.data.path);
      const bytes = await readFile(file);
      if (kind.endsWith("bytes")) await writeFile(file, Buffer.concat([bytes, Buffer.from(" ")]));
      else {
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
        await writeFile(file, changed);
      }
      await expect(cache.open()).rejects.toThrow(/byte mismatch|SHA mismatch/);
    },
  );

  it("rechecks compressed bytes consumed after preflight rather than trusting a stale hash", async () => {
    const cache = await cacheFixture();
    const opened = await cache.open();
    const changed = records()[0]!;
    changed.counters.scoredEntries++;
    const file = path.resolve(path.dirname(cache.manifestPaths[0]!), cache.manifests[0]!.data.path);
    await writeFile(file, gzipSync(JSON.stringify(changed) + "\n"));
    await expect(collect(opened)).rejects.toThrow(/changed after verification/);
  });

  it("rejects duplicated manifest references and independently written overlapping chunks", async () => {
    const repeated = await cacheFixture();
    repeated.index.chunks.push(repeated.index.chunks[0]!);
    await repeated.saveIndex();
    await expect(repeated.open()).rejects.toThrow(/Duplicate/);
    const overlap = await cacheFixture([
      [0, 4],
      [3, dates.length],
    ]);
    await expect(overlap.open()).rejects.toThrow(/unique|increasing|overlap/i);
  });

  it("rejects interior gaps, off-calendar records and requested sessions absent from the cache", async () => {
    const gap = await cacheFixture([
      [0, 3],
      [4, dates.length],
    ]);
    await expect(gap.open()).rejects.toThrow(/missing|coverage/);
    const offCalendar = await cacheFixture();
    await expect(
      offCalendar.open(dates, { actualSessions: fullSessions.filter((date) => date !== dates[2]) }),
    ).rejects.toThrow(/missing|calendar/);
    const short = await cacheFixture([[1, dates.length]]);
    await expect(short.open()).rejects.toThrow(/completely cover/);
  });

  it("rejects a changed complete calendar even when all cached sessions are unchanged", async () => {
    const cache = await cacheFixture();
    await expect(cache.open(dates, { actualSessions: fullSessions.slice(1) })).rejects.toThrow(
      /calendar/i,
    );
    await expect(cache.open(dates, { actualSessions: fullSessions.slice(0, -1) })).rejects.toThrow(
      /calendar/i,
    );
  });

  it.each(["sourceHash", "calendarHash", "actualCalendarHash", "codeHash", "policyHash"] as const)(
    "rejects a different %s even when every cache file is intact",
    async (key) => {
      const cache = await cacheFixture();
      const changed: AdoptedSignalIdentity = { ...identity(), [key]: hash("f") };
      await expect(cache.open(dates, { identity: changed })).rejects.toThrow(/identity mismatch/);
    },
  );

  it.each(["selection", "count", "identity", "audit"])(
    "rejects resealed manifest %s tampering",
    async (kind) => {
      const cache = await cacheFixture();
      const manifest = cache.manifests[0]!;
      if (kind === "selection") manifest.selectionHash = hash("f");
      if (kind === "count") manifest.records++;
      if (kind === "identity") manifest.identity.codeHash = hash("f");
      if (kind === "audit") manifest.audit.createdAt = "invalid";
      await cache.saveManifest(0);
      await expect(cache.open()).rejects.toThrow(/identity|selection|count|audit/);
    },
  );

  it.each(["missing row", "extra row", "blank row", "malformed JSON"])(
    "rejects resealed %s payloads during iteration",
    async (kind) => {
      const cache = await cacheFixture();
      const line = JSON.stringify(records()[0]);
      const payload =
        kind === "missing row"
          ? ""
          : kind === "extra row"
            ? `${line}\n${line}\n`
            : kind === "blank row"
              ? `${line}\n\n`
              : "{broken JSON\n";
      await cache.replacePayload(0, payload);
      await expect(drain(cache)).rejects.toThrow();
    },
  );

  it("validates malformed future evidence in an earlier unselected chunk, even with all hashes resealed", async () => {
    const cache = await cacheFixture();
    const changed = records()[0]!;
    changed.etfSnapshot.strategies[0]!.strategy.previousDate = dates[1]!;
    await cache.replacePayload(0, JSON.stringify(changed) + "\n");
    const opened = await cache.open(dates.slice(4));
    const exposed: AdoptedSignalRecord[] = [];
    await expect(
      (async () => {
        for await (const { record } of opened.records()) exposed.push(record);
      })(),
    ).rejects.toThrow(/future/);
    expect(exposed).toEqual([]);
  });

  it("also rejects malformed evidence in a later chunk outside the selected interval", async () => {
    const cache = await cacheFixture();
    const changed = records().slice(5);
    changed[2]!.krGate!.marketForeignDates = ["2021-01-04"];
    await cache.replacePayload(3, changed.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await expect(drain(cache, dates.slice(0, 2))).rejects.toThrow(/future/);
  });

  it("rejects a resealed nonfinite JSON number in an unselected earlier signal", async () => {
    const cache = await cacheFixture();
    const payload = JSON.stringify(records()[0]).replace(
      '"annualVolatility":0.3',
      '"annualVolatility":1e999',
    );
    expect(payload).toContain('"annualVolatility":1e999');
    await cache.replacePayload(0, payload + "\n");
    await expect(drain(cache, dates.slice(4))).rejects.toThrow(/finite|invalid/i);
  });

  it.each(["ETF", "KOSPI"])(
    "rejects resealed stale %s strategy versions outside the selection",
    async (market) => {
      const cache = await cacheFixture();
      const changed = records()[0]!;
      if (market === "ETF")
        changed.etfSnapshot.strategies[0]!.strategy.version = "saved-feature-panel";
      else
        Object.assign(changed.krSnapshot.entries[0]!, {
          kospiEntry: { version: "stale-operating-rules", date: changed.date },
        });
      await cache.replacePayload(0, JSON.stringify(changed) + "\n");
      await expect(drain(cache, dates.slice(4))).rejects.toThrow();
    },
  );

  it("never publishes a complete manifest for missing, duplicate or invalid writes and refuses overwrites", async () => {
    for (const invalid of [
      records().slice(0, -1),
      [records()[0]!, records()[0]!],
      [{ ...records()[0]!, date: "2030-01-01" }],
    ]) {
      const out = await tempDir();
      await expect(
        writeAdoptedSignalCache({
          out,
          identity: identity(),
          evaluationDates: dates,
          records: invalid,
        }),
      ).rejects.toThrow();
      await expect(stat(path.join(out, "signal-cache.manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const out = await tempDir();
    await writeAdoptedSignalCache({
      out,
      identity: identity(),
      evaluationDates: dates,
      records: records(),
    });
    const before = await readFile(path.join(out, "signal-cache.jsonl.gz"));
    await expect(
      writeAdoptedSignalCache({
        out,
        identity: identity(),
        evaluationDates: dates,
        records: records(),
      }),
    ).rejects.toThrow();
    expect(await readFile(path.join(out, "signal-cache.jsonl.gz"))).toEqual(before);
  });
});

describe("cached signal evidence validation", () => {
  it.each([
    [
      "snapshot date",
      (row: AdoptedSignalRecord) => {
        row.krSnapshot.asOfDate = dates[1]!;
      },
    ],
    [
      "ETF date",
      (row: AdoptedSignalRecord) => {
        row.etfSnapshot.strategies[0]!.strategy.date = dates[1]!;
      },
    ],
    [
      "invalid previous date",
      (row: AdoptedSignalRecord) => {
        row.etfSnapshot.strategies[0]!.strategy.previousDate = "2019-02-30";
      },
    ],
    [
      "numeric nested origin date",
      (row: AdoptedSignalRecord) => {
        Object.assign(row.etfSnapshot.strategies[0]!.strategy, { originDate: 20191226 });
      },
    ],
    [
      "boolean gate evidence date",
      (row: AdoptedSignalRecord) => {
        Object.assign(row.krGate!, { marketForeignDates: [true] });
      },
    ],
    [
      "nonfinite signal score",
      (row: AdoptedSignalRecord) => {
        row.etfSnapshot.strategies[0]!.strategy.score = Number.POSITIVE_INFINITY;
      },
    ],
    [
      "stale ETF strategy version",
      (row: AdoptedSignalRecord) => {
        row.etfSnapshot.strategies[0]!.strategy.version = "saved-feature-panel";
      },
    ],
    [
      "stale KOSPI entry version",
      (row: AdoptedSignalRecord) => {
        Object.assign(row.krSnapshot.entries[0]!, {
          kospiEntry: { version: "stale-operating-rules", date: row.date },
        });
      },
    ],
    [
      "future previous date",
      (row: AdoptedSignalRecord) => {
        row.etfSnapshot.strategies[0]!.strategy.previousDate = dates[1]!;
      },
    ],
    [
      "future gate evidence",
      (row: AdoptedSignalRecord) => {
        row.krGate!.benchmarkDate = dates[1]!;
      },
    ],
    [
      "future evidence array",
      (row: AdoptedSignalRecord) => {
        row.krGate!.marketForeignDates = [dates[1]!];
      },
    ],
    [
      "duplicate stock",
      (row: AdoptedSignalRecord) => {
        row.krSnapshot.entries.push(row.krSnapshot.entries[0]!);
      },
    ],
    [
      "duplicate ETF",
      (row: AdoptedSignalRecord) => {
        row.etfSnapshot.strategies.push(row.etfSnapshot.strategies[0]!);
      },
    ],
    [
      "ETF in stock payload",
      (row: AdoptedSignalRecord) => {
        row.krSnapshot.entries[0]!.instrumentType = "ETF";
      },
    ],
    [
      "negative counter",
      (row: AdoptedSignalRecord) => {
        row.counters.scoredEntries = -1;
      },
    ],
    [
      "fractional counter",
      (row: AdoptedSignalRecord) => {
        row.counters.validScores.ETF = 0.5;
      },
    ],
    [
      "nonfinite counter",
      (row: AdoptedSignalRecord) => {
        row.counters.entryReady.KOSPI = Number.NaN;
      },
    ],
    [
      "multiple daily gates",
      (row: AdoptedSignalRecord) => {
        row.counters.incompleteKospiGateSessions = 2;
      },
    ],
    ...["savedAt", "storedAt", "sourceRegisteredAt"].map(
      (key) =>
        [
          key,
          (row: AdoptedSignalRecord) => {
            Object.assign(row.krSnapshot, { [key]: "2026-10-09T00:00:00Z" });
          },
        ] as const,
    ),
  ] as const)("rejects %s", (_name, mutate) => {
    const row = records()[0]!;
    mutate(row);
    expect(() => assertAdoptedSignalRecord(row, dates[0]!)).toThrow();
  });
});

describe("one continuous economic replay from concatenated signal chunks", () => {
  it("preserves KR trades, exact cash/fees, daily NAV, annual budgets and carried old-year intent", async () => {
    const cache = await cacheFixture();
    // Deliberately unrelated generation dates must not change historical decision or execution dates.
    for (let i = 0; i < cache.manifests.length; i++) {
      cache.manifests[i]!.audit.createdAt = `2026-10-${String(12 - i).padStart(2, "0")}T22:00:00Z`;
      await cache.saveManifest(i);
    }
    const restored = await drain(cache);
    const monolithic = runAdoptedKrBacktest(
      krInput(records().map((record) => ({ record, generatedAt: `${record.date}T12:00:00Z` }))),
    );
    // Only one executor call for all chunks: account state is never reset at a cache boundary.
    const cached = runAdoptedKrBacktest(krInput(restored));
    expect(cached.trades).toEqual(monolithic.trades);
    expect(cached.dailyNAV).toEqual(monolithic.dailyNAV);
    expect(cached.yearlyBudgets).toEqual(monolithic.yearlyBudgets);
    expect(cached.ledger.modelAccounting).toEqual(monolithic.ledger.modelAccounting);
    expect(cached.ledger.candidates).toEqual(monolithic.ledger.candidates);
    expect(cached.evidence).toEqual(monolithic.evidence);
    expect(cached.trades).toHaveLength(3);
    expect(cached.trades.find((trade) => trade.symbol === "A")).toMatchObject({
      entryDate: dates[1],
      exitDate: dates[7],
    });
    expect(cached.trades.find((trade) => trade.symbol === "B")).toMatchObject({
      signalDate: dates[3],
      entryDate: dates[5],
      shares: 33283,
      targetAmount: Number(cached.yearlyBudgets[0]!.budget),
    });
    expect(cached.yearlyBudgets[1]).toMatchObject({
      year: 2020,
      valuationDate: dates[3],
      effectiveDate: dates[4],
      nav: cached.dailyNAV[3]!.nav,
    });
    expect(cached.yearlyBudgets[1]!.budget).not.toBe(cached.yearlyBudgets[0]!.budget);
    expect(cached.trades.find((trade) => trade.symbol === "C")!.targetAmount).toBe(
      Number(cached.yearlyBudgets[1]!.budget),
    );
    expect(
      cached.ledger.candidates.find((candidate) => candidate.symbol === "D")!.entryDate,
    ).toBeNull();
    expect(cached.trades.every((trade) => trade.entryFee > 0)).toBe(true);
    expect(cached.trades.find((trade) => trade.symbol === "A")!.exitFee).toBeGreaterThan(0);
  });

  it("preserves every ETF economic record, pending confirmations/entries, fees and annual signal-year budgets", async () => {
    const cache = await cacheFixture();
    const opened = await cache.open();
    async function* cachedSnapshots() {
      for await (const { record } of opened.records()) yield record.etfSnapshot;
    }
    const monolithic = await runAdoptedEtfBacktest(
      etfInput(records().map((row) => row.etfSnapshot)),
    );
    // The same continuous executor receives a lazy stream crossing all four gzip chunks.
    const cached = await runAdoptedEtfBacktest(etfInput(cachedSnapshots()));
    expect(cached).toEqual(monolithic);
    expect(cached.fills).toHaveLength(4);
    expect(
      cached.fills.find((fill) => fill.symbol === etfSymbols[0] && fill.side === "BUY"),
    ).toMatchObject({
      originDate: dates[0],
      signalDate: dates[1],
      executionDate: dates[2],
      quantity: "499",
      fee: "7485",
    });
    expect(cached.records![0]!.pendingConfirmations).toHaveLength(1);
    expect(cached.records![3]!.pendingEntries).toHaveLength(1);
    expect(cached.records![4]!.pendingEntries).toHaveLength(1);
    const years = cached.finalState.researchYearAssetBases!;
    expect(years).toHaveLength(2);
    expect(years[1]).toMatchObject({
      year: 2020,
      valuationDate: dates[3],
      effectiveDate: dates[4],
      nav: cached.dailyNav[3]!.nav,
    });
    expect(
      cached.fills.find((fill) => fill.symbol === etfSymbols[1] && fill.side === "BUY"),
    ).toMatchObject({
      signalDate: dates[3],
      executionDate: dates[5],
      targetBudget: "5000000",
      budgetNavDate: null,
    });
    expect(
      cached.fills.find((fill) => fill.symbol === etfSymbols[2] && fill.side === "BUY"),
    ).toMatchObject({
      targetBudget: format(multiply(decimal(years[1]!.nav), decimal("0.1"))),
      budgetNavDate: dates[3],
      executionDate: dates[6],
    });
    expect(cached.fills.find((fill) => fill.side === "SELL")).toMatchObject({
      symbol: etfSymbols[0],
      signalDate: dates[6],
      executionDate: dates[7],
      reason: "MA60",
    });
    expect(cached.pending.pendingEntries).toHaveLength(1);
    expect(cached.pending.pendingEntries[0]!.symbol).toBe(etfSymbols[3]);
    expect(cached.dailyNav[2]).toMatchObject({ cash: "95002515", fees: "7485" });
    expect(cached.fills.every((fill) => decimal(fill.fee) > 0n)).toBe(true);
    expect(cached.finalState.positions).toHaveLength(2);
  });
});
