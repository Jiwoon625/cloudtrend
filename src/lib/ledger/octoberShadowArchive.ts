import type { AdoptedKrRun } from "./krAdoptedShadow";
import { hashSeriesValue, type SeriesHash } from "./modelSeries";
import type { MarketDataset } from "../engine/dataset";
import type { ScreeningSnapshot } from "../screeningSnapshot";
export interface KrDailyInputArchive {
  version: "kr-daily-inputs-v1";
  date: string;
  inputs: AdoptedKrRun["frozenInputs"];
}
/** Exactly one stock session, shared by three KR books. No warmup history or ETF copies. */
export function krDailyInputArchive(
  dataset: MarketDataset,
  snapshot: ScreeningSnapshot,
  decisionAt: string,
): KrDailyInputArchive {
  const date = snapshot.asOfDate;
  const stocks = new Map(
    dataset.instruments
      .filter((i) => i.instrumentType === "STOCK" && ["KOSPI", "KOSDAQ"].includes(i.market))
      .map((i) => [i.symbol, i]),
  );
  const cleanSnapshot = JSON.parse(
    JSON.stringify({
      ...snapshot,
      savedAt: decisionAt,
      entries: snapshot.entries.filter((entry) => stocks.has(entry.symbol)),
      topStocks: undefined,
      topEtfs: undefined,
    }),
  ) as ScreeningSnapshot;
  const bars = Object.fromEntries(
    [...stocks].flatMap(([symbol]) => {
      const rows = (dataset.bars[symbol] ?? []).filter((bar) => bar.tradeDate === date);
      return rows.length ? [[symbol, rows]] : [];
    }),
  );
  const referenced = new Set([
    ...Object.keys(bars),
    ...cleanSnapshot.entries.map((entry) => entry.symbol),
  ]);
  cleanSnapshot.totalCount = cleanSnapshot.entries.length;
  cleanSnapshot.passedCount = cleanSnapshot.entries.filter(
    (entry) => entry.hardFilterPassed,
  ).length;
  cleanSnapshot.gradeACount = cleanSnapshot.entries.filter((entry) => entry.grade === "A").length;
  cleanSnapshot.gradeBCount = cleanSnapshot.entries.filter((entry) => entry.grade === "B").length;
  return {
    version: "kr-daily-inputs-v1",
    date,
    inputs: {
      snapshots: [cleanSnapshot],
      bars,
      markets: Object.fromEntries(
        [...stocks]
          .filter(([symbol]) => referenced.has(symbol))
          .map(([symbol, instrument]) => [symbol, instrument.market]),
      ),
      marketGates: snapshot.kospiMarketGate ? { [date]: snapshot.kospiMarketGate } : {},
    },
  };
}
export function mergeKrDailyInputs(days: KrDailyInputArchive[]): AdoptedKrRun["frozenInputs"] {
  const inputs: AdoptedKrRun["frozenInputs"] = {
    snapshots: [],
    bars: {},
    markets: {},
    marketGates: {},
  };
  let previous = "";
  for (const day of days) {
    if (
      day.version !== "kr-daily-inputs-v1" ||
      day.date <= previous ||
      day.inputs.snapshots.length !== 1 ||
      day.inputs.snapshots[0]?.asOfDate !== day.date ||
      Object.values(day.inputs.bars).some((rows) => rows.some((row) => row.tradeDate !== day.date))
    )
      throw new Error("Invalid immutable KR daily archive");
    previous = day.date;
    inputs.snapshots.push(...day.inputs.snapshots);
    for (const [symbol, rows] of Object.entries(day.inputs.bars))
      inputs.bars[symbol] = [...(inputs.bars[symbol] ?? []), ...rows];
    Object.assign(inputs.markets, day.inputs.markets);
    Object.assign(inputs.marketGates, day.inputs.marketGates);
  }
  return inputs;
}
export async function resolveKrInputArchive(
  run: AdoptedKrRun,
  read: (date: string, hash: SeriesHash) => Promise<KrDailyInputArchive>,
): Promise<AdoptedKrRun["frozenInputs"]> {
  if (!run.frozenInputArchive) return run.frozenInputs;
  const days: KrDailyInputArchive[] = [];
  for (const ref of run.frozenInputArchive.days) {
    const value = await read(ref.date, ref.hash);
    if (value.date !== ref.date || (await hashSeriesValue(value)) !== ref.hash)
      throw new Error("KR archive reference changed");
    days.push(value);
  }
  const inputs = mergeKrDailyInputs(days);
  if (
    days.at(-1)?.date !== run.receipt.date ||
    (await hashSeriesValue(inputs)) !== run.frozenInputArchive.prefixHash
  )
    throw new Error("KR archive prefix does not match frozen run");
  return inputs;
}
