import { describe, expect, it } from "vitest";
import { runUsGapReplay } from "../scripts/run-us-gap-replay";
import {
  loadPublishedUsRecoveryView,
  publishUsRecoveryViews,
} from "../scripts/us-recovery-publication";
import { bytesHash, type UsReplaySessionSource } from "../scripts/us-replay-source";
import { stableJson, type trustedSupabaseClient } from "../scripts/analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
import { runUsScreening } from "../scripts/run-us-screening";
import { sourceCsv } from "./us-replay-fixtures";
import { createImmutableArchiveFixture } from "./immutable-archive-fixture";

const uid = "11111111-1111-4111-8111-111111111111";
const day = "2026-10-09",
  baseDate = "2026-10-08";
const legacyPath = `${uid}/results/us-recovered-screening/${day}.json`;
const pointerPath = `${uid}/results/us-recovered-screening/${day}/latest.json`;
const cachePath = `${uid}/cache/us-screening/latest.json`;
function csv(
  excluded: string[] = [],
  date = day,
  extraSymbols: string[] = [],
  heldSymbols: string[] = [],
) {
  const rows = sourceCsv(date)
    .trimEnd()
    .split("\n")
    .map((r) => r.split(","));
  rows.push([...rows[2]!]);
  rows[2]![1] = rows[2]![2] = "WBD";
  rows[3]![1] = rows[3]![2] = "DBRG";
  for (const symbol of extraSymbols) {
    const row = [...rows[3]!];
    row[1] = row[2] = symbol;
    rows.push(row);
  }
  rows[0]!.push("status");
  for (const row of rows.slice(1)) {
    row.push("");
    if (!excluded.includes(row[1]!) && !heldSymbols.includes(row[1]!)) continue;
    for (const key of [
      "open",
      "high",
      "low",
      "close",
      "volume",
      "ret120",
      "ret252",
      "beta60_spy",
      "ichimoku_tk_gap",
      "relvol1_20",
      "adv20_usd",
      "amihud20",
    ])
      row[rows[0]!.indexOf(key)] = "";
    for (const key of ["active20", "toss_tradable"]) row[rows[0]!.indexOf(key)] = "false";
    if (excluded.includes(row[1]!)) row[rows[0]!.indexOf("status")] = "SUSPENDED";
  }
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}
function setup(extraSymbols: string[] = [], heldSymbols: string[] = []) {
  const makeCsv = (excluded: string[] = [], date = day) =>
    csv(excluded, date, extraSymbols, heldSymbols);
  const raw = makeCsv(),
    originalHash = bytesHash(raw);
  const base = runUsProspectiveAnalysis(parseUsProspectiveCsv(makeCsv([], baseDate)), {
    lastDate: "2026-10-07",
    coreRanks: { WBD: 0.1, DBRG: 0.1 },
    betaWeakStreak: {},
  });
  const originalAnalysis = runUsProspectiveAnalysis(parseUsProspectiveCsv(raw), base.state);
  const originalResult = stableJson({ dataHash: originalHash, analysis: originalAnalysis });
  const rawPath = `${uid}/source/us-screening/${day}/original.csv`;
  const rosterPath = `${uid}/source/us-screening/${day}/roster.json`;
  const capture = `${day}T21:00:00Z`;
  const roster = stableJson({
    version: "us-dated-roster-v1",
    asOfDate: day,
    capturedAt: capture,
    rows: parseUsProspectiveCsv(raw),
  });
  const files = new Map<string, string | Buffer>([
    [rawPath, raw],
    [rosterPath, roster],
    [`${uid}/results/us-replay-state/${baseDate}.json`, stableJson({ analysis: base })],
    [`${uid}/results/us-screening/${day}.json`, originalResult],
    [cachePath, originalResult],
  ]);
  const history = { date: day, data_hash: originalHash, rule_version: US_PROSPECTIVE_RULE_VERSION };
  const ingest = {
    as_of_date: day,
    data_hash: originalHash,
    storage_bucket: "cloudtrend-data",
    storage_path: rawPath,
    row_count: 3 + extraSymbols.length,
    symbol_count: 3 + extraSymbols.length,
    source_provider: "fixture",
    schema_version: "us-prospective-v1",
  };
  const plan = {
    version: "us-operating-replay-v1",
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    planHash: bytesHash("completed-original-model"),
    baseDate,
    throughDate: day,
    dates: [{ date: day, previousSessionDate: baseDate, sourceHash: originalHash }],
  };
  const completed = {
    plan_hash: plan.planHash,
    base_date: baseDate,
    through_date: day,
    plan,
    receipt: {
      version: plan.version,
      planHash: plan.planHash,
      baseDate,
      throughDate: day,
      committedAt: "2026-10-10T01:00:00Z",
    },
  };
  const reads: string[] = [],
    writes: string[] = [],
    rpcCalls: unknown[] = [];
  let failPath: string | null = null;
  const archive = createImmutableArchiveFixture();
  const c = {
    from(table: string) {
      if (table === "screening_run_archive") return archive();
      reads.push(table);
      if (!["us_screening_history", "us_screening_ingest", "us_operating_replays"].includes(table))
        throw new Error(`Model table access forbidden: ${table}`);
      const data =
        table === "us_screening_history"
          ? history
          : table === "us_screening_ingest"
            ? ingest
            : completed;
      const q = {
        select: () => q,
        eq: () => q,
        gte: () => q,
        lte: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [data], error: null }).then(resolve),
      };
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      expect(name).toBe("apply_us_operating_replay");
      expect(args.p_apply).toBe(false);
      expect(args.p_plan).toEqual(plan);
      rpcCalls.push(args);
      return { data: { validated: true, alreadyApplied: true }, error: null };
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
  const client = c as unknown as ReturnType<typeof trustedSupabaseClient>;
  const identity = { date: day, dataHash: originalHash, ruleVersion: US_PROSPECTIVE_RULE_VERSION };
  function source(excluded: string[]): UsReplaySessionSource {
    const body = makeCsv(excluded),
      dataHash = bytesHash(body),
      path = `${uid}/source/${dataHash.slice(7)}.csv`;
    files.set(path, body);
    return {
      date: day,
      previousSessionDate: baseDate,
      storagePath: path,
      dataHash,
      rowCount: 3 + extraSymbols.length,
      symbolCount: 3 + extraSymbols.length,
      sourceCapturedAt: capture,
      confirmedRegularClose: true,
      failedSymbols: 0,
      sourceCoverageComplete: false,
      quarantinedSymbols: [...new Set([...heldSymbols, ...excluded])],
      originalSource: { storagePath: rawPath, dataHash: originalHash, sourceCapturedAt: capture },
      lifecycleQuarantines: excluded.map((symbol) => ({
        symbol,
        effectiveDate: day,
        evidenceUrls: ["https://www.nasdaqtrader.com/fixture"],
      })),
      pit: {
        kind: "REVIEWED_ATOMIC_QUARANTINE",
        asOfDate: day,
        rosterCapturedAt: capture,
        rosterStoragePath: rosterPath,
        rosterHash: bytesHash(roster),
      },
    };
  }
  function input(excluded: string[], generatedAt = "2026-10-12T02:00:00Z") {
    const s = source(excluded),
      body = stableJson({
        version: "us-dated-replay-v1",
        baseDate,
        throughDate: day,
        sessions: [s],
      });
    const manifestHash = bytesHash(body),
      manifestPath = `${uid}/source/${manifestHash.slice(7)}.json`;
    files.set(manifestPath, body);
    return {
      client,
      userId: uid,
      manifestPath,
      manifestHash,
      apply: true,
      publishDailyScreen: true,
      calculatedAt: generatedAt,
    };
  }
  function publication(excluded: string[], generatedAt = "2026-10-12T02:00:00Z") {
    return {
      client,
      userId: uid,
      source: source(excluded),
      analysis: runUsProspectiveAnalysis(parseUsProspectiveCsv(makeCsv(excluded)), base.state),
      manifestHash: bytesHash(excluded.join(",")),
      operatingPlanHash: plan.planHash,
      generatedAt,
      protectedOriginal: { ...history, resultHash: bytesHash(originalResult) },
    };
  }
  return {
    files,
    reads,
    writes,
    rpcCalls,
    ingest,
    history,
    identity,
    client,
    input,
    source,
    publication,
    originalResult,
    base,
    failNext: (path: string) => {
      failPath = path;
    },
    async publishWbd() {
      return publishUsRecoveryViews(publication(["WBD"], "2026-10-10T02:00:00Z"));
    },
  };
}

describe("reviewed same-day publication end to end", () => {
  it("preserves a WBD legacy view while refreshing DBRG+WBD and retrying without any model mutation", async () => {
    const f = setup();
    await f.publishWbd();
    const oldBytes = f.files.get(legacyPath),
      originalBytes = f.files.get(`${uid}/results/us-screening/${day}.json`);
    const baseBytes = f.files.get(`${uid}/results/us-replay-state/${baseDate}.json`);
    const rawBefore = [...f.files].filter(([p]) => p.includes("/source/us-screening/"));
    const input = f.input(["WBD", "DBRG"]);
    f.failNext(`${uid}/cache/us-screening/view-v1.json.gz`);
    await expect(runUsGapReplay(input)).rejects.toEqual({ message: "interrupted browser publish" });
    const pointerBefore = f.files.get(pointerPath);
    expect(pointerBefore).toBeDefined();
    expect(await runUsGapReplay(input)).toMatchObject({
      mode: "PUBLICATION_ONLY",
      screeningPublished: true,
    });
    expect(await runUsGapReplay({ ...input, calculatedAt: "2026-10-12T03:00:00Z" })).toMatchObject({
      mode: "PUBLICATION_ONLY",
    });
    await runUsScreening(f.client, uid);
    const loaded = await loadPublishedUsRecoveryView(f.client, uid, f.identity);
    expect(loaded!.source.metadata!.quarantinedSymbols).toEqual(["WBD", "DBRG"]);
    expect(JSON.parse(f.files.get(cachePath)!.toString())).toEqual(loaded);
    expect(f.files.get(legacyPath)).toBe(oldBytes);
    expect(f.files.get(pointerPath)).toBe(pointerBefore);
    expect(f.files.get(`${uid}/results/us-screening/${day}.json`)).toBe(originalBytes);
    expect(f.files.get(`${uid}/results/us-replay-state/${baseDate}.json`)).toBe(baseBytes);
    for (const [path, bytes] of rawBefore) expect(f.files.get(path)).toBe(bytes);
    expect(f.rpcCalls).toHaveLength(3);
    expect(
      loaded!.analysis.rows
        .filter((r) => ["DBRG", "WBD"].includes(r.symbol))
        .every((r) => r.open === null && r.close === null && !r.a0Entry),
    ).toBe(true);
    expect(loaded!.analysis.rows.find((r) => r.symbol === "SPY")!.close).toBe(101);
  });
  it("blocks an old WBD retry from replacing the expanded selection", async () => {
    const f = setup();
    await f.publishWbd();
    await runUsGapReplay(f.input(["WBD", "DBRG"]));
    const before = [...f.files],
      count = f.writes.length;
    await expect(f.publishWbd()).rejects.toThrow("publication conflict");
    expect([...f.files]).toEqual(before);
    expect(f.writes).toHaveLength(count);
  });
  it("fails closed on corrupt selected version, without falling back to the legacy WBD view", async () => {
    const f = setup();
    await f.publishWbd();
    await runUsGapReplay(f.input(["WBD", "DBRG"]));
    const pointer = JSON.parse(f.files.get(pointerPath)!.toString());
    f.files.set(
      `${uid}/results/us-recovered-screening/${day}/${pointer.payloadHash.slice(7)}.json`,
      "{}",
    );
    await expect(loadPublishedUsRecoveryView(f.client, uid, f.identity)).rejects.toThrow(
      "version is missing or changed",
    );
  });
  it("does not refresh an old reviewed date after ingest advances", async () => {
    const f = setup();
    await f.publishWbd();
    const input = f.input(["WBD", "DBRG"]);
    f.ingest.as_of_date = "2026-10-12";
    const before = [...f.files],
      count = f.writes.length;
    await expect(runUsGapReplay(input)).rejects.toThrow("Current US ingest differs");
    expect([...f.files]).toEqual(before);
    expect(f.writes).toHaveLength(count);
    expect(f.rpcCalls).toHaveLength(1);
  });
  it.each([
    "same set",
    "different subset",
    "shrunk set",
    "changed original",
    "changed universe",
    "older time",
  ])("rejects %s before any successor storage or presentation write", async (kind) => {
    const f = setup();
    await f.publishWbd();
    const next = f.publication(
      kind === "same set"
        ? ["WBD"]
        : kind === "different subset"
          ? ["DBRG"]
          : kind === "shrunk set"
            ? []
            : ["WBD", "DBRG"],
    );
    if (kind === "shrunk set") next.source.sourceCoverageComplete = true;
    if (kind === "changed original")
      next.protectedOriginal.resultHash = bytesHash("wrong original result");
    if (kind === "changed universe") {
      next.analysis.rows = next.analysis.rows.filter((row) => row.symbol !== "SPY");
      next.analysis.summary.inputRows = 2;
      next.source.rowCount = 2;
      next.source.symbolCount = 2;
    }
    if (kind === "older time") next.generatedAt = "2026-10-10T01:00:00Z";
    const before = [...f.files],
      count = f.writes.length;
    await expect(publishUsRecoveryViews(next)).rejects.toThrow("publication conflict");
    expect([...f.files]).toEqual(before);
    expect(f.writes).toHaveLength(count);
  });
  it.each(["cross-owner path", "wrong original", "invalid hash"])(
    "rejects a %s pointer without legacy fallback",
    async (kind) => {
      const f = setup();
      await f.publishWbd();
      await runUsGapReplay(f.input(["WBD", "DBRG"]));
      const pointer = JSON.parse(f.files.get(pointerPath)!.toString());
      if (kind === "cross-owner path") pointer.storagePath = "another-owner/result.json";
      if (kind === "wrong original") pointer.originalDataHash = bytesHash("other source");
      if (kind === "invalid hash") pointer.payloadHash = "../../other-owner/result";
      f.files.set(pointerPath, JSON.stringify(pointer));
      await expect(loadPublishedUsRecoveryView(f.client, uid, f.identity)).rejects.toThrow(
        "publication pointer",
      );
    },
  );
  it("extends a later arbitrary verified lifecycle symbol without code changes and retains every version", async () => {
    const f = setup(["NEXT_LIFECYCLE"]);
    await f.publishWbd();
    await runUsGapReplay(f.input(["WBD", "DBRG"]));
    const priorPointer = JSON.parse(f.files.get(pointerPath)!.toString());
    const priorVersionPath = `${uid}/results/us-recovered-screening/${day}/${priorPointer.payloadHash.slice(7)}.json`;
    const priorBytes = f.files.get(priorVersionPath),
      legacyBytes = f.files.get(legacyPath);
    const next = f.input(["WBD", "DBRG", "NEXT_LIFECYCLE"], "2026-10-12T04:00:00Z");
    await runUsGapReplay(next);
    await runUsGapReplay(next);
    const current = await loadPublishedUsRecoveryView(f.client, uid, f.identity);
    expect(current!.source.metadata!.quarantinedSymbols).toEqual(["WBD", "DBRG", "NEXT_LIFECYCLE"]);
    expect(f.files.get(legacyPath)).toBe(legacyBytes);
    expect(f.files.get(priorVersionPath)).toBe(priorBytes);
    expect(current!.analysis.rows.find((row) => row.symbol === "NEXT_LIFECYCLE")).toMatchObject({
      close: null,
      open: null,
      a0Entry: false,
    });
    expect(f.rpcCalls).toHaveLength(3);
  });
  it("does not treat an ordinary temporary price hold as reviewed lifecycle supersession", async () => {
    const f = setup();
    await f.publishWbd();
    const hold = f.publication(["WBD", "DBRG"]);
    hold.source.pit.kind = "ATOMIC_DATED_SNAPSHOT";
    delete hold.source.lifecycleQuarantines;
    const before = [...f.files],
      count = f.writes.length;
    await expect(publishUsRecoveryViews(hold)).rejects.toThrow("publication conflict");
    expect([...f.files]).toEqual(before);
    expect(f.writes).toHaveLength(count);
  });
  it("requires dated lifecycle evidence before using the reviewed automatic branch", async () => {
    const f = setup();
    await f.publishWbd();
    const input = f.input(["WBD", "DBRG"]);
    const manifest = JSON.parse(f.files.get(input.manifestPath)!.toString());
    delete manifest.sessions[0].lifecycleQuarantines;
    const body = stableJson(manifest);
    f.files.set(input.manifestPath, body);
    input.manifestHash = bytesHash(body);
    const count = f.writes.length;
    await expect(runUsGapReplay(input)).rejects.toThrow("dated lifecycle evidence");
    expect(f.writes).toHaveLength(count);
    expect(f.rpcCalls).toEqual([]);
  });
  it("promotes a temporary hold to verified lifecycle without expanding the quarantine union", async () => {
    const f = setup([], ["DBRG"]);
    await f.publishWbd();
    const prior = await loadPublishedUsRecoveryView(f.client, uid, f.identity);
    expect(prior!.source.metadata!.quarantinedSymbols).toEqual(["DBRG", "WBD"]);
    expect(prior!.analysis.rows.find((row) => row.symbol === "DBRG")!.status).toBeNull();
    const legacyBytes = f.files.get(legacyPath);
    const input = f.input(["WBD", "DBRG"]);
    expect(await runUsGapReplay(input)).toMatchObject({ mode: "PUBLICATION_ONLY" });
    await runUsGapReplay(input);
    const current = await loadPublishedUsRecoveryView(f.client, uid, f.identity);
    expect(current!.source.metadata!.quarantinedSymbols).toEqual(["DBRG", "WBD"]);
    expect(current!.analysis.rows.find((row) => row.symbol === "DBRG")).toMatchObject({
      status: "SUSPENDED",
      open: null,
      close: null,
      a0Entry: false,
    });
    expect(f.files.get(legacyPath)).toBe(legacyBytes);
    const writes = f.writes.length;
    await expect(
      publishUsRecoveryViews(f.publication(["WBD", "DBRG"], "2026-10-12T03:00:00Z")),
    ).rejects.toThrow("publication conflict");
    expect(f.writes).toHaveLength(writes);
  });
  it("cannot downgrade a prior lifecycle exclusion into a temporary hold while adding another exclusion", async () => {
    const f = setup([], ["WBD"]);
    await f.publishWbd();
    const prior = await loadPublishedUsRecoveryView(f.client, uid, f.identity);
    expect(prior!.analysis.rows.find((row) => row.symbol === "WBD")!.status).toBe("SUSPENDED");
    const input = f.input(["DBRG"]);
    const before = [...f.files],
      count = f.writes.length;
    await expect(runUsGapReplay(input)).rejects.toThrow("publication conflict");
    expect([...f.files]).toEqual(before);
    expect(f.writes).toHaveLength(count);
    expect(f.rpcCalls).toHaveLength(1);
  });
});
