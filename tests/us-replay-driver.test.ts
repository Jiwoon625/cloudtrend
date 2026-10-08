import { beforeEach, describe, expect, it, vi } from "vitest";
import type { trustedSupabaseClient } from "../scripts/analysis-run-store";
import { runUsGapReplay } from "../scripts/run-us-gap-replay";
import { bytesHash, type VerifiedUsReplaySession } from "../scripts/us-replay-source";
import { sourceCsv } from "./us-replay-fixtures";
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
        : { data: { validated: true }, error: null };
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
    setRpcError: (v: string) => {
      rpcError = v;
    },
  };
}
describe("guarded US recovery driver", () => {
  it("preflights all files and backend CAS without writing anything", async () => {
    const f = setup();
    expect(await runUsGapReplay(f.input)).toMatchObject({ applied: false, sessions: 2 });
    expect(f.writes).toEqual([]);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(f.rpcCalls).toHaveLength(1);
    expect(f.rpcCalls[0]!.p_apply).toBe(false);
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
    expect(f.rpcCalls.map((c) => c.p_apply)).toEqual([false, true]);
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
      expect(f.rpcCalls.map((c) => c.p_apply)).toEqual([false, true]);
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
});
