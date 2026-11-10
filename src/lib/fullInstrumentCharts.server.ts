import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EtfInstrumentChartBundle } from "./engine/etfInstrumentChart";
import {
  assertChartMatchesCard,
  assertEtfChartMatchesCard,
  chartPath,
  chartReadyPath,
  type ChartIdentity,
  type ChartKind,
} from "./instrumentChartContract";
import {
  prepareChartBucket,
  readChartBundle,
  type ChartBundle,
  type ChartContext,
  type PreparedChart,
} from "./instrumentChartStore.server";
import { stableCacheJson } from "./screeningCacheContract";
import { validDate } from "./ledger/date";

export interface FullChartCoverage {
  symbol: string;
  kind: "ETF" | "STOCK";
  points: number;
  firstDate: string | null;
  lastDate: string | null;
  m0Observations: number | null;
  latestM0: number | null;
}

/** Derived results only: no input registration, screening, signals or ledger writes.
 * Every symbol is an independent resume point. Null M0 warmup is retained rather
 * than backfilled with today's score; recent and full windows must agree exactly.
 */
export async function warmFullInstrumentCharts(
  client: SupabaseClient,
  owner: string,
  identity: ChartIdentity,
  ctx: ChartContext,
  options: {
    includeStocks?: boolean;
    progress?: (completed: number, total: number) => Promise<void> | void;
  } = {},
): Promise<FullChartCoverage[]> {
  const rows = ctx.analysis.rows.filter(
    (row) => row.instrument.instrumentType === "ETF" || options.includeStocks,
  );
  const coverage: FullChartCoverage[] = [];
  const failures: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 8) {
    const settled = await Promise.allSettled(
      rows.slice(offset, offset + 8).map(async (row) => {
        const symbol = row.instrument.symbol;
        const etf = row.instrument.instrumentType === "ETF";
        const kind: ChartKind = etf ? "etf" : "scored";
        const priceKind: ChartKind = etf ? "etf-prices" : "prices";
        const validate = (bundle: ChartBundle) => {
          if (!bundle.chart.length) throw new Error("Empty full-history chart");
          let previous = "";
          for (const point of bundle.chart) {
            if (
              !validDate(point.tradeDate) ||
              point.tradeDate <= previous ||
              point.tradeDate > ctx.analysis.asOfDate
            )
              throw new Error("Invalid full-history date order");
            previous = point.tradeDate;
          }
          if (etf)
            assertEtfChartMatchesCard(bundle as EtfInstrumentChartBundle, ctx.analysis, symbol);
          else assertChartMatchesCard((bundle as PreparedChart).chart, ctx.analysis, symbol);
        };
        let full = await prepareChartBucket(client, owner, identity, ctx, symbol, "all", kind);
        try {
          validate(full);
        } catch {
          full = await prepareChartBucket(
            client,
            owner,
            identity,
            ctx,
            symbol,
            "all",
            kind,
            false,
            true,
          );
          validate(full);
        }
        await prepareChartBucket(client, owner, identity, ctx, symbol, "all", priceKind);
        const recent = await prepareChartBucket(client, owner, identity, ctx, symbol, "120", kind);
        if (stableCacheJson(full.chart.slice(-120)) !== stableCacheJson(recent.chart))
          throw new Error("Full and recent score histories differ");
        if (
          etf &&
          stableCacheJson((full as EtfInstrumentChartBundle).underlying.slice(-120)) !==
            stableCacheJson((recent as EtfInstrumentChartBundle).underlying)
        )
          throw new Error("Full and recent underlying histories differ");
        const stored = await readChartBundle<ChartBundle>(
          client,
          owner,
          chartPath(identity, symbol, "all", kind),
        );
        const storedPrices = await readChartBundle<ChartBundle>(
          client,
          owner,
          chartPath(identity, symbol, "all", priceKind),
        );
        if (!stored?.[symbol] || !storedPrices?.[symbol])
          throw new Error("Full-history readback is missing");
        if (stableCacheJson(stored[symbol]) !== stableCacheJson(full))
          throw new Error("Full-history readback differs");
        validate(stored[symbol]!);
        if (
          etf &&
          stableCacheJson(storedPrices[symbol]!.chart) !==
            stableCacheJson(
              full.chart.map(({ tradeDate, close, volume }) => ({ tradeDate, close, volume })),
            )
        )
          throw new Error("ETF price/volume observations differ from M0 chart");
        const chart = full as EtfInstrumentChartBundle;
        return {
          symbol,
          kind: etf ? "ETF" : "STOCK",
          points: full.chart.length,
          firstDate: full.chart[0]?.tradeDate ?? null,
          lastDate: full.chart.at(-1)?.tradeDate ?? null,
          m0Observations: etf ? chart.chart.filter((point) => point.m0Score !== null).length : null,
          latestM0: etf ? (chart.chart.at(-1)?.m0Score ?? null) : null,
        } satisfies FullChartCoverage;
      }),
    );
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") coverage.push(result.value);
      else
        failures.push(
          `${rows[offset + index]!.instrument.symbol}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
    });
    await options.progress?.(Math.min(offset + 8, rows.length), rows.length);
  }
  if (failures.length)
    throw new Error(
      `Full-history chart verification failed (${failures.length}): ${failures.join(" | ")}`,
    );
  for (const kind of options.includeStocks ? (["etf", "scored"] as const) : (["etf"] as const)) {
    const readyPath = chartReadyPath(identity, kind).replace(
      "-ready.json.gz",
      "-all-ready.json.gz",
    );
    const count = coverage.filter(
      (item) => item.kind === (kind === "etf" ? "ETF" : "STOCK"),
    ).length;
    const { error } = await client.storage
      .from("cloudtrend-data")
      .upload(
        `${owner}/${readyPath}`,
        gzipSync(JSON.stringify({ ready: { symbols: count, readbackVerified: true } })),
        { contentType: "application/octet-stream", upsert: true },
      );
    if (error) throw new Error("Full-history completion marker upload failed");
  }
  return coverage;
}
