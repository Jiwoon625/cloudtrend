import {
  integratedRegistry,
  prepareIntegratedDailyPublication,
  type IntegratedDailyPublication,
} from "../../src/lib/integratedAllocationPublication";
import {
  createIntegratedAllocationShadow,
  type IntegratedAllocationSessionInput,
  type AllocationSignal,
} from "../../src/lib/integratedAllocationShadow";
import {
  octoberModelCalendar,
  regularOpenAt,
  regularCloseAt,
} from "../../src/lib/ledger/octoberShadowCalendar";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
const F = "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4" as const;
/** Synthetic entries, partial fills, pending reservations, exits and fees. No owner/source data. */
export async function integratedCompatibilityScenario(
  observe?: (publication: IntegratedDailyPublication) => void,
) {
  const result: Record<string, unknown> = {};
  for (const kind of ["O1", "S07"] as const) {
    const registry = await integratedRegistry(kind, F);
    const initial = await createIntegratedAllocationShadow(kind, { codeHash: F });
    const outputs: unknown[] = [];
    let previous: IntegratedDailyPublication | null = null;
    for (const date of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      const sessions: IntegratedAllocationSessionInput[] = [];
      for (const market of ["K", "E", "U"] as const) {
        const calendar = await octoberModelCalendar(market === "U" ? "US" : "KR", "2026-12-31");
        const symbol = `SYNTHETIC_${market}`;
        const signal: AllocationSignal = {
          symbol,
          venue: market === "U" ? "US" : market === "E" ? "ETF" : "KOSDAQ",
          sector: "SYNTHETIC",
          side: date === "2026-10-12" ? "BUY" : "SELL",
          originDate: date,
          reason: "SYNTHETIC_PARITY",
          annualVolatility: 0.3,
          priority: [1, 2, 3],
        };
        const closeAt = regularCloseAt(market === "U" ? "US" : "KR", date);
        sessions.push({
          market,
          date,
          previousSessionDate: previous?.result.markets[market].lastSessionDate ?? null,
          openAt: regularOpenAt(market === "U" ? "US" : "KR", date),
          closeAt,
          availableAt: new Date(Date.parse(closeAt) + 60000).toISOString(),
          decisionAt: new Date(Date.parse(closeAt) + 120000).toISOString(),
          sourceHash: await hashSeriesValue({ market, date, scenario: "synthetic-v1" }),
          codeHash: F,
          calendar: { sourceHash: calendar.sourceHash, sessions: calendar.regularSessions },
          prices: [
            {
              symbol,
              open: market === "U" ? "12" : "1000",
              close: market === "U" ? "13" : "1020",
              volume: 1e6,
              maxBuyQuantity: date === "2026-10-13" ? "5" : null,
              maxSellQuantity: null,
            },
          ],
          signalObservation: "COMPLETE",
          rawOnsets: date === "2026-10-12" ? [symbol] : [],
          deliveredEntrySignals: date === "2026-10-12" ? [signal] : [],
          signals: date === "2026-10-14" ? [] : [signal],
        });
      }
      const publication = await prepareIntegratedDailyPublication({
        registry,
        previous,
        date,
        sessions,
        now: `${date}T23:59:00Z`,
      });
      observe?.(structuredClone(publication));
      outputs.push({
        date,
        inputHash: await hashSeriesValue(sessions),
        publicationHash: await hashSeriesValue(publication),
        stateHash: publication.stateHash,
        resultHash: publication.result.stateHash,
        positions: Object.values(publication.result.markets).reduce(
          (n, m) => n + m.positions.length,
          0,
        ),
        pendingBuys: Object.values(publication.result.markets).reduce(
          (n, m) => n + m.pendingBuys.length,
          0,
        ),
      });
      previous = publication;
    }
    result[kind] = {
      registryHash: await hashSeriesValue(registry),
      initialHash: await hashSeriesValue(initial),
      outputs,
    };
  }
  return result;
}
