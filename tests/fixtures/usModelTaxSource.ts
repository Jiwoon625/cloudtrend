import type { UsModelTaxSource } from "../../src/lib/engine/usModelTaxProjection";
import { US_PROSPECTIVE_STRATEGIES } from "../../src/lib/engine/usProspectivePortfolio";
import { US_PROSPECTIVE_RULE_VERSION } from "../../src/lib/engine/usProspective";
const id = "A2_QUARTER_SHADOW",
  version = US_PROSPECTIVE_RULE_VERSION;
export function modelTaxFixture(withSale = false): UsModelTaxSource {
  const dates = ["2026-09-28", "2026-09-29", "2026-09-30"];
  const result: UsModelTaxSource = {
    strategyId: id,
    sourceDate: dates[2]!,
    registry: {
      strategy_id: id,
      rule_version: version,
      config: US_PROSPECTIVE_STRATEGIES[1]!,
      frozen_at: "2026-09-28T00:00:00+09:00",
    },
    snapshots: dates.map((date, i) => ({
      strategy_id: id,
      date,
      rule_version: version,
      nav_usd: i === 0 ? 100000 : 99997.5,
      cash_usd: i === 0 ? 100000 : 98997.5,
      fees_usd: i === 1 ? 2.5 : 0,
      state: {
        initializedDate: dates[0]!,
        initialCapital: 100000,
        lastDate: date,
        cash: i === 0 ? 100000 : 98997.5,
        positions: i === 0 ? {} : { ABC: { shares: 10, lastPrice: 100 } },
      },
    })),
    trades: [
      {
        trade_key: "buy-1",
        strategy_id: id,
        execution_date: dates[1]!,
        symbol: "ABC",
        side: "BUY",
        status: "EXECUTED",
        model_price: 100,
        model_shares: 10,
        model_notional: 1000,
        fee_usd: 2.5,
      },
    ],
    completed: dates.map((date) => ({ date, rule_version: version, data_hash: `hash-${date}` })),
    sourceProofs: dates.map((date, i) => ({
      date,
      dataHash: `hash-${date}`,
      ruleVersion: version,
      previousSessionDate: dates[i - 1] ?? "2026-09-25",
      confirmedRegularClose: true,
      failedSymbols: 0,
    })),
  };
  if (withSale) {
    result.trades.push({
      trade_key: "sell-1",
      strategy_id: id,
      execution_date: dates[2]!,
      symbol: "ABC",
      side: "SELL",
      status: "EXECUTED",
      model_price: 120,
      model_shares: 4,
      model_notional: 480,
      fee_usd: 1.2,
    });
    const last = result.snapshots[2]!;
    last.cash_usd = last.state.cash = 99476.3;
    last.fees_usd = 1.2;
    last.state.positions = { ABC: { shares: 6, lastPrice: 120 } };
    last.nav_usd = 100196.3;
  }
  return result;
}
