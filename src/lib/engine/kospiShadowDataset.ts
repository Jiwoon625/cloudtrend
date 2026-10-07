import type { MarketDataset } from "./dataset";
import type { ScoringConfig } from "./scoring";
import { runFullMarketAnalysis } from "./fullMarketAnalysis";
import { evaluateKospiMarketGateAtDate } from "./kospiMarketGate";
import { kospiRelativeReturns } from "./kospiEntryConfirmation";
import type { KospiShadowSession, KospiShadowRow } from "./kospiShadow";
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Future bars and future-dated facts are removed before any score/PL/priority calculation. */
export function shadowDatasetAsOf(raw: MarketDataset, date: string): MarketDataset {
  if (date > raw.asOfDate) throw new Error("Shadow date exceeds source as-of date");
  const slice = (bars: MarketDataset["bars"][string]) => {
    const sorted = bars
      .filter((b) => b.tradeDate <= date)
      .slice()
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    if (new Set(sorted.map((b) => b.tradeDate)).size !== sorted.length)
      throw new Error("Duplicate dated bars in Shadow input");
    return sorted;
  };
  const dataset: MarketDataset = {
    ...raw,
    asOfDate: date,
    tradeDates: raw.tradeDates.filter((d) => d <= date),
    bars: Object.fromEntries(
      Object.entries(raw.bars).map(([symbol, bars]) => [symbol, slice(bars)]),
    ),
    indexSeries: raw.indexSeries.map((s) => ({ ...s, bars: slice(s.bars) })),
    financials: Object.fromEntries(
      Object.entries(raw.financials).filter(([, facts]) => facts.sourceDate <= date),
    ),
    // Undated volatility has no historical as-of meaning. The strict dated gate does not use it.
    vkospiSeries: [],
    ...(raw.vkospiObservations
      ? { vkospiObservations: raw.vkospiObservations.filter((o) => o.date <= date) }
      : {}),
    ...(raw.kospiGateDates ? { kospiGateDates: raw.kospiGateDates.filter((d) => d <= date) } : {}),
  };
  return dataset;
}
export function buildKospiShadowSession(
  raw: MarketDataset,
  cfg: ScoringConfig,
  provenance: {
    sourceHash: string;
    configHash: string;
    codeVersion: string;
    sourceCollectedAt: string;
    now?: string;
  },
  date = raw.asOfDate,
  completedAnalysis?: ReturnType<typeof runFullMarketAnalysis>["analysis"],
): KospiShadowSession {
  if (!raw.isLive)
    throw new Error("Synthetic data cannot initialize or advance a prospective Shadow");
  const closeAt = Date.parse(`${date}T06:30:00Z`),
    collectedAt = Date.parse(provenance.sourceCollectedAt),
    now = Date.parse(provenance.now ?? new Date().toISOString());
  if (
    !Number.isFinite(closeAt) ||
    !Number.isFinite(collectedAt) ||
    collectedAt < closeAt ||
    now < collectedAt ||
    now < closeAt
  )
    throw new Error("KOSPI source must be uploaded after this session's regular close");
  const ds = shadowDatasetAsOf(raw, date),
    benchmark = ds.indexSeries.filter((s) => s.indexCode === "KOSPI");
  if (benchmark.length !== 1) throw new Error("Unique KOSPI benchmark required");
  const sessions = (ds.kospiGateDates ?? ds.tradeDates).slice().sort();
  if (new Set(sessions).size !== sessions.length || sessions.at(-1) !== date)
    throw new Error("Invalid or stale KOSPI session calendar");
  const close = benchmark[0]!.bars.find((b) => b.tradeDate === date)?.close;
  if (!positive(close)) throw new Error("Exact-date KOSPI close required");
  const analysis = completedAnalysis ?? runFullMarketAnalysis(ds, cfg).analysis;
  if (analysis.asOfDate !== date) throw new Error("Completed Shadow analysis date mismatch");
  const latest = new Map(analysis.rows.map((r) => [r.instrument.symbol, r]));
  const kospi = ds.instruments.filter((i) => i.market === "KOSPI" && i.instrumentType === "STOCK");
  if (new Set(kospi.map((i) => i.symbol)).size !== kospi.length)
    throw new Error("Duplicate KOSPI instruments");
  const common = new Set<string>();
  const history = sessions.slice(-253);
  for (const inst of kospi) {
    const bars = new Map((ds.bars[inst.symbol] ?? []).map((b) => [b.tradeDate, b]));
    if (history.length === 253 && history.every((d) => positive(bars.get(d)?.close)))
      common.add(inst.symbol);
  }
  const rows: KospiShadowRow[] = kospi.map((inst) => {
    const bars = ds.bars[inst.symbol] ?? [],
      bar = bars.find((b) => b.tradeDate === date),
      screen = latest.get(inst.symbol);
    const score =
      bar && positive(bar.close) && screen?.snapshot.tradeDate === date
        ? screen.operatingScore10
        : null;
    return {
      symbol: inst.symbol,
      name: inst.name,
      sector: inst.sectorCode || "UNKNOWN",
      date,
      open: bar?.open ?? null,
      close: bar?.close ?? null,
      volume: bar?.volume ?? null,
      score,
      priority: score === null ? null : (screen?.priority.points ?? null),
      rsAccel: kospiRelativeReturns(bars, benchmark[0]!.bars, sessions, date).rsAccel,
      commonHistory: common.size >= 2 && common.has(inst.symbol),
      // Missing current universe inputs cannot create new model intent. Preserve the
      // technical score for held exits and keep known Primary filter vetoes separate.
      ...((screen?.pendingRules?.length ?? 0) > 0 || screen?.hardFilterStatus === "PENDING"
        ? { universeDataPending: true }
        : {}),
      // The research E8 cross does not inherit known live Primary universe/entry vetoes.
      // Common 253-session history is checked at confirmation, as in the frozen study.
      onsetEligible: score !== null,
    };
  });
  const gate = evaluateKospiMarketGateAtDate(ds, date);
  return {
    date,
    previousSessionDate: sessions.at(-2) ?? null,
    sourceHash: provenance.sourceHash,
    configHash: provenance.configHash,
    codeVersion: provenance.codeVersion,
    sourceCollectedAt: provenance.sourceCollectedAt,
    confirmedClose: true,
    benchmarkClose: close,
    gate: { ...gate },
    rows,
  };
}
