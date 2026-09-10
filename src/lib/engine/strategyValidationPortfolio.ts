import type { SimulatedTrade, StrategySeries } from "./strategyValidationLegacy";

export interface DailyPortfolioRow {
  date: string;
  ret: number;
  active: number;
  overnightActive: number;
  postOpenActive: number;
}

export interface PortfolioMetric {
  trades: number;
  totalReturn: number | null;
  cagr: number | null;
  mdd: number | null;
  sharpe: number | null;
  activeDayRate: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
  averageHoldingDays: number | null;
  daily: DailyPortfolioRow[];
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

const meanOrZero = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function key(market: string | undefined, symbol: string) {
  return `${market === "KOSDAQ" ? "KOSDAQ" : "KOSPI"}:${symbol}`;
}

/**
 * 시가 청산과 같은 시가 신규진입을 두 개의 동시 포지션으로 세지 않도록
 * overnight(전일 종가→시가)와 intraday(시가→종가/청산가)를 순차 복리한다.
 */
export function portfolioDaily(
  trades: SimulatedTrade[],
  series: StrategySeries[],
  dates: string[],
  startDate: string | null,
  costBps: number,
): DailyPortfolioRow[] {
  const lookup = new Map(
    series.map((s) => [
      key(s.market, s.symbol),
      { s, index: new Map(s.bars.map((bar, i) => [bar.tradeDate, i])) },
    ]),
  );
  const cost = Math.max(0, costBps) / 10_000;
  const rows: DailyPortfolioRow[] = [];

  for (const date of dates) {
    if (startDate !== null && date < startDate) continue;

    const overnight = trades.filter((t) => t.entryDate < date && t.exitDate >= date);
    const overnightRets = overnight.map((t) => {
      const found = lookup.get(key(t.market, t.symbol));
      const i = found?.index.get(date);
      if (!found || i === undefined) return 0; // 거래정지 등: 슬롯 유지, 평가손익 0%
      const prevClose = found.s.bars[i - 1]?.close;
      const open = found.s.bars[i]?.open;
      if (!(prevClose && open && prevClose > 0 && open > 0)) return 0;
      let r = open / prevClose - 1;
      if (t.exitDate === date && t.exitTiming === "OPEN") r -= cost;
      return r;
    });

    const postOpen = trades.filter(
      (t) =>
        t.entryDate <= date &&
        (t.exitDate > date || (t.exitDate === date && t.exitTiming !== "OPEN")),
    );
    const intradayRets = postOpen.map((t) => {
      const found = lookup.get(key(t.market, t.symbol));
      const i = found?.index.get(date);
      if (!found || i === undefined) return 0;
      const bar = found.s.bars[i]!;
      const start = t.entryDate === date ? t.entryPrice : bar.open;
      const end = t.exitDate === date ? t.exitPrice : bar.close;
      if (!(start > 0 && end > 0 && Number.isFinite(start) && Number.isFinite(end))) return 0;
      let r = end / start - 1;
      if (t.exitDate === date && t.exitTiming !== "OPEN") r -= cost;
      return r;
    });

    const overnightRet = meanOrZero(overnightRets);
    const intradayRet = meanOrZero(intradayRets);
    rows.push({
      date,
      ret: (1 + overnightRet) * (1 + intradayRet) - 1,
      active: Math.max(overnight.length, postOpen.length),
      overnightActive: overnight.length,
      postOpenActive: postOpen.length,
    });
  }
  return rows;
}

export function portfolioMetric(
  trades: SimulatedTrade[],
  series: StrategySeries[],
  dates: string[],
  startDate: string | null,
  costBps: number,
): PortfolioMetric {
  const daily = portfolioDaily(trades, series, dates, startDate, costBps);
  if (!daily.length) {
    return {
      trades: trades.length, totalReturn: null, cagr: null, mdd: null, sharpe: null,
      activeDayRate: null, avgActivePositions: null, peakActivePositions: 0,
      averageHoldingDays: mean(trades.map((t) => t.holdingDays)), daily,
    };
  }

  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const row of daily) {
    equity *= 1 + row.ret;
    peak = Math.max(peak, equity);
    if (peak > 0) mdd = Math.min(mdd, equity / peak - 1);
  }
  const returns = daily.map((d) => d.ret);
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.length > 1
    ? returns.reduce((a, b) => a + (b - avg) ** 2, 0) / (returns.length - 1)
    : 0;
  const sd = Math.sqrt(Math.max(0, variance));
  const activeDays = daily.filter((d) => d.active > 0).length;

  return {
    trades: trades.length,
    totalReturn: (equity - 1) * 100,
    cagr: equity > 0 ? (equity ** (252 / daily.length) - 1) * 100 : null,
    mdd: mdd * 100,
    sharpe: sd > 0 ? (avg / sd) * Math.sqrt(252) : null,
    activeDayRate: (activeDays / daily.length) * 100,
    avgActivePositions: mean(daily.map((d) => d.active)),
    peakActivePositions: Math.max(...daily.map((d) => d.active), 0),
    averageHoldingDays: mean(trades.map((t) => t.holdingDays)),
    daily,
  };
}
