import { createHash } from "node:crypto";
import { usBrowserViews } from "../../src/lib/usBrowserViews";
import type { UsProspectiveCache, UsProspectiveCacheRow } from "../../src/lib/usProspectiveCloud";
import type {
  UsSameSessionRevisionBundle,
  UsSameSessionRevisionPointer,
} from "../../src/lib/usSameSessionRevision";

export const userId = "00000000-0000-4000-8000-000000000001";
export const originalHash = `sha256:${"a".repeat(64)}`;
export const revisionHash = `sha256:${"b".repeat(64)}`;
export function row(overrides: Partial<UsProspectiveCacheRow> = {}): UsProspectiveCacheRow {
  return {
    date: "2026-10-16",
    symbol: "TEST",
    name: "Synthetic Company",
    market: "NASDAQ",
    sector: "Technology",
    status: "ACTIVE",
    open: 100,
    close: 102,
    ret120: 0.2,
    ret252: 0.3,
    ret120Rank: 0.95,
    ret252Rank: 0.95,
    coreRank: 0.95,
    betaRank: 0.95,
    tkRank: 0.95,
    relvolRank: 0.95,
    liquidityRank: 0.95,
    amihudRank: 0.95,
    adv20Usd: 1000000,
    marketCap: 10000000,
    onset80: true,
    a0Entry: true,
    a0Exit: false,
    a0BetaExit: false,
    a2Entry: true,
    a2Exit: false,
    b3Entry: true,
    b3Exit: false,
    b3BetaExit: false,
    betaWeakStreak: 0,
    primarySignal: "ENTRY",
    ...overrides,
  };
}
export function canonicalCache(): UsProspectiveCache {
  return {
    generatedAt: "2026-10-16T20:30:00Z",
    dataHash: originalHash,
    source: {
      provider: "Synthetic",
      collectedAt: "2026-10-16T20:01:00Z",
      schemaVersion: "fixture-v1",
      metadata: {},
    },
    analysis: {
      date: "2026-10-16",
      ruleVersion: "frozen-test-rule",
      summary: { rankedRows: 1 },
      rows: [row()],
    },
  };
}
export function revisionBundle(): UsSameSessionRevisionBundle {
  const canonical = canonicalCache();
  const view = {
    ...canonical,
    generatedAt: "2026-10-16T23:20:00Z",
    dataHash: revisionHash,
    source: { ...canonical.source, collectedAt: "2026-10-16T23:00:00Z" },
    analysis: { ...canonical.analysis, rows: [row({ close: 103 })] },
  };
  const projected = usBrowserViews(view);
  return {
    version: "us-same-session-bundle-v1",
    userId,
    date: canonical.analysis.date,
    originalDataHash: originalHash,
    revisionDataHash: revisionHash,
    collectedAt: view.source.collectedAt,
    view: projected.screening,
    screening: structuredClone(projected.screening),
    summary: projected.summary,
  };
}
export function bundleWire(bundle: UsSameSessionRevisionBundle = revisionBundle(), raw?: string) {
  const bytes = new TextEncoder().encode(raw ?? JSON.stringify(bundle));
  const pointer: UsSameSessionRevisionPointer = {
    version: "us-same-session-pointer-v1",
    userId: bundle.userId,
    date: bundle.date,
    originalDataHash: bundle.originalDataHash,
    revisionDataHash: bundle.revisionDataHash,
    collectedAt: bundle.collectedAt,
    bundlePath: `${bundle.userId}/results/us-screening-revisions/${bundle.date}/${bundle.revisionDataHash.slice(7)}/bundle.json`,
    bundleHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  return { bytes, pointer };
}
export function referenceCache(): UsProspectiveCache {
  const bundle = revisionBundle();
  const { pointer } = bundleWire(bundle);
  return {
    ...bundle.view,
    source: {
      ...bundle.view.source,
      metadata: {
        sameSessionRevision: {
          version: "us-same-session-reference-v1",
          referenceOnly: true,
          date: pointer.date,
          originalDataHash: pointer.originalDataHash,
          revisionDataHash: pointer.revisionDataHash,
          collectedAt: pointer.collectedAt,
          bundlePath: pointer.bundlePath,
          bundleHash: pointer.bundleHash,
        },
      },
    },
  };
}
