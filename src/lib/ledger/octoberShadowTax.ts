import {
  estimateUsTaxOverlay,
  US_TAX_VERSION,
  type UsTaxEvidence,
  type UsTaxOverlayResult,
} from "../engine/usCapitalGainsTax";
import {
  ADOPTED_US_STRATEGY_IDS,
  assertModelCalendarContinuation,
  firstModelSession,
  guardModelRun,
  hashSeriesValue,
  isAdoptedUsSeriesKind,
  verifyFrozenSeries,
  type AdoptedUsRun,
  type FrozenModelSeries,
} from "./modelSeries";

/** Reporting-only, per-book counterfactual pool. Never writes back to a model or actual account. */
export async function octoberShadowTax(input: {
  series: FrozenModelSeries;
  runs: AdoptedUsRun[];
  historyComplete: boolean;
  asOf: string;
  preTaxNavUsd: number | null;
}): Promise<UsTaxOverlayResult> {
  const { series, runs, asOf } = input;
  const poolId = `${series.bookId}:counterfactual`;
  const base = {
    kind: "COUNTERFACTUAL" as const,
    poolId,
    strategyId: series.bookId,
    asOf,
    preTaxNavUsd: input.preTaxNavUsd,
    initialCapitalUsd: series.fx ? Number(series.fx.usdCash) : null,
  };
  const unavailable = (reason: string) => {
    const result = estimateUsTaxOverlay({ ...base, evidence: null });
    result.missingFields = [reason];
    return result;
  };
  if (!isAdoptedUsSeriesKind(series.policy.kind) || !series.fx)
    return unavailable("미국 신규 Shadow 장부 확인 필요");
  if (!input.historyComplete || !runs.length)
    return unavailable("첫 실제 세션부터 기준일까지의 신규 Shadow 전체 이력 확인 대기");
  try {
    await verifyFrozenSeries(series);
    const strategyId = ADOPTED_US_STRATEGY_IDS[series.policy.kind];
    const held = new Map<string, number>();
    const tradeIds = new Set<string>();
    let previous: AdoptedUsRun | null = null;
    let hasSale = false;
    for (const run of runs) {
      const { stateHash, ...body } = run;
      await guardModelRun(series, run.receipt, run.receipt);
      const state = run.result.state;
      const expected = previous
        ? run.calendar.regularSessions.filter((d) => d > previous!.receipt.date).sort()[0]
        : firstModelSession(series, run.calendar);
      if (previous) assertModelCalendarContinuation(series, previous.calendar, run.calendar);
      if (
        run.book !== "MODEL" ||
        run.bookId !== series.bookId ||
        run.contractHash !== series.contractHash ||
        stateHash !== (await hashSeriesValue(body)) ||
        run.previousStateHash !== (previous?.stateHash ?? null) ||
        run.receipt.date !== expected ||
        run.receipt.date > asOf ||
        state.lastDate !== run.receipt.date ||
        state.initializedDate !== series.accountingStartDate ||
        state.initialCapital !== Number(series.fx.usdCash) ||
        state.executionPolicy?.bookId !== series.bookId ||
        state.executionPolicy.contractHash !== series.contractHash ||
        !Array.isArray(run.result.trades)
      )
        throw new Error("신규 Shadow 세션 연결·해시·독립 초기자본 확인 필요");
      for (const trade of run.result.trades) {
        if (trade.status === "PENDING") continue;
        if (
          !["EXECUTED", "PARTIAL"].includes(trade.status) ||
          !["BUY", "REBALANCE_BUY", "SELL", "REBALANCE_SELL"].includes(trade.side) ||
          trade.strategyId !== strategyId ||
          trade.executionDate !== run.receipt.date ||
          !trade.modelShares ||
          !Number.isInteger(trade.modelShares) ||
          trade.modelShares <= 0 ||
          !trade.tradeKey ||
          tradeIds.has(trade.tradeKey)
        )
          throw new Error("신규 Shadow 체결자료 누락·중복 확인 필요");
        tradeIds.add(trade.tradeKey);
        const sell = trade.side === "SELL" || trade.side === "REBALANCE_SELL";
        hasSale ||= sell;
        held.set(trade.symbol, (held.get(trade.symbol) ?? 0) + (sell ? -1 : 1) * trade.modelShares);
      }
      const positions = Object.values(state.positions);
      if (
        positions.some(
          (p) => !Number.isInteger(p.shares) || p.shares <= 0 || held.get(p.symbol) !== p.shares,
        ) ||
        [...held].some(
          ([symbol, shares]) => shares < 0 || shares !== (state.positions[symbol]?.shares ?? 0),
        )
      )
        throw new Error("신규 Shadow 체결·보유수량 대사 필요");
      previous = run;
    }
    if (previous?.receipt.date !== asOf)
      throw new Error("평가 기준일과 마지막 신규 Shadow 세션 불일치");
    if (hasSale)
      return unavailable(
        "매도 발생: 모델 취득원가·결제일·매수/매도 결제환율·인정 필요경비 확인 전 세금 추정 불가",
      );
    // A new book starts with no inherited positions/liabilities. Complete, reconciled,
    // sale-free model history proves zero without inventing settlement or current FX.
    const evidence: UsTaxEvidence = {
      version: US_TAX_VERSION,
      scope: { kind: "COUNTERFACTUAL", poolId, strategyId: series.bookId },
      coverage: {
        historyStartYear: Number(series.accountingStartDate.slice(0, 4)),
        throughDate: asOf,
        transactions: "COMPLETE",
        accounts: "ALL_TAXABLE_ACCOUNTS",
        priorLiabilities: "COMPLETE",
        residency: "MODEL_ASSUMPTION",
        reconciled: true,
        source: `${series.bookId}:verified-complete-session-chain:${previous!.stateHash}`,
      },
      sales: [],
      openingLiabilities: [],
      payments: [],
      valuationFx: null,
      assumptions: [
        "신규 Shadow 장부마다 독립된 가상 납세자·공제 풀을 적용합니다. 실제 납세의무가 아닙니다.",
        "초기 현금 장부부터 기준일까지 전체 세션·체결·보유수량을 대사했고 매도가 없습니다.",
        "미실현손익·배당 제외. 최초 환전 기준환율을 세무 결제환율로 사용하지 않습니다.",
      ],
    };
    return estimateUsTaxOverlay({ ...base, evidence });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "신규 Shadow 세금 원천 확인 실패");
  }
}
