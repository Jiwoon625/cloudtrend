import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  compareKospiShadowVintage,
  compareArchivedKrBars,
  readOnlyDiagnosticFetch,
  publicDiagnosticReport,
  publicDiagnosticError,
} from "../scripts/diagnose-kospi-shadow-vintage";
import { sha256, stableJson } from "../scripts/analysis-run-store";
import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiShadowSession,
} from "../src/lib/engine/kospiShadow";
import type { KospiShadowRegistry, KospiShadowView } from "../src/lib/kospiShadowStore";
import type { KrDailyInputArchive } from "../src/lib/ledger/octoberShadowArchive";
import type { DailyPrice } from "../src/lib/engine/types";

function fixture() {
  const config = { policy: KOSPI_SHADOW_POLICY };
  const configHash = `sha256:${sha256(stableJson(config))}`;
  const session = (date: string, previousSessionDate: string): KospiShadowSession => ({
    date,
    previousSessionDate,
    sourceHash: "stored-source",
    configHash,
    codeVersion: "frozen-code",
    sourceCollectedAt: "2026-10-14T15:03:00Z",
    confirmedClose: true,
    benchmarkClose: 2500,
    gate: { date, status: "NEUTRAL", issues: [] },
    rows: [
      {
        symbol: "AAA",
        name: "PRIVATE_NAME_NOT_FOR_LOGS",
        sector: "IT",
        date,
        open: 100,
        close: 100,
        volume: 1000,
        score: 7,
        priority: 1,
        rsAccel: 1,
        commonHistory: true,
        onsetEligible: true,
      },
    ],
  });
  const previous = stepKospiShadow(session("2026-10-13", "2026-10-12"), null);
  const original = session("2026-10-14", "2026-10-13");
  const stored = stepKospiShadow(original, previous.state);
  const registry: KospiShadowRegistry = {
    strategyId: KOSPI_SHADOW_POLICY.id,
    ruleVersion: KOSPI_SHADOW_POLICY.version,
    initializedDate: "2026-10-13",
    configHash,
    config,
    initialSourceHash: previous.source.sourceHash,
    initialCodeVersion: previous.source.codeVersion,
  };
  const latest: KospiShadowView = {
    schemaVersion: 1,
    registry,
    latest: structuredClone(stored),
    history: [previous.daily, stored.daily],
    recentTrades: [],
    tradeHistoryTruncated: false,
  };
  const candidate = {
    ...original,
    sourceHash: "current-source",
    codeVersion: "diagnostic-code",
    sourceCollectedAt: "2026-10-14T23:48:00Z",
  };
  return { registry, previous, stored, latest, latestAuthoritative: stored, candidate };
}

describe("read-only prospective KOSPI vintage diagnostic", () => {
  it("contains no private deployment identifiers and never prints upstream error bodies or stacks", async () => {
    const source = await readFile("scripts/diagnose-kospi-shadow-vintage.ts", "utf8");
    expect(source).not.toMatch(/[a-f0-9]{64}/i);
    expect(source).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    expect(source).not.toMatch(/[a-z0-9-]{8,}\.supabase\.co/);
    const error = new Error("PRIVATE_UPSTREAM_BODY_TOKEN");
    error.stack = "PRIVATE_ERROR_STACK";
    const output = JSON.stringify(
      publicDiagnosticError(error, "read_validate_active_registered_inputs"),
    );
    expect(output).not.toContain("PRIVATE_");
    expect(output).toContain("UPSTREAM_READ_OR_VALIDATION_FAILED");
    expect(source).toContain(
      "assertStoredOctoberRun(seriesRecord.payload as FrozenModelSeries, archivedRun)",
    );
    expect(source).toContain("mergeKrDailyInputs(archives)");
  });

  it("distinguishes provenance changes from equal economics without altering original inputs", () => {
    const input = fixture(),
      before = stableJson(input);
    const report = compareKospiShadowVintage(input);
    expect(report.economicStateEqual).toBe(true);
    expect(report.changedSourceFields).toEqual(["codeVersion", "sourceCollectedAt", "sourceHash"]);
    expect(report.hashes).toMatchObject({
      storedSource: "stored-source",
      currentSource: "current-source",
    });
    expect(stableJson(input)).toBe(before);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_NAME_NOT_FOR_LOGS");
    expect(report).not.toHaveProperty("source.rows");
  });

  it("detects changed pending decisions even when cash and NAV have not changed", () => {
    const input = fixture();
    input.candidate.rows = [{ ...input.candidate.rows[0]!, score: 8 }];
    const report = compareKospiShadowVintage(input);
    expect(report.economicStateEqual).toBe(false);
    expect(report.economics?.stored.navKrw).toBe(report.economics?.recomputed.navKrw);
    expect(report.economics?.stored.cashKrw).toBe(report.economics?.recomputed.cashKrw);
    expect(report.changes?.rowFieldsBySymbol.items).toEqual([{ symbol: "AAA", fields: ["score"] }]);
    expect(report.changes?.candidatesEqual).toBe(false);
    expect(report.economics?.recomputed.awaiting).toBe(1);
  });

  it("fails closed for a tampered projection instead of building an alternative history", () => {
    const input = fixture();
    input.latest.latest.state.cashKrw = 123;
    const report = compareKospiShadowVintage(input);
    expect(report.consistency.projectionMatchesAuthoritative).toBe(false);
    expect(report.comparison).toBe("BLOCKED_INCONSISTENT_FROZEN_INPUT");
    expect(report).not.toHaveProperty("economics");
  });

  it("logs only an explicit public-safe whitelist, never private balances or position symbols", () => {
    const input = fixture();
    input.candidate.rows = [{ ...input.candidate.rows[0]!, score: 8 }];
    const archive = {
      ...compareArchivedKrBars([], { bars: {} }),
      changes: [
        {
          date: "2026-10-12",
          symbol: "BBB",
          status: "CHANGED",
          fields: ["close"],
          storedHash: "sha256:old",
          currentHash: "sha256:new",
        },
      ],
    };
    const report = publicDiagnosticReport(compareKospiShadowVintage(input), archive);
    const printed = JSON.stringify(report);
    for (const forbidden of [
      '"economics"',
      '"navKrw":',
      '"cashKrw":',
      '"symbol":',
      '"AAA"',
      '"BBB"',
      '"PRIVATE_NAME_NOT_FOR_LOGS"',
      '"pendingEntries":',
    ])
      expect(printed).not.toContain(forbidden);
    expect(report.economicStateEqual).toBe(false);
    expect(report.archivedPrefix.changedPairHashes).toEqual([
      { stored: "sha256:old", current: "sha256:new" },
    ]);
  });

  it("refuses predecessor or configuration substitution", () => {
    for (const change of ["predecessor", "config"]) {
      const input = fixture();
      if (change === "predecessor") input.candidate.previousSessionDate = "2026-10-12";
      else input.candidate.configHash = "new-config";
      expect(compareKospiShadowVintage(input).comparison).toBe("BLOCKED_INCONSISTENT_FROZEN_INPUT");
    }
  });

  it("allows GET and HEAD while rejecting every mutation before fetch", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const readonly = readOnlyDiagnosticFetch(fetcher);
    await readonly("https://example.invalid/read");
    await readonly("https://example.invalid/read", { method: "HEAD" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      await expect(readonly("https://example.invalid/write", { method })).rejects.toThrow(
        "forbids write requests",
      );
    await expect(
      readonly(new Request("https://example.invalid/write", { method: "POST" })),
    ).rejects.toThrow("forbids write requests");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("independently compares every archived bar and reports field names without raw prices", () => {
    const bar: DailyPrice = {
      tradeDate: "2026-10-12",
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
      tradingValue: 0,
      marketCap: null,
      foreignNetBuyValue: null,
      institutionNetBuyValue: null,
      openObserved: true,
      volumeObserved: true,
    };
    const day: KrDailyInputArchive = {
      version: "kr-daily-inputs-v1",
      date: "2026-10-12",
      inputs: {
        bars: { BBB: [bar], AAA: [bar] },
        snapshots: [],
        markets: {},
        marketGates: {},
      },
    };
    const report = compareArchivedKrBars([day], {
      bars: {
        BBB: [{ ...bar, open: 200, high: 200, low: 200, close: 200 }],
        AAA: [bar],
      },
    });
    expect(report.archivedRows).toBe(2);
    expect(report.matchedRows).toBe(1);
    expect(report.changedRows).toBe(1);
    expect(report.changes[0]).toMatchObject({
      symbol: "BBB",
      date: "2026-10-12",
      fields: ["close", "high", "low", "open"],
    });
    expect(JSON.stringify(report)).not.toContain('"open":200');
    expect(compareArchivedKrBars([day], { bars: {} }).missingRows).toBe(2);
    expect(
      compareArchivedKrBars([day], { bars: { BBB: [bar, bar], AAA: [bar] } }).duplicateCurrentRows,
    ).toBe(1);
  });

  it("keeps the workflow manual, read-only, and free of artifact uploads", async () => {
    const workflow = await readFile(".github/workflows/shadow-vintage-diagnostic.yml", "utf8");
    const diagnose = workflow.split("\n  diagnose:")[1]!;
    expect(workflow).not.toMatch(/^\s+(advance|verify|push|pull_request|workflow_run|schedule):/m);
    expect(diagnose).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.diagnostic_only",
    );
    expect(diagnose).not.toContain("run-kospi-shadow.ts");
    expect(workflow).toMatch(/diagnostic_only:[\s\S]*?default: true/);
    expect(workflow).toMatch(/permissions:\n {2}contents: read/);
    expect(workflow).not.toMatch(/upload-artifact|contents: write|issues: write/);
    expect(workflow).toContain("persist-credentials: false");
  });
});
