import { beforeEach, describe, expect, it, vi } from "vitest";
import type { trustedSupabaseClient } from "../scripts/analysis-run-store";
import { runUsGapReplay } from "../scripts/run-us-gap-replay";
import { bytesHash, type VerifiedUsReplaySession } from "../scripts/us-replay-source";
import { reviewedSourceCsv, sourceCsv } from "./us-replay-fixtures";
import {
  parseUsProspectiveCsv,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";
const mocks = vi.hoisted(() => ({
  shadow: vi.fn(),
  commit: vi.fn(),
  operating: vi.fn(),
  publicationPreflight: vi.fn(),
  publish: vi.fn(),
  dailyPreflight: vi.fn(),
  dailyPublish: vi.fn(),
}));
vi.mock("../scripts/us-replay-screening-publication", () => ({
  preflightUsReplayScreening: mocks.dailyPreflight,
  publishUsReplayScreening: mocks.dailyPublish,
}));
vi.mock("../scripts/us-recovery-publication", () => ({
  preflightUsRecoveryPublication: mocks.publicationPreflight,
  publishUsRecoveryViews: mocks.publish,
}));
vi.mock("../scripts/us-shadow-replay-plan", () => ({
  planUsShadowReplay: mocks.shadow,
  commitUsShadowReplay: mocks.commit,
}));
vi.mock("../scripts/us-operating-replay", () => ({
  US_OPERATING_STRATEGY_IDS: [
    "A0_QUARTER_PRIMARY",
    "A2_QUARTER_SHADOW",
    "B3_BETA_SHADOW",
    "SPY_BENCHMARK",
  ],
  planUsOperatingReplay: mocks.operating,
}));
const uid = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.shadow.mockImplementation(async (input) => ({
    analyses: input.sessions.map((s: VerifiedUsReplaySession) => ({
      date: s.source.date,
      ruleVersion: US_PROSPECTIVE_RULE_VERSION,
      state: { lastDate: s.source.date, coreRanks: { TEST: 0.8 }, betaWeakStreak: {} },
      summary: {},
    })),
    publications: [],
    prepared: [],
    runtimeCodeHash: "runtime",
  }));
  mocks.operating.mockReturnValue({
    planHash: `sha256:${"c".repeat(64)}`,
    expectedPendingTrades: [],
  });
  mocks.commit.mockResolvedValue([]);
  mocks.publicationPreflight.mockResolvedValue({});
  mocks.dailyPreflight.mockResolvedValue({});
  mocks.dailyPublish.mockResolvedValue({});
  mocks.publish.mockImplementation(async (input) => ({
    generatedAt: input.generatedAt,
    dataHash: input.source.dataHash,
    analysis: { date: input.analysis.date },
  }));
});
function setup() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const base = {
    dataHash: `sha256:${"b".repeat(64)}`,
    analysis: {
      date: "2026-10-05",
      ruleVersion: US_PROSPECTIVE_RULE_VERSION,
      state: { lastDate: "2026-10-05", coreRanks: { TEST: 0.7 }, betaWeakStreak: {} },
    },
  };
  files.set(`${uid}/results/us-screening/2026-10-05.json`, JSON.stringify(base));
  const sessions = ["2026-10-06", "2026-10-07"].map((date, i) => {
    const csv = sourceCsv(date),
      rows = parseUsProspectiveCsv(csv);
    const path = `${uid}/us-replay/${date}.csv`,
      rosterPath = `${uid}/us-replay/${date}.roster.json`;
    const roster = JSON.stringify({
      version: "us-dated-roster-v1",
      asOfDate: date,
      capturedAt: `${date}T21:00:00Z`,
      rows,
    });
    files.set(path, csv);
    files.set(rosterPath, roster);
    return {
      date,
      previousSessionDate: i ? "2026-10-06" : "2026-10-05",
      storagePath: path,
      dataHash: bytesHash(csv),
      rowCount: 2,
      symbolCount: 2,
      sourceCapturedAt: `${date}T21:00:00Z`,
      confirmedRegularClose: true,
      failedSymbols: 0,
      sourceCoverageComplete: true,
      quarantinedSymbols: [],
      pit: {
        kind: "ATOMIC_DATED_SNAPSHOT",
        asOfDate: date,
        rosterCapturedAt: `${date}T21:00:00Z`,
        rosterStoragePath: rosterPath,
        rosterHash: bytesHash(roster),
      },
    };
  });
  const original = JSON.stringify({
    dataHash: sessions[1]!.dataHash,
    analysis: {
      date: "2026-10-07",
      ruleVersion: US_PROSPECTIVE_RULE_VERSION,
      state: { lastDate: "2026-10-07", coreRanks: { TEST: 0.1 }, betaWeakStreak: {} },
    },
  });
  files.set(`${uid}/results/us-screening/2026-10-07.json`, original);
  const manifestPath = `${uid}/us-replay/manifest.json`;
  const manifest = JSON.stringify({
    version: "us-dated-replay-v1",
    baseDate: "2026-10-05",
    throughDate: "2026-10-07",
    sessions,
  });
  files.set(manifestPath, manifest);
  let rpcError: string | null = null;
  let completedReplay: Record<string, unknown> | null = null;
  const client = {
    storage: {
      from: () => ({
        async download(path: string) {
          reads.push(path);
          return files.has(path)
            ? { data: { text: async () => files.get(path)! }, error: null }
            : { data: null, error: { message: "404 Object not found" } };
        },
        async upload(path: string, body: string) {
          writes.push(path);
          if (files.has(path)) return { error: { message: "Already exists" } };
          files.set(path, body);
          return { error: null };
        },
      }),
    },
    from(table: string) {
      reads.push(table);
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        in() {
          return q;
        },
        gte() {
          return q;
        },
        lte() {
          return q;
        },
        order() {
          return q;
        },
        async maybeSingle() {
          return { data: table === "us_operating_replays" ? completedReplay : null, error: null };
        },
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({
            data:
              table === "us_screening_history"
                ? [
                    {
                      date: "2026-10-05",
                      data_hash: base.dataHash,
                      rule_version: US_PROSPECTIVE_RULE_VERSION,
                    },
                    {
                      date: "2026-10-07",
                      data_hash: sessions[1]!.dataHash,
                      rule_version: US_PROSPECTIVE_RULE_VERSION,
                    },
                  ]
                : [],
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
    async rpc(_name: string, args: Record<string, unknown>) {
      rpcCalls.push(args);
      return rpcError
        ? { data: null, error: { message: rpcError } }
        : { data: { validated: true, alreadyApplied: Boolean(completedReplay) }, error: null };
    },
  };
  return {
    files,
    writes,
    reads,
    rpcCalls,
    original,
    input: {
      client: client as unknown as ReturnType<typeof trustedSupabaseClient>,
      userId: uid,
      manifestPath,
      manifestHash: bytesHash(manifest),
      apply: false,
      calculatedAt: "2026-10-08T02:00:00Z",
    },
    setCompletedReplay: (value: Record<string, unknown>) => {
      completedReplay = value;
    },
    setRpcError: (v: string) => {
      rpcError = v;
    },
  };
}
function completedReviewedSetup() {
  const f = setup();
  const manifest = JSON.parse(f.files.get(f.input.manifestPath)!);
  const source = manifest.sessions[1];
  manifest.sessions = [source];
  manifest.baseDate = source.previousSessionDate;
  const base = JSON.parse(f.files.get(`${uid}/results/us-screening/2026-10-05.json`)!);
  base.analysis.date = manifest.baseDate;
  base.analysis.state.lastDate = manifest.baseDate;
  f.files.set(`${uid}/results/us-screening/${manifest.baseDate}.json`, JSON.stringify(base));
  source.originalSource = {
    storagePath: source.storagePath,
    dataHash: source.dataHash,
    sourceCapturedAt: source.sourceCapturedAt,
  };
  source.storagePath = `${uid}/us-replay/2026-10-07.reviewed.csv`;
  const csv = reviewedSourceCsv(source.date);
  f.files.set(source.storagePath, csv);
  source.dataHash = bytesHash(csv);
  source.pit.kind = "REVIEWED_ATOMIC_QUARANTINE";
  source.sourceCoverageComplete = false;
  source.quarantinedSymbols = ["TEST"];
  source.lifecycleQuarantines = [
    {
      symbol: "TEST",
      effectiveDate: source.date,
      evidenceUrls: ["https://www.nasdaqtrader.com/fixture"],
    },
  ];
  const text = JSON.stringify(manifest);
  f.files.set(f.input.manifestPath, text);
  const plan = {
    version: "us-operating-replay-v1",
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    planHash: bytesHash("existing original plan"),
    baseDate: manifest.baseDate,
    throughDate: manifest.throughDate,
    dates: [
      {
        date: source.date,
        previousSessionDate: manifest.baseDate,
        sourceHash: source.originalSource.dataHash,
      },
    ],
  };
  const completed = {
    plan_hash: plan.planHash,
    base_date: plan.baseDate,
    through_date: plan.throughDate,
    plan,
    receipt: {
      version: plan.version,
      planHash: plan.planHash,
      baseDate: plan.baseDate,
      throughDate: plan.throughDate,
      committedAt: "2026-10-08T01:00:00Z",
    },
  };
  f.setCompletedReplay(completed);
  return {
    ...f,
    completed,
    input: { ...f.input, manifestHash: bytesHash(text), apply: true, publishDailyScreen: true },
  };
}

describe("guarded US recovery driver", () => {
  it("preflights all files and backend CAS without writing anything", async () => {
    const f = setup();
    expect(await runUsGapReplay(f.input)).toMatchObject({ applied: false, sessions: 2 });
    expect(f.writes).toEqual([]);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(f.rpcCalls).toHaveLength(1);
    expect(f.rpcCalls[0]!["p_apply"]).toBe(false);
    expect(f.reads.some((p) => p.includes("actual"))).toBe(false);
  });
  it("stops on backend dry-run conflict before plan/archive/model writes", async () => {
    const f = setup();
    f.setRpcError("predecessor changed");
    await expect(runUsGapReplay({ ...f.input, apply: true })).rejects.toThrow("preflight failed");
    expect(f.writes).toEqual([]);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("preserves Oct7 original bytes and uses explicit apply only after preflight", async () => {
    const f = setup();
    expect(await runUsGapReplay({ ...f.input, apply: true })).toMatchObject({ applied: true });
    expect(f.rpcCalls.map((c) => c["p_apply"])).toEqual([false, true]);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(f.files.get(`${uid}/results/us-screening/2026-10-07.json`)).toBe(f.original);
    expect(
      f.writes.every((p) => p.includes("/us-gap-replay/") || p.includes("/us-replay-state/")),
    ).toBe(true);
  });
  it("rejects a conflicting recovered rank artifact before any write", async () => {
    const f = setup();
    f.files.set(
      `${uid}/results/us-replay-state/2026-10-07.json`,
      JSON.stringify({ conflicting: true }),
    );
    await expect(runUsGapReplay({ ...f.input, apply: true })).rejects.toThrow(
      "rank artifact conflicts",
    );
    expect(f.writes).toEqual([]);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("pins the approved operating plan hash before any write", async () => {
    const f = setup();
    await expect(
      runUsGapReplay({ ...f.input, apply: true, expectedOperatingPlanHash: bytesHash("changed") }),
    ).rejects.toThrow("approved exact plan hash");
    expect(f.writes).toEqual([]);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("admits publication before writes but publishes only after successful model commits", async () => {
    const f = setup();
    mocks.publicationPreflight.mockImplementation(async () => {
      expect(f.writes).toEqual([]);
      return {};
    });
    mocks.publish.mockImplementation(async (input) => {
      expect(mocks.commit).toHaveBeenCalledTimes(1);
      expect(f.rpcCalls.map((c) => c["p_apply"])).toEqual([false, true]);
      return { dataHash: input.source.dataHash, analysis: { date: input.analysis.date } };
    });
    const result = await runUsGapReplay({
      ...f.input,
      apply: true,
      publishRecoveredView: true,
      expectedOperatingPlanHash: `sha256:${"c".repeat(64)}`,
    });
    expect(result.screeningPublished).toBe(true);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0]![0].analysis).toBe(
      mocks.shadow.mock.results[0]
        ? (await mocks.shadow.mock.results[0].value).analyses[1]
        : undefined,
    );
    expect(f.files.get(`${uid}/results/us-screening/2026-10-07.json`)).toBe(f.original);
  });
  it("rejects publication admission without writing a model or view", async () => {
    const f = setup();
    mocks.publicationPreflight.mockRejectedValueOnce(new Error("newer ingest"));
    await expect(
      runUsGapReplay({ ...f.input, apply: true, publishRecoveredView: true }),
    ).rejects.toThrow("newer ingest");
    expect(f.writes).toEqual([]);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("never publishes if Shadow commit fails and never publishes in a dry-run", async () => {
    const f = setup();
    mocks.commit.mockRejectedValueOnce(new Error("Shadow failed"));
    await expect(
      runUsGapReplay({ ...f.input, apply: true, publishRecoveredView: true }),
    ).rejects.toThrow("Shadow failed");
    expect(mocks.publish).not.toHaveBeenCalled();
    await expect(runUsGapReplay({ ...f.input, publishRecoveredView: true })).rejects.toThrow(
      "requires an applied replay",
    );
  });
  it("rejects final-date source revision before either planner or backend validation", async () => {
    const f = setup();
    f.files.set(`${uid}/us-replay/2026-10-07.csv`, sourceCsv("2026-10-06"));
    await expect(runUsGapReplay(f.input)).rejects.toThrow("hash mismatch");
    expect(mocks.shadow).not.toHaveBeenCalled();
    expect(f.rpcCalls).toEqual([]);
    expect(f.writes).toEqual([]);
  });
  it("publishes the same ATOMIC analyses after both commits, without ordinary screening", async () => {
    const f = setup();
    mocks.dailyPreflight.mockImplementationOnce(async () => {
      expect(f.writes).toEqual([]);
    });
    mocks.dailyPublish.mockImplementationOnce(async (input) => {
      expect(f.rpcCalls.map((call) => call["p_apply"])).toEqual([false, true]);
      expect(mocks.commit).toHaveBeenCalledTimes(1);
      expect(input.analyses).toBe((await mocks.shadow.mock.results[0]!.value).analyses);
    });
    expect(
      await runUsGapReplay({ ...f.input, apply: true, publishDailyScreen: true }),
    ).toMatchObject({ applied: true, screeningPublished: true });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("resumes a failed daily publication from the applied receipt without re-reading sources or stepping models", async () => {
    const f = setup();
    mocks.dailyPublish.mockRejectedValueOnce(new Error("publication interrupted"));
    await expect(
      runUsGapReplay({ ...f.input, apply: true, publishDailyScreen: true }),
    ).rejects.toThrow("publication interrupted");
    const receiptPath = `${uid}/results/us-gap-replay/${f.input.manifestHash.slice(7)}/daily-publication-receipt.json`;
    expect(f.files.has(receiptPath)).toBe(false);
    f.rpcCalls.length = 0;
    f.reads.length = 0;
    mocks.shadow.mockClear();
    mocks.operating.mockClear();
    mocks.commit.mockClear();
    expect(
      await runUsGapReplay({ ...f.input, apply: true, publishDailyScreen: true }),
    ).toMatchObject({ applied: true, screeningPublished: true, reused: true });
    expect(f.rpcCalls).toEqual([]);
    expect(mocks.shadow).not.toHaveBeenCalled();
    expect(mocks.operating).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(f.reads.some((path) => path.endsWith(".csv") || path.endsWith(".roster.json"))).toBe(
      false,
    );
    expect(JSON.parse(f.files.get(receiptPath)!)).toMatchObject({
      version: "us-daily-publication-receipt-v1",
      manifestHash: f.input.manifestHash,
      throughDate: "2026-10-07",
      screeningPublished: true,
    });
  });
  it("automatically applies reviewed quarantine and resumes publication without duplicate model steps", async () => {
    const f = setup();
    const manifest = JSON.parse(f.files.get(f.input.manifestPath)!);
    const source = manifest.sessions[1];
    source.originalSource = {
      storagePath: source.storagePath,
      dataHash: source.dataHash,
      sourceCapturedAt: source.sourceCapturedAt,
    };
    source.storagePath = `${uid}/us-replay/2026-10-07.reviewed.csv`;
    const csv = reviewedSourceCsv(source.date);
    f.files.set(source.storagePath, csv);
    source.dataHash = bytesHash(csv);
    source.pit.kind = "REVIEWED_ATOMIC_QUARANTINE";
    source.sourceCoverageComplete = false;
    source.quarantinedSymbols = ["TEST"];
    source.lifecycleQuarantines = [
      {
        symbol: "TEST",
        effectiveDate: source.date,
        evidenceUrls: ["https://www.nasdaqtrader.com/fixture"],
      },
    ];
    const text = JSON.stringify(manifest);
    f.files.set(f.input.manifestPath, text);
    const input = {
      ...f.input,
      manifestHash: bytesHash(text),
      apply: true,
      publishDailyScreen: true,
    };
    mocks.dailyPublish.mockRejectedValueOnce(new Error("publication interrupted"));
    await expect(runUsGapReplay(input)).rejects.toThrow("publication interrupted");
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.dailyPreflight.mock.calls[0]![0].sources[1].originalSource.dataHash).toBe(
      source.originalSource.dataHash,
    );
    expect(await runUsGapReplay(input)).toMatchObject({
      applied: true,
      screeningPublished: true,
      reused: true,
    });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.shadow).toHaveBeenCalledTimes(1);
    expect(f.rpcCalls.map((call) => call["p_apply"])).toEqual([false, true]);
    expect(f.files.get(`${uid}/results/us-screening/2026-10-07.json`)).toBe(f.original);
  });
  it("automatically republishes a completed reviewed day without stepping either legacy or new models", async () => {
    const f = completedReviewedSetup();
    mocks.dailyPublish.mockRejectedValueOnce(new Error("publication interrupted"));
    await expect(runUsGapReplay(f.input)).rejects.toThrow("publication interrupted");
    expect(await runUsGapReplay(f.input)).toMatchObject({
      mode: "PUBLICATION_ONLY",
      screeningPublished: true,
      originalModelsPreserved: true,
    });
    expect(
      await runUsGapReplay({ ...f.input, calculatedAt: "2026-10-09T04:00:00Z" }),
    ).toMatchObject({ mode: "PUBLICATION_ONLY" });
    expect(mocks.dailyPublish.mock.calls[2]![0].generatedAt).toBe(f.input.calculatedAt);
    expect(f.rpcCalls.map((call) => call["p_apply"])).toEqual([false, false, false]);
    for (const call of f.rpcCalls) expect(call["p_plan"]).toEqual(f.completed.plan);
    expect(mocks.shadow).not.toHaveBeenCalled();
    expect(mocks.operating).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(f.reads).not.toContain("us_strategy_registry");
    expect(f.reads).not.toContain("us_portfolio_snapshots");
    expect(f.writes.some((path) => /us-replay-state|shadow-replay/.test(path))).toBe(false);
    expect(f.files.get(`${uid}/results/us-screening/2026-10-07.json`)).toBe(f.original);
    const published = mocks.dailyPublish.mock.calls[1]![0];
    expect(published.operatingPlanHash).toBe(f.completed.plan_hash);
    expect(
      published.analyses[0].rows.find((row: { symbol: string }) => row.symbol === "TEST"),
    ).toMatchObject({ close: null, a0Entry: false });
  });
  it("blocks a completed-day source identity mismatch and invalid receipt before any writes", async () => {
    for (const corrupt of [
      (f: ReturnType<typeof completedReviewedSetup>) => {
        f.completed.plan.dates[0]!.sourceHash = bytesHash("different original");
      },
      (f: ReturnType<typeof completedReviewedSetup>) => {
        f.completed.receipt.planHash = bytesHash("different plan");
      },
      (f: ReturnType<typeof completedReviewedSetup>) => {
        f.setRpcError("Committed US replay snapshot changed");
      },
    ]) {
      const f = completedReviewedSetup();
      corrupt(f);
      await expect(runUsGapReplay(f.input)).rejects.toThrow(/identity differs|verification failed/);
      expect(f.writes).toEqual([]);
      expect(mocks.commit).not.toHaveBeenCalled();
    }
  });
  it("never publishes daily results before both ledgers acknowledge or in a dry run", async () => {
    const f = setup();
    mocks.commit.mockRejectedValueOnce(new Error("Shadow failed"));
    await expect(
      runUsGapReplay({ ...f.input, apply: true, publishDailyScreen: true }),
    ).rejects.toThrow("Shadow failed");
    expect(mocks.dailyPublish).not.toHaveBeenCalled();
    await expect(runUsGapReplay({ ...f.input, publishDailyScreen: true })).rejects.toThrow(
      "requires an applied replay",
    );
  });
  it("keeps reconstructed historical sources outside the automatic daily path", async () => {
    const f = setup();
    const manifest = JSON.parse(f.files.get(f.input.manifestPath)!);
    manifest.sessions[0].pit.kind = "DATED_ROSTER_RECONSTRUCTION";
    manifest.sessions[0].pit.rosterCapturedAt = "2026-10-06T19:00:00Z";
    const text = JSON.stringify(manifest);
    f.files.set(f.input.manifestPath, text);
    await expect(
      runUsGapReplay({
        ...f.input,
        manifestHash: bytesHash(text),
        apply: true,
        publishDailyScreen: true,
      }),
    ).rejects.toThrow("preserved ATOMIC or reviewed quarantine inputs");
    expect(f.writes).toEqual([]);
    expect(mocks.shadow).not.toHaveBeenCalled();
  });
});
