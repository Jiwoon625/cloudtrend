/** Local synthetic/reference-only audit. No production data, DB, replay or network access. */
import { pathToFileURL } from "node:url";
import { getMockDataset, buildTradeDates } from "../src/lib/engine/mockProvider";
import { runAnalysis, type ScreeningRow } from "../src/lib/engine/pipeline";
import { resolveVerifiedKrIndexMembership } from "../src/lib/engine/verifiedKrIndexMembership";
import { REVIEWED_STOCK_SECTOR_BY_SYMBOL } from "../src/lib/engine/stockSectorMaster";
import { ADDITIONAL_STOCK_SECTOR_BY_SYMBOL } from "../src/lib/engine/additionalStockSectorMaster";
import reference from "../src/lib/engine/verifiedKrIndexMembership.generated.json";

export function syntheticMembershipComparison() {
  const raw = structuredClone(getMockDataset());
  const dates = buildTradeDates(raw.tradeDates.length, new Date("2026-10-08T00:00:00Z"));
  const mapped = new Map(raw.tradeDates.map((date, i) => [date, dates[i]!]));
  const dated = (date: string) => mapped.get(date) ?? date;
  raw.asOfDate = dates.at(-1)!;
  raw.tradeDates = dates;
  if (raw.kospiGateDates) raw.kospiGateDates = raw.kospiGateDates.map(dated);
  for (const bars of Object.values(raw.bars))
    for (const bar of bars) bar.tradeDate = dated(bar.tradeDate);
  for (const series of raw.indexSeries)
    for (const bar of series.bars) bar.tradeDate = dated(bar.tradeDate);
  for (const observation of raw.vkospiObservations ?? [])
    observation.date = dated(observation.date);
  for (const facts of Object.values(raw.financials)) facts.sourceDate = dated(facts.sourceDate);
  // Explicit non-member stress case: cloned synthetic prices, not 033340 market data.
  const sourceStock = raw.instruments.find((inst) => inst.market === "KOSDAQ")!;
  raw.instruments.push({
    ...sourceStock,
    id: "033340",
    symbol: "033340",
    name: "SYNTHETIC non-member 033340",
  });
  raw.bars["033340"] = structuredClone(raw.bars[sourceStock.symbol]!);
  if (raw.financials[sourceStock.symbol])
    raw.financials["033340"] = structuredClone(raw.financials[sourceStock.symbol]!);
  const before = structuredClone(raw),
    after = structuredClone(raw);
  for (const inst of before.instruments)
    if (inst.instrumentType === "STOCK") {
      inst.indexMemberships = ["KOSPI200", "KRX300"];
      inst.valueUpMembershipKnown = false;
    }
  for (const inst of after.instruments)
    if (inst.instrumentType === "STOCK") {
      Object.assign(inst, resolveVerifiedKrIndexMembership(inst.symbol, raw.asOfDate));
      inst.valueUpMembershipKnown = false;
    }
  return { before: runAnalysis(before), after: runAnalysis(after) };
}

export function membershipImpactAudit() {
  const scope = Object.keys({
    ...REVIEWED_STOCK_SECTOR_BY_SYMBOL,
    ...ADDITIONAL_STOCK_SECTOR_BY_SYMBOL,
  });
  const memberCount = scope.filter(
    (symbol) => resolveVerifiedKrIndexMembership(symbol, "2026-10-08").indexMemberships.length > 0,
  ).length;
  const { before, after } = syntheticMembershipComparison();
  const previous = before.rows.filter((row) => row.instrument.instrumentType === "STOCK");
  const next = after.rows.filter((row) => row.instrument.instrumentType === "STOCK");
  const bySymbol = new Map(next.map((row) => [row.instrument.symbol, row]));
  const invariant = (row: ScreeningRow) => ({
    technical: row.technical,
    vf: row.vf,
    operatingScore10: row.operatingScore10,
    previousOperatingScore10: row.previousOperatingScore10,
    kospiEntry: row.kospiEntry,
    kospi80Onset: row.kospi80Onset,
    kospiEightPointEntry: row.kospiEightPointEntry,
    kosdaq80Onset: row.kosdaq80Onset,
    exitSignal: row.exitSignal,
    hardFilterPassed: row.hardFilterPassed,
  });
  const technicalOrder = (rows: ScreeningRow[]) =>
    [...rows]
      .sort(
        (a, b) =>
          (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity) ||
          b.priority.points - a.priority.points ||
          a.instrument.symbol.localeCompare(b.instrument.symbol),
      )
      .map((row) => row.instrument.symbol);
  const priorityOrder = (rows: ScreeningRow[]) =>
    [...rows]
      .sort(
        (a, b) =>
          b.priority.points - a.priority.points ||
          a.instrument.symbol.localeCompare(b.instrument.symbol),
      )
      .map((row) => row.instrument.symbol);
  const moved = (a: string[], b: string[]) => b.filter((symbol, i) => a[i] !== symbol).length;
  const deltas = previous.map((row) => ({
    symbol: row.instrument.symbol,
    membership: bySymbol.get(row.instrument.symbol)!.instrument.indexMemberships,
    before: row.priority.points,
    after: bySymbol.get(row.instrument.symbol)!.priority.points,
    delta:
      Math.round(
        (bySymbol.get(row.instrument.symbol)!.priority.points - row.priority.points) * 100,
      ) / 100,
  }));
  return {
    snapshotAsOfDate: "2026-10-08",
    sourceCounts: reference.snapshots[0]!.indexes.map((index) => ({
      index: index.indexCode,
      count: index.count,
    })),
    codeOnlyScope: {
      description:
        "Repository-reviewed sector master plus additional manually reviewed codes; not the live production screening universe",
      codes: scope.length,
      retainsTwoPoints: memberCount,
      losesTwoPoints: scope.length - memberCount,
    },
    syntheticAnalysis: {
      description:
        "Existing mock prices re-dated to October 8 plus a cloned synthetic non-member 033340 stress case; no real or production price data",
      stocks: previous.length,
      unchangedPriority: deltas.filter((row) => row.delta === 0).length,
      losesTwoPoints: deltas.filter((row) => row.delta === -2).length,
      changedTechnicalOrSignals: previous.filter(
        (row) =>
          JSON.stringify(invariant(row)) !==
          JSON.stringify(invariant(bySymbol.get(row.instrument.symbol)!)),
      ).length,
      technicalThenPriorityOrderMovedPositions: moved(
        technicalOrder(previous),
        technicalOrder(next),
      ),
      priorityOnlyOrderMovedPositions: moved(priorityOrder(previous), priorityOrder(next)),
      technicalOrderBefore: technicalOrder(previous),
      technicalOrderAfter: technicalOrder(next),
      priorityOrderBefore: priorityOrder(previous),
      priorityOrderAfter: priorityOrder(next),
      deltas,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(membershipImpactAudit(), null, 2));
