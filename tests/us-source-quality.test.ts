import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  assertUsScreeningCoverage,
  loadVerifiedUsReplaySessions,
  validateUsReplayManifest,
  type UsReplayManifest,
} from "../scripts/us-replay-source";
import {
  assertUsPublishedScoringHolds,
  assertUsSourceQuality,
  usSourceQualityMetadata,
} from "../scripts/us-source-quality";
import { runUsProspectiveAnalysis } from "../src/lib/engine/usProspective";
import { compactRow } from "../scripts/us-screening-publication";

type MutableQuality = {
  version: string;
  priceCoverageComplete: boolean;
  status?: string;
  scoringHolds: Record<
    string,
    { reason: string; postEventBars: number; minimumBars: number; historyStartDate: string }
  >;
};

function golden(mixed = false, producer?: string) {
  const p = spawnSync(
    "python3",
    [
      "collectors/lite_r3/test_us_source_quality.py",
      "--emit",
      ...(mixed ? ["--mixed"] : []),
      ...(producer ? ["--producer", producer] : []),
    ],
    { encoding: "utf8" },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout) as {
    ingest: { user_id: string; metadata: Record<string, unknown> };
    manifest: UsReplayManifest;
    files: Record<string, string>;
  };
}
async function loaded(mixed = false) {
  const g = golden(mixed);
  const manifest = await validateUsReplayManifest(g.manifest, g.ingest.user_id);
  const sessions = await loadVerifiedUsReplaySessions(manifest, async (p) => g.files[p]!);
  return { ...g, ...sessions[0]! };
}

describe("real-redacted collector metadata crosses the complete quality boundary", () => {
  it.each(["present", "absent", "mixed"])(
    "actual upload-stage lifecycle %s → archive → replay → ingest",
    async (mode) => {
      const g = golden(false, mode);
      const manifest = await validateUsReplayManifest(g.manifest, g.ingest.user_id);
      const [f] = await loadVerifiedUsReplaySessions(manifest, async (p) => g.files[p]!);
      expect(f!.source.sourceCoverageComplete).toBe(mode === "absent");
      expect(f!.source.sourceQuality!.priceCoverageComplete).toBe(mode === "absent");
      expect(f!.source.quarantinedSymbols).toEqual(mode === "absent" ? [] : ["GAP"]);
      expect(() => assertUsScreeningCoverage(g.ingest.metadata, f!.rows)).not.toThrow();
      if (mode !== "absent") {
        for (const key of ["open", "close", "ret120", "ret252"]) {
          const unsafe = structuredClone(f!.rows);
          Object.assign(
            unsafe.find((r) => r.symbol === "GAP")!,
            { [key]: 1 },
          );
          expect(() => assertUsScreeningCoverage(g.ingest.metadata, unsafe)).toThrow(
            "Unsafe US coverage quarantine",
          );
        }
      }
      if (mode !== "present") {
        expect(f!.rows.some((r) => r.symbol === "OMITTED")).toBe(false);
        expect(g.ingest.metadata["lifecycleExcludedSymbols"]).toContain("OMITTED");
        for (const bad of [
          { verifiedLifecycleEvents: [] },
          { providerGapSymbols: ["OMITTED"] },
          { lifecycleExcludedSymbols: ["OMITTED", "OMITTED"] },
          { lifecycleExcludedSymbols: ["SPY"] },
          {
            verifiedLifecycleEvents: [
              {
                symbol: "OMITTED",
                status: "ACTIVE",
                effective_date: "2026-10-23",
                source_url: "https://example.invalid/",
              },
            ],
          },
          {
            verifiedLifecycleEvents: [
              {
                symbol: "OMITTED",
                status: "SUSPENDED",
                effective_date: "2026-10-24",
                source_url: "https://example.invalid/",
              },
            ],
          },
          {
            verifiedLifecycleEvents: [
              {
                symbol: "OMITTED",
                status: "SUSPENDED",
                effective_date: "2026-10-23",
                source_url: "http://example.invalid/",
              },
            ],
          },
        ])
          expect(() =>
            assertUsScreeningCoverage({ ...g.ingest.metadata, ...bad }, f!.rows),
          ).toThrow();
      }
    },
  );
  it.each([false, true])(
    "Python freeze -> replay -> direct scorer -> compact publication, provider gap=%s",
    async (mixed) => {
      const f = await loaded(mixed);
      expect(f.source.sourceCoverageComplete).toBe(false);
      expect(f.source.quarantinedSymbols).toEqual(mixed ? ["GAP"] : []);
      expect(f.source.sourceQuality?.priceCoverageComplete).toBe(!mixed);
      expect(Object.keys(f.source.sourceQuality!.scoringHolds)).toEqual(["VJET", "WQEY"]);
      expect(f.ingest.metadata["sourceQuality"]).toEqual(f.source.sourceQuality);
      expect(() => assertUsScreeningCoverage(f.ingest.metadata, f.rows)).not.toThrow();
      const analysis = runUsProspectiveAnalysis(f.rows, {
        lastDate: "2026-10-22",
        coreRanks: { VJET: 0.1, WQEY: 0.1 },
        betaWeakStreak: {},
      });
      for (const symbol of ["VJET", "WQEY"]) {
        const row = analysis.rows.find((r) => r.symbol === symbol)!;
        expect(row).toMatchObject({
          coreScore: null,
          coreRank: null,
          active20: false,
          eligibleBase: false,
          onset80: false,
          a0Entry: false,
          a2Entry: false,
          b3Entry: false,
        });
        expect(row.open).toBeGreaterThan(0);
      }
      const compact = analysis.rows.map(compactRow);
      expect(() => assertUsPublishedScoringHolds(f.source.sourceQuality!, compact)).not.toThrow();
      const meta = usSourceQualityMetadata(f.source);
      expect(meta.sourceQuality).toEqual(f.source.sourceQuality);
      expect(meta.sourceQuality).not.toBe(f.source.sourceQuality);
      // This helper is additive; old immutable outputs remain byte-compatible.
      expect(usSourceQualityMetadata({})).toEqual({});
    },
  );
  it.each([
    ["unknown version", (q: MutableQuality) => (q.version = "future")],
    ["unknown state", (q: MutableQuality) => (q.status = "accepted")],
    ["unknown reason", (q: MutableQuality) => (q.scoringHolds.VJET.reason = "network_timeout")],
    ["enough bars", (q: MutableQuality) => (q.scoringHolds.VJET.postEventBars = 253)],
    ["fractional bars", (q: MutableQuality) => (q.scoringHolds.VJET.postEventBars = 15.5)],
    ["negative bars", (q: MutableQuality) => (q.scoringHolds.VJET.postEventBars = -1)],
    ["wrong threshold", (q: MutableQuality) => (q.scoringHolds.VJET.minimumBars = 252)],
    [
      "future history",
      (q: MutableQuality) => (q.scoringHolds.VJET.historyStartDate = "2026-10-26"),
    ],
    ["invalid date", (q: MutableQuality) => (q.scoringHolds.VJET.historyStartDate = "2026-02-31")],
    ["unknown symbol", (q: MutableQuality) => (q.scoringHolds.OTHER = q.scoringHolds.VJET)],
    ["benchmark hold", (q: MutableQuality) => (q.scoringHolds.SPY = q.scoringHolds.VJET)],
    ["fake price gap", (q: MutableQuality) => (q.priceCoverageComplete = false)],
  ])("rejects %s in cross-stage evidence", async (_, mutate) => {
    const f = await loaded();
    mutate(f.source.sourceQuality);
    expect(() =>
      assertUsSourceQuality(f.source.sourceQuality, false, [], f.source.date, f.rows),
    ).toThrow();
  });
  it.each([
    "ret120",
    "ret252",
    "beta60Spy",
    "ichimokuTkGap",
    "relvol1_20",
    "adv20Usd",
    "amihud20",
    "active20",
    "close",
    "high",
    "volume",
  ])("rejects unsafe held row field %s", async (field) => {
    const f = await loaded();
    const row = f.rows.find((r) => r.symbol === "VJET")!;
    Object.assign(row, { [field]: field === "active20" ? true : field === "volume" ? -1 : 0 });
    expect(() => assertUsScreeningCoverage(f.ingest.metadata, f.rows)).toThrow();
  });
  it("rejects false-complete claim, absent hold, metadata disagreement and unknown state", async () => {
    const f = await loaded();
    for (const metadata of [
      { ...f.ingest.metadata, sourceCoverageComplete: true },
      { ...f.ingest.metadata, sourceCoverageComplete: undefined },
      { ...f.ingest.metadata, guardedCandidateScoringHolds: {} },
      { ...f.ingest.metadata, guardedCandidateQuarantine: { OMITTED: { reason: "identity" } } },
      { ...f.ingest.metadata, sourceQuality: { ...f.source.sourceQuality, scoringHolds: {} } },
    ])
      expect(() => assertUsScreeningCoverage(metadata, f.rows)).toThrow();
  });
  it("compact publication cannot convert unavailable held scores to zero or entry-ready", async () => {
    const f = await loaded();
    const rows = runUsProspectiveAnalysis(f.rows).rows.map(compactRow);
    for (const patch of [
      { coreRank: 0 },
      { betaRank: 0 },
      { eligibleBase: true },
      { a0Entry: true },
      { b3Entry: true },
    ]) {
      const mutated = structuredClone(rows);
      Object.assign(
        mutated.find((r) => r.symbol === "VJET")!,
        patch,
      );
      expect(() => assertUsPublishedScoringHolds(f.source.sourceQuality!, mutated)).toThrow();
    }
  });
  it("retains legacy strict rejection without explicit versioned hold evidence", async () => {
    const f = golden();
    delete f.manifest.sessions[0]!.sourceQuality;
    await expect(
      loadVerifiedUsReplaySessions(f.manifest, async (p) => f.files[p]!),
    ).rejects.toThrow("explicit quarantined");
  });
});

describe("reviewed recovery dispatch pins actual workflow revision", () => {
  it("fails before checkout/operational code if main moved, but leaves ordinary dispatch unchanged", () => {
    const workflow = readFileSync(".github/workflows/us-prospective-screening.yml", "utf8");
    expect(workflow).toContain("      expected_server_code_sha:");
    const screen = workflow.slice(workflow.indexOf("  screen:"));
    const label = "      - name: Verify reviewed server revision before operational access";
    expect(screen.indexOf(label)).toBeGreaterThan(0);
    expect(screen.indexOf(label)).toBeLessThan(screen.indexOf("      - uses: actions/checkout@v4"));
    const lines = screen.slice(screen.indexOf(label)).split("\n");
    const start = lines.indexOf("        run: |") + 1;
    const code = lines
      .slice(start)
      .slice(
        0,
        lines.slice(start).findIndex((line) => !line.startsWith("          ")),
      )
      .map((line) => line.slice(10))
      .join("\n");
    for (const [expected, actual, status] of [
      ["", "a".repeat(40), 0],
      ["a".repeat(40), "a".repeat(40), 0],
      ["a".repeat(40), "b".repeat(40), 1],
      ["invalid", "a".repeat(40), 1],
    ]) {
      const result = spawnSync("bash", ["-c", code], {
        env: {
          PATH: process.env.PATH,
          EXPECTED_SERVER_CODE_SHA: String(expected),
          GITHUB_SHA: String(actual),
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(status);
    }
    expect(code).not.toContain("SUPABASE");
  });
});
