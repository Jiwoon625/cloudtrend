import type { SupabaseClient } from "@supabase/supabase-js";
import { decimal, fromLegacyNumber } from "./ledger/decimal";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import { ADOPTED_SERIES_KINDS, RESTART_SERIES_VERSION } from "./ledger/modelSeries";
import {
  projectNewActualPool,
  type NewActualExecution,
  type NewActualPool,
} from "./newActualPortfolio";
import type { NewActualDocument } from "./newActualPortfolio.server";
import {
  loadOctoberShadowSummaryForOwner,
  type OctoberShadowSummary,
} from "./octoberShadowSummary.server";
import { websiteShadowSummary } from "./websitePerformanceBoundary";

export interface WebsiteHolding {
  symbol: string;
  name: string;
  market: NewActualExecution["market"];
  shares: number;
  firstEntryDate: string;
}
/** Only reviewed allocations in the new actual pools; independent of model books. */
export function projectActualPositionContext(
  domestic: NewActualDocument | null,
  us: NewActualDocument | null,
  now = new Date(),
) {
  const today = (currency: "KRW" | "USD") =>
    now.toLocaleDateString("en-CA", {
      timeZone: currency === "KRW" ? "Asia/Seoul" : "America/New_York",
    });
  const pool = (currency: "KRW" | "USD", doc: NewActualDocument | null) =>
    projectNewActualPool({
      currency,
      executions: doc?.executions ?? [],
      metadata: doc?.newActualPortfolio,
      quotes: {},
      valuationDate: null,
      today: today(currency),
    });
  const actualPools: { KRW: NewActualPool; USD: NewActualPool } = {
    KRW: pool("KRW", domestic),
    USD: pool("USD", us),
  };
  const actualExecutions: NewActualExecution[] = Object.values(actualPools).flatMap((p) =>
    p.trades.map(({ execution, allocation }) => ({
      ...execution,
      shares: allocation.quantity,
      price: allocation.gross / allocation.quantity,
      fee: allocation.fee,
    })),
  );
  const cycles = new Map<string, { quantity: bigint; entryDate: string }>();
  for (const e of actualExecutions) {
    const key = `${e.market}:${e.symbol}`;
    const prior = cycles.get(key);
    const quantity = decimal(fromLegacyNumber(e.shares));
    const remaining = (prior?.quantity ?? 0n) + (e.side === "BUY" ? quantity : -quantity);
    if (remaining === 0n) cycles.delete(key);
    else cycles.set(key, { quantity: remaining, entryDate: prior?.entryDate ?? e.date });
  }
  const positions: WebsiteHolding[] = Object.values(actualPools).flatMap((p) =>
    p.positions.map((position) => ({
      symbol: position.symbol,
      name: position.name,
      market: position.market,
      shares: Number(position.quantity),
      firstEntryDate: cycles.get(`${position.market}:${position.symbol}`)!.entryDate,
    })),
  );
  const lastSellDateBySymbol: Record<string, string> = {};
  for (const e of actualExecutions)
    if (
      e.side === "SELL" &&
      (!lastSellDateBySymbol[e.symbol] || e.date > lastSellDateBySymbol[e.symbol]!)
    )
      lastSellDateBySymbol[e.symbol] = e.date;
  return {
    positions,
    actualPools,
    actualExecutions,
    heldSymbols: [...new Set(positions.map((p) => p.symbol))].sort(),
    lastSellDateBySymbol,
  };
}
/** Screener compatibility: actual holdings plus validated restart Shadow holdings. */
export function projectWebsitePositionContext(
  domestic: NewActualDocument | null,
  us: NewActualDocument | null,
  inputShadow: OctoberShadowSummary,
  now = new Date(),
) {
  const actual = projectActualPositionContext(domestic, us, now);
  const positions = [...actual.positions];
  const today = (currency: "KRW" | "USD") =>
    now.toLocaleDateString("en-CA", {
      timeZone: currency === "KRW" ? "Asia/Seoul" : "America/New_York",
    });
  const shadow = websiteShadowSummary(inputShadow);
  if (
    !shadow ||
    shadow.books.length !== ADOPTED_SERIES_KINDS.length ||
    new Set(shadow.books.map((b) => b.kind)).size !== ADOPTED_SERIES_KINDS.length ||
    shadow.books.some((b) => b.status === "UNAVAILABLE")
  )
    throw new Error(
      "신규 Shadow 보유를 확인하지 못했습니다. 과거 보유나 미보유로 대체하지 않습니다.",
    );
  for (const book of shadow.books) {
    if (book.status !== "RECORDED") {
      if (book.holdings.length) throw new Error("미기록 신규 Shadow에 보유가 있습니다.");
      continue;
    }
    if (!book.latestSessionDate || book.latestSessionDate > today(book.currency))
      throw new Error("미래 Shadow 보유는 표시하지 않습니다.");
    for (const h of book.holdings) {
      const market = book.kind.startsWith("US_")
        ? "US"
        : book.kind === "ETF_V02"
          ? "ETF"
          : book.kind === "KR_KOSDAQ"
            ? "KOSDAQ"
            : book.kind === "KR_MIXED"
              ? h.market
              : "KOSPI";
      if (
        !market ||
        !["KOSPI", "KOSDAQ", "ETF", "US"].includes(market) ||
        !Number.isFinite(Number(h.quantity)) ||
        Number(h.quantity) <= 0 ||
        h.entryDate > today(book.currency)
      )
        throw new Error("신규 Shadow 보유의 시장·수량·날짜를 확인하세요.");
      if (!positions.some((p) => p.symbol === h.symbol && p.market === market))
        positions.push({
          symbol: h.symbol,
          name: h.name,
          market,
          shares: Number(h.quantity),
          firstEntryDate: h.entryDate,
        });
    }
  }
  return {
    ...actual,
    positions,
    heldSymbols: [...new Set(positions.map((p) => p.symbol))].sort(),
  };
}

/** Read the owner's actual journals only. Shadow availability cannot block this context. */
export async function loadActualPositionSnapshotForOwner(client: SupabaseClient, uid: string) {
  const [domestic, us] = await Promise.all([
    readWebsiteDocument<NewActualDocument>(client, uid, "portfolio_ledgers"),
    readWebsiteDocument<NewActualDocument>(client, uid, "us_actual_portfolio_ledgers"),
  ]);
  return {
    context: projectActualPositionContext(domestic?.payload ?? null, us?.payload ?? null),
    domestic,
    us,
  };
}
export async function loadActualPositionContextForOwner(client: SupabaseClient, uid: string) {
  return (await loadActualPositionSnapshotForOwner(client, uid)).context;
}

export async function loadWebsitePositionContextForOwner(client: SupabaseClient, uid: string) {
  const [domestic, us, shadow] = await Promise.all([
    readWebsiteDocument<NewActualDocument>(client, uid, "portfolio_ledgers"),
    readWebsiteDocument<NewActualDocument>(client, uid, "us_actual_portfolio_ledgers"),
    loadOctoberShadowSummaryForOwner(client, uid, RESTART_SERIES_VERSION),
  ]);
  return projectWebsitePositionContext(domestic?.payload ?? null, us?.payload ?? null, shadow);
}
