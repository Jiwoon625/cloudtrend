import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HOLDING_PRICE_EXIT_POLICY,
  evaluateHoldingPriceExit,
  replayHoldingPriceExit,
  type HoldingPriceExitState,
} from "./engine/holdingPriceExit";
import { listActiveSources } from "./screeningSources.server";
import { priceInputs } from "./portfolioLedgers.server";
import type { NewActualPool } from "./newActualPortfolio";
const cache = new Map<
  string,
  { expires: number; exits: Array<NewActualPool["positions"][number]["priceExit"]> }
>();

/** Derived signals only. Never writes actual fills, cash, model sessions or broker orders. */
export async function attachActualHoldingPriceExits(
  client: SupabaseClient,
  uid: string,
  pool: NewActualPool,
  now: string,
) {
  if (
    new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) <
    HOLDING_PRICE_EXIT_POLICY.effectiveDate
  )
    return;
  const positions = pool.positions.filter((p) => p.market === "KOSPI" || p.market === "ETF");
  if (!positions.length) return;
  const pending = () => ({
    policyVersion: HOLDING_PRICE_EXIT_POLICY.version,
    status: "손절 기준가격 확인 대기",
    reason: null,
    threshold: null,
    peak: null,
    signalDate: null,
  });
  for (const p of positions) p.priceExit = pending();
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const beforeClose =
    new Date(now).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }) <
    "15:30:00";
  const sources = await listActiveSources(client, uid).catch(() => []);
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        uid,
        today,
        beforeClose,
        sources: sources.map((s) => [s.id, s.file_hash]),
        positions: positions.map((p) => [p.market, p.symbol, p.quantity, p.cost]),
        trades: pool.trades.map((t) => [
          t.execution.id,
          t.execution.date,
          t.execution.side,
          t.allocation,
        ]),
      }),
    )
    .digest("hex");
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    positions.forEach((p, i) => {
      const exit = cached.exits[i];
      if (exit) p.priceExit = { ...exit };
    });
    return;
  }
  const inputs = await priceInputs(
    client,
    sources,
    new Set(positions.map((p) => p.symbol)),
    "2026-10-12",
  ).catch(() => null);
  for (const position of positions) {
    const trades = pool.trades.filter(
      (t) => t.execution.market === position.market && t.execution.symbol === position.symbol,
    );
    let cycle = [] as typeof trades,
      balance = 0;
    for (const trade of trades) {
      if (balance === 0) cycle = [];
      cycle.push(trade);
      balance += trade.allocation.quantity * (trade.execution.side === "BUY" ? 1 : -1);
    }
    const buys = cycle.filter((t) => t.execution.side === "BUY");
    // An unapproved multi-lot convention must never silently replace the researched single-position rule.
    if (buys.length !== 1) continue;
    const buy = buys[0]!;
    const entryDate = buy.execution.date;
    const cycleId = createHash("sha256")
      .update(
        JSON.stringify({
          id: buy.execution.id,
          date: entryDate,
          gross: buy.allocation.gross,
          quantity: buy.allocation.quantity,
          fee: buy.allocation.fee,
        }),
      )
      .digest("hex");
    const directory = `${uid}/holding-price-exits/${HOLDING_PRICE_EXIT_POLICY.version}/${cycleId}`;
    const bucket = client.storage.from("cloudtrend-data");
    const listed = await bucket.list(directory, {
      limit: 1,
      sortBy: { column: "name", order: "desc" },
    });
    if (listed.error) continue;
    let seed: HoldingPriceExitState | null = null;
    let checkpointClose: number | null = null;
    const file = listed.data?.[0];
    if (file) {
      const saved = await bucket.download(`${directory}/${file.name}`);
      if (saved.error || !saved.data) continue;
      const checkpoint = JSON.parse(await saved.data.text());
      if (
        checkpoint.cycleId !== cycleId ||
        checkpoint.state?.policyVersion !== HOLDING_PRICE_EXIT_POLICY.version
      )
        continue;
      seed = checkpoint.state;
      checkpointClose = checkpoint.close;
    }
    if (seed?.signalDate) {
      position.priceExit = {
        policyVersion: seed.policyVersion,
        status: "청산 대기 · 다음 거래 가능 시가",
        reason: position.market === "KOSPI" ? "K4" : "E4",
        threshold: seed.signalThreshold,
        peak: seed.peak,
        signalDate: seed.signalDate,
      };
      continue;
    }
    if (!inputs) continue;
    const bars = (inputs.bars[position.symbol] ?? []).filter(
      (b) => b.tradeDate < today || (b.tradeDate === today && !beforeClose),
    );
    const through = bars.at(-1)?.tradeDate;
    if (!through) continue;
    // A revised price basis or a missing overlap requires reconciliation, not a reset of the peak.
    if (
      seed?.throughDate &&
      bars.find((b) => b.tradeDate === seed!.throughDate)?.close !== checkpointClose
    )
      continue;
    const holding = {
      market: position.market as "KOSPI" | "ETF",
      entryDate,
      entryPrice: (buy.allocation.gross / buy.allocation.quantity).toFixed(8),
      quantity: position.quantity,
      costBasis: position.cost,
      state: seed,
    };
    const result =
      replayHoldingPriceExit(holding, bars, through, inputs.marketDates) ??
      (seed
        ? evaluateHoldingPriceExit({
            ...holding,
            date: through,
            close: bars.at(-1)!.close.toFixed(8),
            confirmedClose: true,
            historyComplete: true,
          })
        : null);
    if (!result) continue;
    position.priceExit = {
      policyVersion: result.state.policyVersion,
      status: result.reason
        ? "청산 대기 · 다음 거래 가능 시가"
        : result.status === "BASIS_PENDING"
          ? "손절 기준가격 확인 대기"
          : "보유",
      reason: result.reason,
      threshold: result.threshold,
      peak: result.state.peak,
      signalDate: result.state.signalDate,
    };
    if (result.threshold) {
      const content = JSON.stringify({ cycleId, state: result.state, close: bars.at(-1)!.close });
      const digest = createHash("sha256").update(content).digest("hex");
      const saved = await bucket.upload(
        `${directory}/${result.reason ? "signal.json" : `${through}-${digest}.json`}`,
        content,
        { upsert: false, contentType: "application/json" },
      );
      if (saved.error && !/already exists|duplicate/i.test(saved.error.message))
        throw new Error("손절 기준가격·신호 체크포인트 저장 실패");
    }
  }
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, {
    expires: Date.now() + 300_000,
    exits: positions.map((p) => (p.priceExit ? { ...p.priceExit } : undefined)),
  });
}
