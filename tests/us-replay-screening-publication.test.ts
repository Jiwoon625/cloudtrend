import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  preflightUsReplayScreening,
  publishUsReplayScreening,
  type UsReplayScreeningInput,
} from "../scripts/us-replay-screening-publication";
import { runUsScreening } from "../scripts/run-us-screening";
import { bytesHash } from "../scripts/us-replay-source";
import { stableJson, type trustedSupabaseClient } from "../scripts/analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
import { sourceCsv } from "./us-replay-fixtures";

const uid = "11111111-1111-4111-8111-111111111111";
const day = "2026-10-07";
const latestPath = `${uid}/cache/us-screening/latest.json`;
function setup() {
  const dates = ["2026-10-06", day];
  const analyses = dates.map((date, i) =>
    runUsProspectiveAnalysis(parseUsProspectiveCsv(sourceCsv(date)), {
      lastDate: i ? dates[i - 1]! : "2026-10-05",
      coreRanks: { TEST: 0.1 },
      betaWeakStreak: {},
    }),
  );
  const sources = dates.map((date, i) => ({
    date,
    previousSessionDate: i ? dates[i - 1]! : "2026-10-05",
    storagePath: `${uid}/source/${date}.csv`,
    dataHash: bytesHash(sourceCsv(date)),
    rowCount: 2,
    symbolCount: 2,
    sourceCapturedAt: `${date}T21:00:00Z`,
    confirmedRegularClose: true,
    failedSymbols: 0,
    sourceCoverageComplete: true,
    quarantinedSymbols: [] as string[],
    pit: {
      kind: "ATOMIC_DATED_SNAPSHOT" as const,
      asOfDate: date,
      rosterCapturedAt: `${date}T21:00:00Z`,
      rosterStoragePath: `${uid}/source/${date}.roster.json`,
      rosterHash: bytesHash(date),
    },
  }));
  const files = new Map<string, string | Buffer>(
    sources.map((source) => [source.storagePath, sourceCsv(source.date)]),
  );
  const history = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const reads: string[] = [];
  const ingest = {
    as_of_date: day,
    data_hash: sources[1]!.dataHash,
    storage_bucket: "cloudtrend-data",
    storage_path: sources[1]!.storagePath,
    row_count: 2,
    symbol_count: 2,
    source_provider: "fixture",
    schema_version: "us-prospective-v1",
    collected_at: sources[1]!.sourceCapturedAt,
    metadata: { confirmedRegularClose: true, failedSymbols: 0, previousSessionDate: "2026-10-06" },
  };
  let failMarker: string | null = null;
  let onHistoryInsert: (() => void) | null = null;
  const c = {
    from(table: string) {
      reads.push(table);
      if (!["us_screening_ingest", "us_screening_history"].includes(table))
        throw new Error(`Forbidden ledger access: ${table}`);
      let selected = "*",
        dayFilter: string | undefined;
      const q = {
        select(fields: string) {
          selected = fields;
          return q;
        },
        eq(key: string, value: string) {
          if (key === "date") dayFilter = value;
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        async maybeSingle() {
          if (table === "us_screening_ingest") return { data: ingest, error: null };
          const found = dayFilter
            ? history.get(dayFilter)
            : [...history.values()].sort((a, b) =>
                String(b["date"]).localeCompare(String(a["date"])),
              )[0];
          return {
            data: found
              ? Object.fromEntries(selected.split(",").map((key) => [key, found[key]]))
              : null,
            error: null,
          };
        },
        async insert(value: Record<string, unknown>) {
          writes.push(`history:${value["date"]}`);
          if (value["date"] === failMarker) {
            failMarker = null;
            return { error: { message: "marker interrupted" } };
          }
          if (history.has(String(value["date"])))
            throw new Error("Existing history must never be overwritten");
          history.set(String(value["date"]), structuredClone(value));
          onHistoryInsert?.();
          return { error: null };
        },
      };
      return q;
    },
    rpc() {
      throw new Error("Model/actual RPCs are forbidden during publication");
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
          if (!options.upsert && files.has(path)) return { error: { message: "Already exists" } };
          files.set(path, body);
          return { error: null };
        },
      }),
    },
  };
  const input: UsReplayScreeningInput = {
    client: c as unknown as ReturnType<typeof trustedSupabaseClient>,
    userId: uid,
    analyses,
    sources,
    manifestHash: bytesHash("manifest"),
    operatingPlanHash: bytesHash("operating"),
    generatedAt: "2026-10-08T02:00:00Z",
    protectedHistory: [],
  };
  return {
    input,
    files,
    history,
    ingest,
    writes,
    reads,
    json: (path: string) => JSON.parse(files.get(path)!.toString()),
    failMarker: (date: string) => {
      failMarker = date;
    },
    onHistoryInsert: (callback: () => void) => {
      onHistoryInsert = callback;
    },
  };
}

describe("preserved ATOMIC replay to daily screening", () => {
  it("publishes every missing date with identical entries and state, then same-day screening only republishes", async () => {
    const f = setup();
    const originalInputs = [...f.files];
    const before = stableJson(f.input.analyses);
    expect(f.input.analyses[1]!.summary.a0Entries).toBe(1);
    await preflightUsReplayScreening(f.input);
    expect(f.writes).toEqual([]);
    const payload = await publishUsReplayScreening(f.input);
    expect(f.history.size).toBe(2);
    expect(f.history.get(day)!["summary"]).toEqual(f.input.analyses[1]!.summary);
    expect(f.json(`${uid}/results/us-screening/${day}.json`).analysis.state).toEqual(
      f.input.analyses[1]!.state,
    );
    expect(f.json(latestPath)).toEqual(payload);
    expect(f.json(latestPath).analysis.summary.a0Entries).toBe(1);
    const view = JSON.parse(
      gunzipSync(f.files.get(`${uid}/cache/us-screening/view-v1.json.gz`)!).toString(),
    );
    expect(view.analysis.rows).toEqual(payload.analysis.rows);
    expect(view.analysis).not.toHaveProperty("state");
    const histories = stableJson([...f.history]);
    await runUsScreening(f.input.client, uid);
    expect(f.json(latestPath).analysis.summary.a0Entries).toBe(1);
    expect(stableJson([...f.history])).toBe(histories);
    expect(stableJson(f.input.analyses)).toBe(before);
    for (const [path, bytes] of originalInputs) expect(f.files.get(path)).toBe(bytes);
    expect(f.reads.some((name) => /actual|portfolio|strategy|shadow/.test(name))).toBe(false);
  });
  it("resumes partial history publication and leaves immutable results byte-identical", async () => {
    const f = setup();
    f.failMarker(day);
    await expect(publishUsReplayScreening(f.input)).rejects.toEqual({
      message: "marker interrupted",
    });
    expect(f.history.size).toBe(1);
    expect(f.files.has(latestPath)).toBe(false);
    const results = [...f.files].filter(([path]) => path.includes("/results/"));
    await publishUsReplayScreening(f.input);
    await publishUsReplayScreening(f.input);
    expect(f.history.size).toBe(2);
    for (const [path, bytes] of results) expect(f.files.get(path)).toBe(bytes);
    expect(f.writes.filter((path) => path === "history:2026-10-06")).toHaveLength(1);
    expect(f.json(latestPath).analysis.summary.a0Entries).toBe(1);
  });
  it("preserves existing original history/results and uses the separate recovered view", async () => {
    const f = setup();
    const original = {
      generatedAt: f.input.generatedAt,
      dataHash: f.input.sources[1]!.dataHash,
      analysis: { date: day, ruleVersion: US_PROSPECTIVE_RULE_VERSION, summary: { a0Entries: 0 } },
    };
    const bytes = JSON.stringify(original);
    f.files.set(`${uid}/results/us-screening/${day}.json`, bytes);
    f.files.set(`${uid}/results/us-screening/${day}.manifest.json`, "original manifest");
    const marker = {
      user_id: uid,
      date: day,
      data_hash: original.dataHash,
      rule_version: US_PROSPECTIVE_RULE_VERSION,
      summary: original.analysis.summary,
      signals: [],
    };
    f.history.set(day, marker);
    f.input.protectedHistory.push({
      date: day,
      data_hash: original.dataHash,
      rule_version: US_PROSPECTIVE_RULE_VERSION,
      resultHash: bytesHash(bytes),
    });
    await publishUsReplayScreening(f.input);
    expect(f.files.get(`${uid}/results/us-screening/${day}.json`)).toBe(bytes);
    expect(f.files.get(`${uid}/results/us-screening/${day}.manifest.json`)).toBe(
      "original manifest",
    );
    expect(f.history.get(day)).toBe(marker);
    expect(f.json(latestPath).analysis.summary.a0Entries).toBe(1);
    expect(f.files.has(`${uid}/results/us-recovered-screening/${day}.json`)).toBe(true);
  });
  it("retains honest partial-source holds without inventing coverage", async () => {
    const f = setup();
    const row = f.input.analyses[1]!.rows.find((r) => r.symbol === "TEST")!;
    Object.assign(row, {
      open: null,
      close: null,
      ret120: null,
      ret252: null,
      a0Entry: false,
      a2Entry: false,
      b3Entry: false,
    });
    Object.assign(f.input.sources[1]!, {
      sourceCoverageComplete: false,
      quarantinedSymbols: ["TEST"],
    });
    const result = await publishUsReplayScreening(f.input);
    expect(result.source.metadata.sourceCoverageComplete).toBe(false);
    expect(result.source.metadata.quarantinedSymbols).toEqual(["TEST"]);
    expect(result.analysis.rows.find((r) => r.symbol === "TEST")!.close).toBeNull();
  });
  it("holds conflicting immutable outputs, duplicate symbols and revised source kinds before any writes", async () => {
    for (const mutate of [
      (f: ReturnType<typeof setup>) =>
        f.files.set(
          `${uid}/results/us-screening/${day}.json`,
          JSON.stringify({ conflicting: true }),
        ),
      (f: ReturnType<typeof setup>) => {
        f.input.analyses[1]!.rows[0]!.symbol = f.input.analyses[1]!.rows[1]!.symbol;
      },
      (f: ReturnType<typeof setup>) => {
        f.input.sources[1]!.pit.kind = "DATED_ROSTER_RECONSTRUCTION";
      },
    ]) {
      const f = setup();
      mutate(f);
      await expect(publishUsReplayScreening(f.input)).rejects.toThrow(/conflict|ATOMIC/);
      expect(f.writes).toEqual([]);
    }
  });
  it("never rolls a newer ingest/cache back, including a change during history publication", async () => {
    const f = setup();
    f.onHistoryInsert(() => {
      f.ingest.as_of_date = "2026-10-08";
    });
    await expect(publishUsReplayScreening(f.input)).rejects.toThrow("Current US ingest differs");
    expect(f.files.has(latestPath)).toBe(false);
    const newer = setup();
    newer.files.set(latestPath, JSON.stringify({ analysis: { date: "2026-10-08" } }));
    await expect(publishUsReplayScreening(newer.input)).rejects.toThrow("newer latest cache");
    expect(newer.writes).toEqual([]);
  });
  it("routes replay_then_screen to publication instead of the ordinary model runner", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/us-prospective-screening.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("args+=(--publish-daily-screen)");
    const replayBranch = workflow.slice(
      workflow.indexOf('if [[ -n "$REPLAY_MANIFEST_PATH" ]]'),
      workflow.indexOf('test -z "$REPLAY_MANIFEST_HASH"'),
    );
    expect(replayBranch).not.toContain("npm run us:screening");
  });
});
