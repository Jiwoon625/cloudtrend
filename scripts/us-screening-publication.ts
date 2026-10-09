import { archiveScreeningRun } from "../src/lib/screeningRunArchive";
import { gzipSync } from "node:zlib";
import { ANALYSIS_BUCKET, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";
import type { UsProspectiveAnalysis } from "../src/lib/engine/usProspective";

export async function publishBrowserViews(
  client: ReturnType<typeof trustedSupabaseClient>,
  uid: string,
  result: unknown,
) {
  const views = usBrowserViews(result as UsProspectiveCache);
  const recorded = result as UsProspectiveCache;
  await archiveScreeningRun(client, uid, {
    runId: `us-${recorded.analysis.date}-${recorded.dataHash}`,
    market: "US",
    strategyVersion: recorded.analysis.ruleVersion,
    date: recorded.analysis.date,
    asOfDate: recorded.analysis.date,
    savedAt: recorded.generatedAt,
    sourceRegisteredAt: recorded.source.collectedAt,
    marketGateStatus: "US_A0",
    totalCount: recorded.analysis.rows.length,
    passedCount: recorded.analysis.rows.filter((r) => r.a0Entry).length,
    gradeACount: 0,
    gradeBCount: 0,
    entries: recorded.analysis.rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      market: "US",
      instrumentType: "STOCK",
      sectorCode: r.sector ?? "",
      sectorName: r.sector ?? "",
      grade: "",
      status: r.a0Entry ? "진입 준비" : r.a0Exit ? "과거 청산 조건" : "관찰",
      totalScore: r.coreRank ?? 0,
      scoreDelta1d: null,
      technicalPoints: r.coreRank,
      priorityPoints: r.betaRank ?? 0,
      hardFilterPassed: r.eligibleBase ?? r.a0Entry,
      evidence: { ...r, rawOnset: r.onset80 },
    })),
  });
  const compressed = gzipSync(JSON.stringify(views.screening));
  const { error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(`${uid}/cache/us-screening/view-v1.json.gz`, compressed, {
      upsert: true,
      contentType: "application/octet-stream",
    });
  if (error) throw error;
  await uploadJson(client, `${uid}/cache/us-screening/summary-v1.json`, views.summary);
}

export function compactRow(row: UsProspectiveAnalysis["rows"][number]) {
  return {
    date: row.date,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    sector: row.sector,
    status: row.status,
    close: row.close,
    open: row.open,
    ret120: row.ret120,
    ret252: row.ret252,
    ret120Rank: row.ret120Rank,
    ret252Rank: row.ret252Rank,
    coreRank: row.coreRank,
    previousCoreRank: row.previousCoreRank ?? null,
    previousCoreDate: row.previousCoreDate ?? null,
    eligibleBase: row.eligibleBase,
    betaRank: row.betaRank,
    tkRank: row.tkRank,
    relvolRank: row.relvolRank,
    liquidityRank: row.liquidityRank,
    amihudRank: row.amihudRank,
    adv20Usd: row.adv20Usd,
    marketCap: row.marketCap,
    onset80: row.onset80,
    a0Entry: row.a0Entry,
    a0Exit: row.a0Exit,
    a0BetaExit: row.a0BetaExit,
    a2Entry: row.a2Entry,
    a2Exit: row.a2Exit,
    b3Entry: row.b3Entry,
    b3Exit: row.b3Exit,
    b3BetaExit: row.b3BetaExit,
    betaWeakStreak: row.betaWeakStreak,
    primarySignal: row.primarySignal,
  };
}
