import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HOLDING_PRICE_EXIT_POLICY,
  evaluateHoldingPriceExit,
  replayHoldingPriceExit,
  type HoldingPriceExitState,
} from "./engine/holdingPriceExit";
import { decimal, divide, format, multiply } from "./ledger/decimal";
import { actualPooledBasisByDate, reconstructActualPriceCycle } from "./actualHoldingPriceLots";
import { listActiveSources } from "./screeningSources.server";
import { getCachedActualPriceInputs } from "./portfolioLedgers.server";
import type { NewActualPool, NewActualPosition } from "./newActualPortfolio";

type PriceExit = NonNullable<NewActualPosition["priceExit"]>;
interface PriceCheckpoint {
  cycleId: string;
  close: number;
  state: HoldingPriceExitState;
  /** Open acquisition lots. Old single-fill checkpoints only have `state`. */
  lotStates?: Record<string, HoldingPriceExitState>;
}
const cache = new Map<string, { expires: number; exits: PriceExit[]; issues: string[] }>();
const errorFlag = (pool: NewActualPool, code: string, symbol: string) => {
  const issue = `${code}:${symbol}`;
  pool.issues ??= [];
  if (!pool.issues.includes(issue)) pool.issues.push(issue);
};
const pending = (): PriceExit => ({
  policyVersion: HOLDING_PRICE_EXIT_POLICY.version,
  status: "손절 기준가격 확인 대기",
  reason: null,
  threshold: null,
  peak: null,
  signalDate: null,
  observationDate: null,
  observedClose: null,
  peakDate: null,
  distancePercent: null,
  auditStatus: "PENDING",
  priceSource: null,
});
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cushion = (price: string, threshold: string) => {
  const basis = decimal(threshold);
  return basis > 0n
    ? format(divide(multiply(decimal(price) - basis, decimal("100")), basis))
    : null;
};

/**
 * Reconstruct an actual holding from canonical allocated fills only.
 * For one fill the researched K4/E4 behavior is unchanged. K4 multi-fill
 * acquisition basis follows the already approved proportional pooled accounting.
 * E4 multi-fill lots each own an entry-to-present CLOSE peak. Crossing ANY open
 * lot's line flags the whole symbol for review / full remaining-position sale.
 * The application records a pending signal; it never submits a brokerage order.
 *
 * A confirmed source close triggers automatic parity checks against the pool's
 * remaining quantity/cost, source's decision-day mark, and available actual mark.
 */
export async function attachActualHoldingPriceExits(
  client: SupabaseClient,
  uid: string,
  pool: NewActualPool,
  now: string,
) {
  const issues = new Set<string>();
  const flag = (code: string, symbol: string) => {
    issues.add(`${code}:${symbol}`);
    errorFlag(pool, code, symbol);
  };
  const clock = new Date(now);
  const today = clock.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  if (today < HOLDING_PRICE_EXIT_POLICY.effectiveDate) return;
  const positions = pool.positions.filter((p) => p.market === "KOSPI" || p.market === "ETF");
  if (!positions.length) return;
  positions.forEach((p) => {
    p.priceExit = pending();
  });
  const beforeClose =
    clock.toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }) < "15:30:00";
  const sources = await listActiveSources(client, uid).catch(() => []);
  const key = sha({
    uid,
    today,
    beforeClose,
    sources: sources.map((s) => [s.id, s.file_hash]),
    positions: positions.map((p) => [
      p.market,
      p.symbol,
      p.quantity,
      p.cost,
      p.priceDate,
      p.currentPrice,
    ]),
    trades: pool.trades.map((t) => [
      t.execution.id,
      t.execution.date,
      t.execution.side,
      t.execution.order,
      t.allocation,
    ]),
  });
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    positions.forEach((p, i) => {
      if (cached.exits[i]) p.priceExit = { ...cached.exits[i]! };
    });
    pool.issues ??= [];
    for (const issue of cached.issues) if (!pool.issues.includes(issue)) pool.issues.push(issue);
    return;
  }
  const inputs = await getCachedActualPriceInputs(
    client,
    uid,
    sources,
    new Set(positions.map((p) => p.symbol)),
    "2026-10-12",
  ).catch(() => null);
  const bucket = client.storage.from("cloudtrend-data");
  for (const position of positions) {
    const exit = pending();
    position.priceExit = exit;
    let cycle: ReturnType<typeof reconstructActualPriceCycle>;
    try {
      cycle = reconstructActualPriceCycle(position, pool.trades);
      exit.lotCount = cycle.lots.length;
      exit.basisMethod = cycle.lots.length === 1 ? "SINGLE_FILL" : "WEIGHTED_COST_LOT_PEAKS";
    } catch {
      exit.auditStatus = "MISMATCH";
      exit.status = "원가·수량 대사 확인 대기";
      flag("price_exit_lot_mismatch", position.symbol);
      continue;
    }
    const cycleId = sha(cycle.cycle);
    const directory = `${uid}/holding-price-exits/${HOLDING_PRICE_EXIT_POLICY.version}/${cycleId}`;
    const listed = await bucket.list(directory, {
      limit: 1,
      sortBy: { column: "name", order: "desc" },
    });
    if (listed.error) {
      flag("price_exit_checkpoint_unavailable", position.symbol);
      continue;
    }
    let checkpoint: PriceCheckpoint | null = null;
    let checkpointPath: string | null = null;
    let checkpointContent: string | null = null;
    if (listed.data?.[0]) {
      const file = listed.data[0];
      const saved = await bucket.download(`${directory}/${file.name}`);
      if (saved.error || !saved.data) {
        flag("price_exit_checkpoint_unavailable", position.symbol);
        continue;
      }
      try {
        const content = await saved.data.text();
        checkpoint = JSON.parse(content) as PriceCheckpoint;
        if (
          checkpoint.cycleId !== cycleId ||
          checkpoint.state?.policyVersion !== HOLDING_PRICE_EXIT_POLICY.version ||
          (checkpoint.state.signalDate &&
            (!checkpoint.state.signalClose ||
              !checkpoint.state.signalThreshold ||
              decimal(checkpoint.state.signalClose) <= 0n ||
              decimal(checkpoint.state.signalThreshold) <= 0n ||
              checkpoint.state.signalDate < HOLDING_PRICE_EXIT_POLICY.effectiveDate ||
              checkpoint.state.signalDate < cycle.cycle.date ||
              !checkpoint.state.throughDate ||
              checkpoint.state.signalDate > checkpoint.state.throughDate ||
              checkpoint.state.throughDate > today ||
              (checkpoint.state.throughDate === today && beforeClose))) ||
          (checkpoint.lotStates &&
            Object.values(checkpoint.lotStates).some(
              (state) => state.policyVersion !== HOLDING_PRICE_EXIT_POLICY.version,
            ))
        )
          throw new Error("Invalid price-exit checkpoint");
        checkpointPath = `${directory}/${file.name}`;
        checkpointContent = content;
      } catch {
        exit.auditStatus = "MISMATCH";
        exit.status = "저장 근거 대사 확인 대기";
        flag("price_exit_checkpoint_mismatch", position.symbol);
        continue;
      }
    }
    const bars = (inputs?.bars[position.symbol] ?? [])
      .filter((bar) => bar.tradeDate < today || (bar.tradeDate === today && !beforeClose))
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const through = bars.at(-1)?.tradeDate;
    const lastBar = bars.at(-1);
    // Even latched signals must reconcile any source/quote evidence available
    // on this read. A contradiction blocks action, but never rewrites signal.json.
    if (
      inputs &&
      bars.length &&
      checkpoint?.state.throughDate &&
      (bars.find((bar) => bar.tradeDate === checkpoint!.state.throughDate)?.close !==
        checkpoint.close ||
        (checkpoint.state.signalDate &&
          bars.some(
            (bar) =>
              bar.tradeDate === checkpoint!.state.signalDate &&
              (!Number.isFinite(bar.close) ||
                decimal(bar.close.toFixed(8)) !== decimal(checkpoint!.state.signalClose!)),
          )))
    ) {
      exit.status = "가격 원천 대사 확인 대기";
      exit.auditStatus = "MISMATCH";
      flag("price_exit_source_mismatch", position.symbol);
      continue;
    }
    const markBar = bars.find((bar) => bar.tradeDate === position.priceDate);
    // A same-date mark can contradict durable evidence even while fresh source
    // reads are offline. Never compare different sessions or today's intraday quote.
    const markClose =
      markBar && Number.isFinite(markBar.close) && markBar.close > 0
        ? markBar.close.toFixed(8)
        : checkpoint && checkpoint.state.signalDate === position.priceDate
          ? checkpoint.state.signalClose
          : checkpoint &&
              checkpoint.state.throughDate === position.priceDate &&
              Number.isFinite(checkpoint.close) &&
              checkpoint.close > 0
            ? checkpoint.close.toFixed(8)
            : null;
    if (
      markClose &&
      position.currentPrice != null &&
      decimal(position.currentPrice) !== decimal(markClose)
    ) {
      exit.status = "실제 평가가격·청산가격 대사 확인 대기";
      exit.auditStatus = "MISMATCH";
      flag("price_exit_mark_mismatch", position.symbol);
      continue;
    }
    if (checkpoint?.state.signalDate) {
      if (
        checkpoint.lotStates &&
        Object.values(checkpoint.lotStates).some((lot) => lot.historyComplete === false)
      )
        flag("price_exit_partial_evidence", position.symbol);
      const state = checkpoint.state;
      position.priceExit = {
        ...exit,
        status: "청산 대기 · 다음 거래 가능 시가",
        reason: position.market === "KOSPI" ? "K4" : "E4",
        signalDate: state.signalDate,
        threshold: state.signalThreshold,
        peak: state.peak,
        peakDate: state.peakDate,
        observationDate: state.signalDate,
        observedClose: state.signalClose,
        distancePercent: cushion(state.signalClose!, state.signalThreshold!),
        priceSource: "저장된 운영 정규화 종가",
        auditStatus: "LATCHED",
      };
      continue;
    }
    if (!inputs || !through || through < HOLDING_PRICE_EXIT_POLICY.effectiveDate || !lastBar)
      continue;
    if (!Number.isFinite(lastBar.close) || lastBar.close <= 0) continue;
    const allStates: Record<string, HoldingPriceExitState> = {};
    const results: Array<{
      lotId: string;
      result: NonNullable<ReturnType<typeof replayHoldingPriceExit>>;
    }> = [];
    try {
      if (position.market === "KOSPI") {
        // Each historical close must use ONLY acquisition/sale fills already
        // recorded by that date. The current blended basis is future information
        // for any pre-later-buy close.
        const timeline = actualPooledBasisByDate(position, pool.trades);
        let prior: HoldingPriceExitState | null = checkpoint?.state ?? null;
        let result: ReturnType<typeof evaluateHoldingPriceExit> | null = null;
        for (const bar of bars) {
          if (
            bar.tradeDate < cycle.cycle.date ||
            (prior?.throughDate && bar.tradeDate <= prior.throughDate) ||
            !Number.isFinite(bar.close) ||
            bar.close <= 0
          )
            continue;
          const basis = [...timeline].reverse().find((row) => row.date <= bar.tradeDate);
          if (!basis) continue;
          result = evaluateHoldingPriceExit({
            market: "KOSPI",
            date: bar.tradeDate,
            entryDate: cycle.cycle.date,
            entryPrice: cycle.lots[0]!.entryPrice,
            quantity: basis.quantity,
            costBasis: basis.costBasis,
            close: bar.close.toFixed(8),
            confirmedClose: true,
            historyComplete: true,
            state: prior,
          });
          prior = result.state;
        }
        if (!result && prior) {
          const basis = timeline.filter((row) => row.date <= through).at(-1);
          if (basis)
            result = evaluateHoldingPriceExit({
              market: "KOSPI",
              date: through,
              entryDate: cycle.cycle.date,
              entryPrice: cycle.lots[0]!.entryPrice,
              quantity: basis.quantity,
              costBasis: basis.costBasis,
              close: lastBar.close.toFixed(8),
              confirmedClose: true,
              historyComplete: true,
              state: prior,
            });
        }
        if (result) {
          allStates[cycle.cycle.id] = result.state;
          results.push({ lotId: cycle.cycle.id, result });
        }
      } else {
        for (const lot of cycle.lots) {
          const prev =
            checkpoint?.lotStates?.[lot.id] ??
            (cycle.lots.length === 1 ? checkpoint?.state : null) ??
            (lot.id === cycle.cycle.id ? checkpoint?.state : null);
          const holding = {
            market: "ETF" as const,
            entryDate: lot.entryDate,
            entryPrice: lot.entryPrice,
            quantity: lot.quantity,
            costBasis: lot.costBasis,
            state: prev,
          };
          const result =
            replayHoldingPriceExit(holding, bars, through, inputs.marketDates) ??
            (prev
              ? evaluateHoldingPriceExit({
                  ...holding,
                  date: through,
                  close: lastBar.close.toFixed(8),
                  confirmedClose: true,
                  historyComplete: prev.historyComplete !== false,
                })
              : null);
          if (result) {
            allStates[lot.id] = result.state;
            results.push({ lotId: lot.id, result });
          }
        }
      }
    } catch {
      exit.auditStatus = "MISMATCH";
      exit.status = "손절 계산 근거 대사 확인 대기";
      flag("price_exit_calculation_mismatch", position.symbol);
      continue;
    }
    if (!results.length) continue;
    const available = results.filter((r) => r.result.threshold !== null);
    const triggered = results
      .filter((r) => r.result.reason !== null)
      .sort((a, b) => {
        const byDate = (a.result.state.signalDate ?? "").localeCompare(
          b.result.state.signalDate ?? "",
        );
        return byDate || a.lotId.localeCompare(b.lotId);
      });
    const descendingThreshold = (a: (typeof available)[number], b: (typeof available)[number]) => {
      const left = decimal(a.result.threshold!);
      const right = decimal(b.result.threshold!);
      return left === right ? 0 : left > right ? -1 : 1;
    };
    const line = (triggered[0] ?? available.sort(descendingThreshold)[0])?.result;
    if (!line) continue;
    const fullEvidence =
      results.length === (position.market === "KOSPI" ? 1 : cycle.lots.length) &&
      results.every((r) => r.result.threshold !== null);
    if (!fullEvidence && !triggered.length) continue;
    // A fully evidenced crossing of ANY open lot remains sufficient. Unknown
    // non-triggering lot peaks must not veto that independently proven intent.
    // Keep the incomplete overall evidence explicit, not VERIFIED.
    const state = line.state;
    // A later BUY changes the current pooled basis but must never relabel the
    // exact threshold originally responsible for a latched K4 close.
    const displayedThreshold =
      triggered.length && state.signalThreshold ? state.signalThreshold : line.threshold;
    const status = triggered.length
      ? "청산 대기 · 다음 거래 가능 시가"
      : fullEvidence
        ? "보유"
        : "손절 기준가격 확인 대기";
    const observedClose = state.signalDate ? state.signalClose : lastBar.close.toFixed(8);
    const evaluatedExit: PriceExit = {
      ...exit,
      status,
      reason: triggered.length ? (position.market === "KOSPI" ? "K4" : "E4") : null,
      threshold: displayedThreshold,
      peak: state.peak,
      peakDate: state.peakDate,
      signalDate: state.signalDate,
      observationDate: state.signalDate ?? through,
      observedClose,
      distancePercent:
        displayedThreshold && observedClose ? cushion(observedClose, displayedThreshold) : null,
      auditStatus: fullEvidence ? "VERIFIED" : triggered.length ? "LATCHED" : "PENDING",
      priceSource: "운영 정규화 종가",
    };
    // Publish actionable fields only after immutable storage is confirmed. Keep
    // diagnostic evidence pending while awaiting I/O, including rejected promises.
    position.priceExit = {
      ...evaluatedExit,
      reason: null,
      signalDate: null,
      status: "청산 저장 근거 확인 대기",
      auditStatus: "PENDING",
    };
    if (!fullEvidence) flag("price_exit_partial_evidence", position.symbol);
    if (displayedThreshold) {
      const content = JSON.stringify({
        cycleId,
        state,
        lotStates: allStates,
        close: lastBar.close,
      } satisfies PriceCheckpoint);
      const digest = sha(content);
      const filename = triggered.length ? "signal.json" : `${through}-${digest}.json`;
      const location = `${directory}/${filename}`;
      // The current read has already verified these exact immutable bytes. All
      // source/mark/accounting checks above still run before reuse. A changed
      // path or content must use the normal create-and-verify race handling.
      if (checkpointPath === location && checkpointContent === content) {
        position.priceExit = evaluatedExit;
        continue;
      }
      try {
        const saved = await bucket.upload(location, content, {
          upsert: false,
          contentType: "application/json",
        });
        if (saved.error) {
          if (!/already exists|duplicate/i.test(saved.error.message)) {
            flag("price_exit_checkpoint_unavailable", position.symbol);
            continue;
          }
          const existing = await bucket.download(location);
          if (existing.error || !existing.data || (await existing.data.text()) !== content) {
            position.priceExit.auditStatus = "MISMATCH";
            position.priceExit.status = "청산 저장 근거 대사 확인 대기";
            flag("price_exit_checkpoint_mismatch", position.symbol);
            continue;
          }
        }
        position.priceExit = evaluatedExit;
      } catch {
        flag("price_exit_checkpoint_unavailable", position.symbol);
      }
    }
  }
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, {
    expires: Date.now() + 300_000,
    issues: [...issues],
    exits: positions.map((p) => ({ ...(p.priceExit ?? pending()) })),
  });
}
