import type { SupabaseClient } from "@supabase/supabase-js";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import type { NewActualDocument } from "./newActualPortfolio.server";
import {
  buildAllocatedPerformanceHistory,
  type DatedActualPrice,
} from "./allocatedPerformanceHistory";
import type { NewActualCurrency } from "./newActualPortfolio";

/** Rebuildable owner-private report only. Canonical trades/cash and reviewed baselines are untouched. */
export async function publishAllocatedPerformanceHistory(
  client: SupabaseClient,
  userId: string,
  input: {
    currency: NewActualCurrency;
    sourceHash: string;
    throughDate: string;
    dates: string[];
    prices: DatedActualPrice[];
  },
) {
  const sourceHash = input.sourceHash.startsWith("sha256:")
    ? input.sourceHash
    : `sha256:${input.sourceHash}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceHash)) throw new Error("성과 가격 자료 식별 오류");
  const system = input.currency === "KRW" ? "portfolio_ledgers" : "us_actual_portfolio_ledgers";
  const row = await readWebsiteDocument<NewActualDocument>(client, userId, system);
  if (!row?.payload.newActualPortfolio) return { status: "NOT_INITIALIZED" as const };
  const history = buildAllocatedPerformanceHistory({
    ...input,
    sourceHash,
    executions: row.payload.executions,
    metadata: row.payload.newActualPortfolio,
    sourceRevision: row.revision,
    calculatedAt: new Date().toISOString(),
  });
  const fresh = await readWebsiteDocument<NewActualDocument>(client, userId, system);
  if (fresh?.revision !== row.revision)
    throw new Error("성과 구성 중 실제 원장이 변경됐습니다. 다시 실행하세요.");
  const { error } = await client.storage
    .from("cloudtrend-data")
    .upload(
      `${userId}/results/actual-performance/${input.currency}/revision-${row.revision}/${input.throughDate}-${sourceHash.slice(7)}.json`,
      new Blob([JSON.stringify(history)], { type: "application/json" }),
      { upsert: true, contentType: "application/json", cacheControl: "0" },
    );
  if (error) throw new Error("실제 성과 기록 저장 실패");
  const latest = history.points.at(-1);
  return {
    status:
      latest?.date === input.throughDate && latest.nav !== null && latest.returnPercent !== null
        ? ("UPDATED" as const)
        : ("WAITING_INPUT" as const),
  };
}

export async function publishCachedDomesticActualHistory(
  client: SupabaseClient,
  userId: string,
  input: {
    sourceHash: string;
    throughDate: string;
    sources: import("./screeningSources.server").ActiveSourceRecord[];
  },
) {
  const row = await readWebsiteDocument<NewActualDocument>(client, userId, "portfolio_ledgers");
  if (!row?.payload.newActualPortfolio) return { status: "NOT_INITIALIZED" as const };
  const { getCachedActualPriceInputs } = await import("./portfolioLedgers.server");
  const ids = new Set(Object.keys(row.payload.newActualPortfolio.assignments));
  const symbols = new Set(row.payload.executions.filter((e) => ids.has(e.id)).map((e) => e.symbol));
  const source = await getCachedActualPriceInputs(
    client,
    userId,
    input.sources,
    symbols,
    "2026-10-12",
  );
  return publishAllocatedPerformanceHistory(client, userId, {
    currency: "KRW",
    sourceHash: input.sourceHash,
    throughDate: input.throughDate,
    dates: source.marketDates,
    prices: Object.entries(source.bars).flatMap(([symbol, bars]) =>
      bars.map((b) => ({ symbol, date: b.tradeDate, close: b.close })),
    ),
  });
}
