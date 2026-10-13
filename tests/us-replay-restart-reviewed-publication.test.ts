import { describe, expect, it } from "vitest";
import { runUsGapReplay } from "../scripts/run-us-gap-replay";
import { bytesHash, type UsReplaySessionSource } from "../scripts/us-replay-source";
import { stableJson, type trustedSupabaseClient } from "../scripts/analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
import { freezeRestartSeries, guardModelRun, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { sourceCsv, reviewedSourceCsv } from "./us-replay-fixtures";
import { hash, usRun } from "./october-shadow-fixtures";
import { createImmutableArchiveFixture } from "./immutable-archive-fixture";

const uid = "11111111-1111-4111-8111-111111111111";

async function setup(day = "2026-10-12", baseDate = "2026-10-09", extraSymbol = false) {
  const extraRow = sourceCsv(day).trimEnd().split("\n")[2]!.replaceAll("TEST", "NEXT");
  const original = sourceCsv(day) + (extraSymbol ? extraRow + "\n" : ""),
    corrected = reviewedSourceCsv(day) + (extraSymbol ? extraRow + ",\n" : "");
  const originalHash = bytesHash(original),
    capture = `${day}T21:00:00Z`;
  const rawPath = `${uid}/source/us-screening/${day}/original.csv`;
  const correctedPath = `${uid}/source/us-screening/${day}/reviewed.csv`;
  const rosterPath = `${uid}/source/us-screening/${day}/roster.json`;
  const roster = stableJson({
    version: "us-dated-roster-v1",
    asOfDate: day,
    capturedAt: capture,
    rows: parseUsProspectiveCsv(original),
  });
  const previousAnalysis = runUsProspectiveAnalysis(parseUsProspectiveCsv(sourceCsv(baseDate)));
  const analysis = runUsProspectiveAnalysis(
    parseUsProspectiveCsv(original),
    day === "2026-10-12" ? undefined : previousAnalysis.state,
  );
  const result = stableJson({ dataHash: originalHash, analysis });
  const resultPath = `${uid}/results/us-screening/${day}.json`;
  const files = new Map<string, string | Buffer>([
    [rawPath, original],
    [correctedPath, corrected],
    [rosterPath, roster],
    [resultPath, result],
    [`${uid}/cache/us-screening/latest.json`, result],
  ]);
  const histories = [
    { date: day, data_hash: originalHash, rule_version: US_PROSPECTIVE_RULE_VERSION },
  ];
  if (day !== "2026-10-12") {
    files.set(
      `${uid}/results/us-screening/${baseDate}.json`,
      stableJson({ dataHash: bytesHash(sourceCsv(baseDate)), analysis: previousAnalysis }),
    );
    histories.unshift({
      date: baseDate,
      data_hash: bytesHash(sourceCsv(baseDate)),
      rule_version: US_PROSPECTIVE_RULE_VERSION,
    });
  }
  const series = await Promise.all(
    (["US_A0", "US_A2", "US_B3"] as const).map((kind) =>
      freezeRestartSeries({
        kind,
        frozenAt: "2026-10-09T12:00:00Z",
        codeHash: hash("a"),
        sourceHash: hash("b"),
      }),
    ),
  );
  const seriesReadOverrides = new Map<string, (typeof series)[number]>();
  const sessions = new Map<string, Awaited<ReturnType<typeof usRun>>>();
  for (const s of series) {
    const run = structuredClone(await usRun(s, day));
    const publicationSourceHash = await hashSeriesValue({
      version: "us-shadow-dated-input-v1",
      date: day,
      rows: parseUsProspectiveCsv(original).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    });
    run.publication.sourceHash = publicationSourceHash;
    run.receipt = (
      await guardModelRun(s, {
        date: day,
        codeHash: s.codeHash,
        configHash: s.configHash,
        sourceHash: publicationSourceHash,
      })
    ).receipt;
    run.calendar.coverageEnd = day;
    run.calendar.regularSessions.push("2026-10-12");
    if (day !== "2026-10-12") run.calendar.regularSessions.push(day);
    const { stateHash: _, ...body } = run;
    run.stateHash = await hashSeriesValue(body);
    sessions.set(`${s.bookId}:${day}`, run);
  }
  const ingest = {
    as_of_date: day,
    data_hash: originalHash,
    storage_bucket: "cloudtrend-data",
    storage_path: rawPath,
    row_count: extraSymbol ? 3 : 2,
    symbol_count: extraSymbol ? 3 : 2,
    source_provider: "fixture",
    schema_version: "us-prospective-v1",
  };
  const reads: string[] = [],
    writes: string[] = [],
    rpcCalls: string[] = [];
  let failPath: string | null = null;
  const archive = createImmutableArchiveFixture();
  const c = {
    from(table: string) {
      reads.push(table);
      if (table === "screening_run_archive") return archive();
      if (
        ![
          "us_screening_history",
          "us_screening_ingest",
          "ledger_model_series",
          "ledger_model_sessions",
        ].includes(table)
      )
        throw new Error(`Forbidden legacy/model table: ${table}`);
      const filters = new Map<string, unknown>();
      const data = () =>
        table === "us_screening_history"
          ? histories.filter(
              (h) =>
                (!filters.has("date") || h.date === filters.get("date")) &&
                (!filters.has("gte:date") || h.date >= String(filters.get("gte:date"))) &&
                (!filters.has("lte:date") || h.date <= String(filters.get("lte:date"))),
            )
          : table === "us_screening_ingest"
            ? ingest
            : table === "ledger_model_series"
              ? (() => {
                  const payload =
                    seriesReadOverrides.get(String(filters.get("series_id"))) ??
                    series.find((s) => s.bookId === filters.get("series_id"));
                  return payload ? { payload } : null;
                })()
              : (() => {
                  const payload = sessions.get(
                    `${filters.get("series_id")}:${filters.get("session_date")}`,
                  );
                  return payload ? { payload } : null;
                })();
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          filters.set(key, value);
          return q;
        },
        gte: (key: string, value: unknown) => {
          filters.set(`gte:${key}`, value);
          return q;
        },
        lte: (key: string, value: unknown) => {
          filters.set(`lte:${key}`, value);
          return q;
        },
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: Array.isArray(data()) ? ((data() as unknown[])[0] ?? null) : data(),
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: data(), error: null }).then(resolve),
      };
      return q;
    },
    async rpc(name: string) {
      rpcCalls.push(name);
      throw new Error(`Forbidden RPC: ${name}`);
    },
    storage: {
      from: () => ({
        async download(path: string) {
          reads.push(path);
          return files.has(path)
            ? { data: { text: async () => files.get(path)!.toString() }, error: null }
            : { data: null, error: { message: "404 Object not found" } };
        },
        async upload(path: string, body: string | Buffer, options: { upsert: boolean }) {
          writes.push(path);
          if (path === failPath) {
            failPath = null;
            return { error: { message: "interrupted browser publish" } };
          }
          if (!options.upsert && files.has(path)) return { error: { message: "Already exists" } };
          files.set(path, body);
          return { error: null };
        },
      }),
    },
  };
  const source: UsReplaySessionSource = {
    date: day,
    previousSessionDate: baseDate,
    storagePath: correctedPath,
    dataHash: bytesHash(corrected),
    rowCount: extraSymbol ? 3 : 2,
    symbolCount: extraSymbol ? 3 : 2,
    sourceCapturedAt: capture,
    confirmedRegularClose: true,
    failedSymbols: 0,
    sourceCoverageComplete: false,
    quarantinedSymbols: ["TEST"],
    originalSource: { storagePath: rawPath, dataHash: originalHash, sourceCapturedAt: capture },
    lifecycleQuarantines: [
      {
        symbol: "TEST",
        effectiveDate: day,
        evidenceUrls: ["https://www.nasdaqtrader.com/fixture"],
      },
    ],
    pit: {
      kind: "REVIEWED_ATOMIC_QUARANTINE",
      asOfDate: day,
      rosterCapturedAt: capture,
      rosterStoragePath: rosterPath,
      rosterHash: bytesHash(roster),
    },
  };
  const manifest = {
    version: "us-dated-replay-v1",
    baseDate,
    throughDate: day,
    sessions: [source],
  };
  const manifestBytes = stableJson(manifest),
    manifestHash = bytesHash(manifestBytes);
  const manifestPath = `${uid}/source/${manifestHash.slice(7)}.json`;
  files.set(manifestPath, manifestBytes);
  const input = {
    client: c as unknown as ReturnType<typeof trustedSupabaseClient>,
    userId: uid,
    manifestPath,
    manifestHash,
    apply: true,
    publishDailyScreen: true,
    calculatedAt: `${day}T22:00:00Z`,
  };
  const receiptPath = `${uid}/results/us-gap-replay/${manifestHash.slice(7)}/daily-publication-receipt.json`;
  return {
    input,
    files,
    reads,
    writes,
    rpcCalls,
    histories,
    series,
    sessions,
    seriesReadOverrides,
    originalHash,
    resultPath,
    receiptPath,
    source,
    previousAnalysis,
    failNext: (path: string) => {
      failPath = path;
    },
  };
}

function assertNoModelWrites(f: Awaited<ReturnType<typeof setup>>) {
  expect(f.rpcCalls).toEqual([]);
  expect(
    f.reads.some((p) => /us_operating_|us_prospective_|\/results\/shadow-replay\//.test(p)),
  ).toBe(false);
  expect(
    f.writes.every(
      (p) =>
        p.includes("/results/us-recovered-screening/") ||
        p.includes("/cache/us-screening/") ||
        p.includes("/results/us-gap-replay/"),
    ),
  ).toBe(true);
  expect(
    f.writes.some((p) => /\/results\/us-replay-state\/|\/receipt\.json$|\/plan\.json$/.test(p)),
  ).toBe(false);
}

describe("restart reviewed lifecycle publication remains presentation-only", () => {
  it("rejects a newer latest cache before publication writes", async () => {
    const f = await setup();
    f.files.set(
      `${uid}/cache/us-screening/latest.json`,
      stableJson({ analysis: { date: "2026-10-13" } }),
    );
    await expect(runUsGapReplay(f.input)).rejects.toThrow("newer latest cache");
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });
  it("blocks an older manifest retry after a newer same-day lifecycle correction", async () => {
    const f = await setup("2026-10-12", "2026-10-09", true);
    await runUsGapReplay(f.input);
    const source = structuredClone(f.source);
    const extraRow = reviewedSourceCsv("2026-10-12")
      .trimEnd()
      .split("\n")[2]!
      .replaceAll("TEST", "NEXT");
    const corrected = reviewedSourceCsv("2026-10-12") + extraRow + "\n";
    source.storagePath = `${uid}/source/us-screening/2026-10-12/reviewed-expanded.csv`;
    source.dataHash = bytesHash(corrected);
    source.quarantinedSymbols.push("NEXT");
    source.lifecycleQuarantines!.push({ ...source.lifecycleQuarantines![0]!, symbol: "NEXT" });
    f.files.set(source.storagePath, corrected);
    const body = stableJson({
      version: "us-dated-replay-v1",
      baseDate: "2026-10-09",
      throughDate: "2026-10-12",
      sessions: [source],
    });
    const manifestPath = `${uid}/source/expanded.json`,
      manifestHash = bytesHash(body);
    f.files.set(manifestPath, body);
    await runUsGapReplay({
      ...f.input,
      manifestPath,
      manifestHash,
      calculatedAt: "2026-10-12T23:00:00Z",
    });
    const before = [...f.files],
      count = f.writes.length;
    await expect(runUsGapReplay(f.input)).rejects.toThrow("publication conflict");
    expect([...f.files]).toEqual(before);
    expect(f.writes).toHaveLength(count);
    assertNoModelWrites(f);
  });
  it("rejects a tampered saved publication plan before retry writes", async () => {
    const f = await setup();
    await runUsGapReplay(f.input);
    const path = f.receiptPath.replace(
      "daily-publication-receipt.json",
      "reviewed-publication-plan.json",
    );
    const plan = JSON.parse(f.files.get(path)!.toString());
    plan.analysis.state.coreRanks.TAMPERED = 1;
    f.files.set(path, stableJson(plan));
    const count = f.writes.length;
    await expect(runUsGapReplay(f.input)).rejects.toThrow("immutable publication plan changed");
    expect(f.writes).toHaveLength(count);
    assertNoModelWrites(f);
  });
  it("binds approval to the complete predecessor identity even when calculations are unchanged", async () => {
    const f = await setup("2026-10-13", "2026-10-12");
    const proof = await runUsGapReplay({ ...f.input, apply: false, publishDailyScreen: false });
    const path = `${uid}/results/us-screening/2026-10-12.json`;
    const previous = JSON.parse(f.files.get(path)!.toString());
    previous.generatedAt = "2026-10-12T22:01:00Z";
    f.files.set(path, stableJson(previous));
    await expect(
      runUsGapReplay({ ...f.input, expectedOperatingPlanHash: proof.operatingPlanHash }),
    ).rejects.toThrow("expected identity");
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });
  it("rejects an original screening state inconsistent with its source and predecessor", async () => {
    const f = await setup("2026-10-13", "2026-10-12");
    const original = JSON.parse(f.files.get(f.resultPath)!.toString());
    original.analysis.state.coreRanks.TEST = -1;
    f.files.set(f.resultPath, stableJson(original));
    await expect(runUsGapReplay(f.input)).rejects.toThrow(
      "rank state does not match its predecessor",
    );
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });

  it("publishes and retries the opening session using reset ranks, without touching original models", async () => {
    const f = await setup(),
      original = f.files.get(f.resultPath),
      sessions = stableJson([...f.sessions]);
    expect(await runUsGapReplay(f.input)).toMatchObject({
      mode: "PUBLICATION_ONLY",
      screeningPublished: true,
      originalModelsPreserved: true,
    });
    const receipt = f.files.get(f.receiptPath);
    expect(JSON.parse(receipt!.toString())).toMatchObject({
      version: "us-daily-publication-receipt-v1",
      screeningPublished: true,
      dataHash: f.source.dataHash,
    });
    await runUsGapReplay({ ...f.input, calculatedAt: "2026-10-13T01:00:00Z" });
    expect(f.files.get(f.receiptPath)).toBe(receipt);
    expect(f.files.get(f.resultPath)).toBe(original);
    expect(stableJson([...f.sessions])).toBe(sessions);
    const displayed = JSON.parse(f.files.get(`${uid}/cache/us-screening/latest.json`)!.toString());
    const plan = JSON.parse(
      f.files
        .get(
          f.receiptPath.replace("daily-publication-receipt.json", "reviewed-publication-plan.json"),
        )!
        .toString(),
    );
    expect(plan.analysis.state).toEqual(
      runUsProspectiveAnalysis(parseUsProspectiveCsv(reviewedSourceCsv("2026-10-12"))).state,
    );
    expect(
      displayed.analysis.rows.find((r: { symbol: string }) => r.symbol === "TEST"),
    ).toMatchObject({ status: "SUSPENDED", close: null, a0Entry: false });
    expect(
      plan.analysis.rows.every(
        (row: { previousCoreDate: string | null }) => row.previousCoreDate === null,
      ),
    ).toBe(true);
    expect(f.reads.some((p) => p.includes("2026-10-09.json"))).toBe(false);
    assertNoModelWrites(f);
  });
  it("rejects a valid registry payload returned under the wrong book identity", async () => {
    const f = await setup();
    f.seriesReadOverrides.set(f.series[1]!.bookId, f.series[0]!);
    await expect(runUsGapReplay(f.input)).rejects.toThrow("registry identity mismatch");
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });
  it("verifies dry-run proof without writing any artifact or model", async () => {
    const f = await setup();
    expect(
      await runUsGapReplay({ ...f.input, apply: false, publishDailyScreen: false }),
    ).toMatchObject({ mode: "READ_ONLY", applied: false, screeningPublished: false });
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });
  it("rejects a mismatched expected completion proof before writes", async () => {
    const f = await setup();
    await expect(
      runUsGapReplay({ ...f.input, expectedOperatingPlanHash: hash("f") }),
    ).rejects.toThrow("expected identity");
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });
  it("does not create a success receipt if browser publication is interrupted, and safely retries", async () => {
    const f = await setup();
    f.failNext(`${uid}/cache/us-screening/view-v1.json.gz`);
    await expect(runUsGapReplay(f.input)).rejects.toEqual({
      message: "interrupted browser publish",
    });
    expect(f.files.has(f.receiptPath)).toBe(false);
    expect(await runUsGapReplay(f.input)).toMatchObject({
      mode: "PUBLICATION_ONLY",
      screeningPublished: true,
    });
    expect(f.files.has(f.receiptPath)).toBe(true);
    assertNoModelWrites(f);
  });
  it.each([
    "missing history",
    "wrong history hash",
    "missing original",
    "corrupt original",
    "missing raw source",
    "missing series",
    "missing session",
    "wrong publication source",
    "tampered state",
  ])("fails closed for %s before all publication writes", async (kind) => {
    const f = await setup();
    if (kind === "missing history") f.histories.splice(0);
    if (kind === "wrong history hash") f.histories[0]!.data_hash = bytesHash("wrong source");
    if (kind === "missing raw source") f.files.delete(f.source.originalSource!.storagePath);
    if (kind === "missing original") f.files.delete(f.resultPath);
    if (kind === "corrupt original") f.files.set(f.resultPath, "{}");
    if (kind === "missing series") f.series.pop();
    if (kind === "missing session") f.sessions.delete([...f.sessions.keys()][2]!);
    if (kind === "tampered state") f.sessions.values().next().value!.result.cash = 1;
    if (kind === "wrong publication source") {
      const run = f.sessions.values().next().value!;
      run.publication.sourceHash = hash("f");
      const { stateHash: _, ...body } = run;
      run.stateHash = await hashSeriesValue(body);
    }
    await expect(runUsGapReplay(f.input)).rejects.toBeDefined();
    expect(f.writes).toEqual([]);
    expect(f.files.has(f.receiptPath)).toBe(false);
    assertNoModelWrites(f);
  });
  it("continues later sessions from the verified original predecessor rank state", async () => {
    const f = await setup("2026-10-13", "2026-10-12");
    expect(await runUsGapReplay(f.input)).toMatchObject({
      mode: "PUBLICATION_ONLY",
      screeningPublished: true,
    });
    const displayed = JSON.parse(f.files.get(`${uid}/cache/us-screening/latest.json`)!.toString());
    const plan = JSON.parse(
      f.files
        .get(
          f.receiptPath.replace("daily-publication-receipt.json", "reviewed-publication-plan.json"),
        )!
        .toString(),
    );
    expect(plan.analysis.state).toEqual(
      runUsProspectiveAnalysis(
        parseUsProspectiveCsv(reviewedSourceCsv("2026-10-13")),
        f.previousAnalysis.state,
      ).state,
    );
    expect(
      plan.analysis.rows.every(
        (row: { previousCoreDate: string }) => row.previousCoreDate === "2026-10-12",
      ),
    ).toBe(true);
    expect(
      displayed.analysis.rows.find((row: { symbol: string }) => row.symbol === "TEST")
        .previousCoreRank,
    ).toBe(f.previousAnalysis.state.coreRanks!.TEST);
    assertNoModelWrites(f);
  });
  it("rejects a later session without verified original predecessor state", async () => {
    const f = await setup("2026-10-13", "2026-10-12");
    f.histories.splice(0, 1);
    f.files.delete(`${uid}/results/us-screening/2026-10-12.json`);
    await expect(runUsGapReplay(f.input)).rejects.toBeDefined();
    expect(f.writes).toEqual([]);
    assertNoModelWrites(f);
  });
});
