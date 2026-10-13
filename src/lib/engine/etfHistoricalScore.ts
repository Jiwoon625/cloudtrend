import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import {
  ETF_MAPPING,
  ETF_POLICY,
  etfTechnical,
  etfFamily,
  isEtfStrategyAssetClass,
  type EtfMapping,
  type EtfStrategySnapshot,
} from "./etfStrategy";

/** Display-only historical reconstruction. The private policy math is deliberately
 * mirrored here: editing the immutable operational module would change ledger
 * engine hashes. Keep the original formulas and validate dated results against
 * calculateEtfStrategies; never use this module for signals, orders, or ledgers.
 * Public technical scoring, family resolution, and frozen mappings remain shared.
 */
type N = number | null;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): N {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y),
    m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}
function avg(xs: N[], n: number, i = xs.length - 1): N {
  const a = xs.slice(i - n + 1, i + 1);
  return i >= n - 1 && a.length === n && a.every(finite) ? mean(a) : null;
}
function sampleStd(xs: N[]): N {
  if (xs.length < 2 || !xs.every(finite)) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function returns(xs: N[]): N[] {
  return xs.map((v, i) => (positive(v) && positive(xs[i - 1]) ? v / xs[i - 1]! - 1 : null));
}
function vol20(xs: N[]): N {
  return xs.length >= 21 ? sampleStd(returns(xs).slice(-20)) : null;
}
function cloud(bars: DailyPrice[]): N {
  const i = bars.length - 1 - 26;
  const mid = (n: number): N => {
    if (i < n - 1) return null;
    const a = bars.slice(i - n + 1, i + 1);
    return a.every((b) => positive(b.high) && positive(b.low))
      ? (Math.max(...a.map((b) => b.high)) + Math.min(...a.map((b) => b.low))) / 2
      : null;
  };
  const a = mid(9),
    b = mid(26),
    c = mid(52);
  return a !== null && b !== null && c !== null ? Math.max((a + b) / 2, c) : null;
}
const smooth = (gap: number, vol: number) =>
  Math.max(0, Math.min(100, 50 + (25 * gap) / Math.max(0.003, vol)));
function regime(values: N[]) {
  const last = values.at(-1),
    m20 = avg(values, 20),
    m60 = avg(values, 60),
    old60 = avg(values, 60, values.length - 6);
  return {
    close: positive(last) ? last : null,
    ma60: m60,
    breadth:
      positive(last) && positive(m20) && positive(m60)
        ? ((Number(last > m20) + Number(last > m60) + Number(m20 > m60)) / 3) * 100
        : null,
    score:
      positive(last) && positive(m20) && positive(m60) && positive(old60)
        ? 25 * (Number(last > m20) + Number(last > m60) + Number(m20 > m60) + Number(m60 > old60))
        : null,
  };
}
function priceFeatures(bars: DailyPrice[]) {
  const c = bars.map((b) => b.close),
    last = c.at(-1)!,
    m20 = avg(c, 20),
    m60 = avg(c, 60),
    m120 = avg(c, 120),
    top = cloud(bars);
  const ret = (n: number) =>
    c.length > n && positive(c[c.length - n - 1]) ? last / c[c.length - n - 1]! - 1 : null;
  return {
    r20: ret(20),
    r60: ret(60),
    above20: m20 === null ? null : Number(last > m20),
    above60: m60 === null ? null : Number(last > m60),
    cloud: top === null ? null : Number(last > top),
    aligned: m20 !== null && m60 !== null && m120 !== null && m20 > m60 && m60 > m120 ? 1 : 0,
    near:
      bars.length >= 252 && last >= Math.max(...bars.slice(-252).map((b) => b.high)) * 0.9 ? 1 : 0,
    advancing: c.length > 1 && last > c[c.length - 2]! ? 1 : 0,
  };
}
function stockSectors(ds: MarketDataset, date: string): Map<string, number> {
  const market = datedWindow(
    ds.indexSeries.find((x) => x.indexCode === "KOSPI")?.bars ?? [],
    date,
    252,
  );
  if (market.at(-1)?.tradeDate !== date) return new Map();
  const m = priceFeatures(market),
    groups = new Map<string, ReturnType<typeof priceFeatures>[]>();
  for (const inst of ds.instruments) {
    if (inst.instrumentType !== "STOCK") continue;
    const bars = datedWindow(ds.bars[inst.symbol] ?? [], date, 252);
    if (bars.at(-1)?.tradeDate !== date) continue;
    const a = groups.get(inst.sectorCode) ?? [];
    a.push(priceFeatures(bars));
    groups.set(inst.sectorCode, a);
  }
  if (m.r20 === null || m.r60 === null) return new Map();
  const stats = [...groups].map(([code, a]) => {
    const majority = (key: "above20" | "above60" | "cloud") => {
      const v = a.map((x) => x[key]).filter(finite);
      return v.length && mean(v) > 0.5 ? 1 : 0;
    };
    return {
      code,
      rs20: (median(a.map((x) => x.r20).filter(finite)) ?? m.r20!) - m.r20!,
      rs60: (median(a.map((x) => x.r60).filter(finite)) ?? m.r60!) - m.r60!,
      trend: ((majority("above20") + majority("above60") + majority("cloud")) / 3) * 20,
      breadth: mean(a.map((x) => (x.aligned + x.near + x.advancing) / 3)) * 20,
    };
  });
  return new Map(
    stats.map((s) => [
      s.code,
      (stats.filter((x) => x.rs20 < s.rs20).length / stats.length) * 35 +
        (stats.filter((x) => x.rs60 < s.rs60).length / stats.length) * 25 +
        s.trend +
        s.breadth,
    ]),
  );
}

/** Family observations are computed once, not by rerunning the screener for
 * each chart point. Each lookup still uses the original 73-session as-of window,
 * so older points cannot see today's peer coverage or scale initialization. */
function createHistoricalPeerLookup(
  ds: MarketDataset,
  mapping: Record<string, EtfMapping>,
  calendar: string[],
) {
  type Sample = { ret: number[]; breadth: number[] };
  const regions = new Map<string, Array<{ symbol: string; family: string }>>();
  const samples = new Map<string, Map<string, Map<string, Sample>>>();
  const calendarIndex = new Map(calendar.map((date, index) => [date, index]));
  const aggregates = new Map<string, Map<string, { ret: N; breadth: N }>>();
  const results = new Map<string, Map<string, N>>();
  const regionAt = (region: string, date: string) => {
    let dated = samples.get(region);
    if (!dated) {
      dated = new Map();
      samples.set(region, dated);
    }
    let families = dated.get(date);
    if (families) return families;
    let members = regions.get(region);
    if (!members) {
      members = ds.instruments
        .filter((inst) => {
          const m = mapping[inst.symbol];
          return (
            inst.instrumentType === "ETF" &&
            m?.region === region &&
            isEtfStrategyAssetClass(m) &&
            !inst.isLeveraged &&
            !inst.isInverse
          );
        })
        .map((inst) => ({
          symbol: inst.symbol,
          family: etfFamily(mapping[inst.symbol]!.underlyingIndexName),
        }));
      regions.set(region, members);
    }
    families = new Map();
    for (const member of members) {
      const sample = families.get(member.family) ?? { ret: [], breadth: [] };
      const bars = datedWindow(ds.bars[member.symbol] ?? [], date, 65);
      if (bars.at(-1)?.tradeDate === date) {
        const values = bars.map((bar) =>
          positive(bar.etfUnderlyingIndexClose) ? bar.etfUnderlyingIndexClose : null,
        );
        const ret = returns(values).at(-1),
          breadth = regime(values).breadth;
        if (finite(ret)) sample.ret.push(ret);
        if (finite(breadth)) sample.breadth.push(breadth);
      }
      families.set(member.family, sample);
    }
    dated.set(date, families);
    return families;
  };
  const aggregateAt = (region: string, family: string, date: string) => {
    const key = `${region}:${family}`;
    let dated = aggregates.get(key);
    if (!dated) {
      dated = new Map();
      aggregates.set(key, dated);
    }
    let input = dated.get(date);
    if (!input) {
      const other = [...regionAt(region, date)]
        .filter(([name]) => name !== family)
        .map(([, sample]) => sample);
      const r = other.map((sample) => median(sample.ret)).filter(finite);
      const b = other.map((sample) => median(sample.breadth)).filter(finite);
      input = { ret: r.length >= 3 ? median(r) : null, breadth: b.length >= 3 ? mean(b) : null };
      dated.set(date, input);
    }
    return input;
  };
  return (symbol: string, date: string, previousDate: string): number | undefined => {
    const m = mapping[symbol],
      end = calendarIndex.get(date),
      previous = calendarIndex.get(previousDate);
    if (!m || end === undefined || previous === undefined || previous >= end) return undefined;
    // The original peer engine creates output only for eligible regional members.
    const family = etfFamily(m.underlyingIndexName),
      key = `${m.region}:${family}`;
    if (!regionAt(m.region, previousDate).has(family)) return undefined;
    let result = results.get(key);
    if (!result) {
      result = new Map();
      results.set(key, result);
    }
    const resultKey = `${date}:${previousDate}`;
    if (result.has(resultKey)) return result.get(resultKey) ?? undefined;
    const rets: N[] = [],
      levels: N[] = [];
    let level = 1;
    for (let index = Math.max(0, end - 72); index <= previous; index++) {
      const ret = aggregateAt(m.region, family, calendar[index]!).ret;
      rets.push(ret);
      if (ret !== null) level *= 1 + ret;
      levels.push(ret === null ? null : level);
    }
    const breadth = aggregateAt(m.region, family, previousDate).breadth;
    const m20 = avg(levels, 20),
      m60 = avg(levels, 60),
      old60 = avg(levels, 60, levels.length - 6);
    const vol = sampleStd(rets.slice(-20));
    let score: N = null;
    if (
      rets.length >= 65 &&
      rets.slice(-65).every(finite) &&
      positive(m20) &&
      positive(m60) &&
      positive(old60) &&
      vol !== null &&
      breadth !== null
    ) {
      const trend = mean(
        [level / m20 - 1, level / m60 - 1, m20 / m60 - 1, m60 / old60 - 1].map((gap) =>
          smooth(gap, vol),
        ),
      );
      score = (trend + breadth) / 2;
    }
    result.set(resultKey, score);
    return score ?? undefined;
  };
}

/** Binary date lookup; indicators only need a bounded trailing window. */
function datedWindow(bars: DailyPrice[], date: string, count: number): DailyPrice[] {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.tradeDate <= date) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(Math.max(0, lo - count), lo);
}

/** Read-only historical score evaluator. Lazily prepares only the selected
 * regional peers, then reuses observations across all requested dates.
 * It does not produce entries, exits, orders, or historical signal events. */
export function createEtfScoreEvaluator(ds: MarketDataset, mapping = ETF_MAPPING) {
  const calendar = [...new Set(ds.tradeDates)].filter((d) => d <= ds.asOfDate).sort();
  const historicalPeer = createHistoricalPeerLookup(ds, mapping, calendar);
  const sectors = new Map<string, Map<string, number>>();
  const instruments = new Map(ds.instruments.map((inst) => [inst.symbol, inst]));
  const series = new Map<string, DailyPrice[]>();
  const barsFor = (symbol: string) => {
    let bars = series.get(symbol);
    if (!bars) {
      bars = (ds.bars[symbol] ?? []).filter((b) => b.tradeDate <= ds.asOfDate);
      series.set(symbol, bars);
    }
    return bars;
  };
  const sectorAt = (date: string) => {
    let v = sectors.get(date);
    if (!v) {
      v = stockSectors(ds, date);
      sectors.set(date, v);
    }
    return v;
  };
  const kospi = ds.indexSeries.find((x) => x.indexCode === "KOSPI")?.bars ?? [];
  const at = (symbol: string, date: string) => {
    const inst = instruments.get(symbol);
    if (!inst || inst.instrumentType !== "ETF") return null;
    const m = mapping[symbol];
    const all = barsFor(symbol);
    const bars = datedWindow(all, date, 120),
      last = bars.at(-1),
      prev = bars.at(-2),
      issues: string[] = [];
    const values = bars.map((b) =>
        positive(b.etfUnderlyingIndexClose) ? b.etfUnderlyingIndexClose : null,
      ),
      u = regime(values),
      ownLag = regime(values.slice(0, -1)).score;
    if (!m) issues.push("검증된 ETF 분류 없음");
    else if (!isEtfStrategyAssetClass(m) || inst.isLeveraged || inst.isInverse)
      issues.push("주식형·커버드콜 ETF 전략 대상 아님");
    if (!last || last.tradeDate !== date) issues.push("기준일 ETF 가격 없음");
    if (
      bars.length < 120 ||
      !bars.slice(-120).every((b) => b.priceSource === "TOSS_ADJUSTED_CANDLE")
    )
      issues.push("수정주가 출처·120일 이력 확인 필요");
    const technical = etfTechnical(bars),
      cap = last?.marketCapSource === "KRX_ETF" ? last.etfMarketCap : null;
    const tv = bars
      .slice(-20)
      .map((b) =>
        b.tradingValueSource === "KRX_ETF" && finite(b.etfTradingValue) && b.etfTradingValue >= 0
          ? b.etfTradingValue
          : null,
      );
    const expectedDates = calendar.filter((d) => d <= date).slice(-20);
    const actualDates = bars.slice(-20).map((b) => b.tradeDate);
    const tv20 =
      expectedDates.length === 20 && expectedDates.every((d, i) => d === actualDates[i])
        ? avg(tv, 20)
        : null;
    if (!positive(cap) || tv20 === null) issues.push("KRX 시총·20일 거래대금 필요");
    const health =
      positive(cap) && tv20 !== null
        ? (((cap >= 50e9 ? 20 : 0) + (cap >= 100e9 ? 10 : 0) + (tv20 >= 1e9 ? 20 : 0) + 10) / 60) *
          100
        : null;
    const market = datedWindow(kospi, date, 2),
      a = market.at(-1),
      b = market.at(-2);
    const daily = last && prev && positive(prev.close) ? last.close / prev.close - 1 : null;
    const marketDaily =
      a?.tradeDate === date && b && positive(b.close) ? a.close / b.close - 1 : null;
    const priority =
      m?.region === "KR"
        ? daily !== null && marketDaily !== null
          ? Number((daily - marketDaily) * 100 >= 2) * 100
          : null
        : m
          ? 0
          : null;
    let environment: N = null,
      environmentSource: EtfStrategySnapshot["environmentSource"] = "unavailable";
    if (m?.rotationSource === "domestic_stock_sector") {
      environment = sectorAt(date).get(m.stockSectorCode) ?? null;
      if (environment !== null) environmentSource = "stock_sector";
    } else if (m && prev) {
      const peer = historicalPeer(symbol, date, prev.tradeDate);
      environment = peer ?? ownLag;
      environmentSource =
        peer !== undefined ? "peer_mix_lag1" : ownLag !== null ? "own_index_lag1" : "unavailable";
    }
    if (u.score === null || ownLag === null) issues.push("기초지수 MA60·추세 이력 부족");
    if (technical === null) issues.push("기술점수 이력 부족");
    if (priority === null) issues.push("벤치마크 수익률 없음");
    if (environment === null) issues.push("환경점수 데이터 없음");
    const score =
      technical !== null && priority !== null && health !== null && environment !== null
        ? technical * (ETF_POLICY.weights.technical / 100) +
          priority * (ETF_POLICY.weights.priority / 100) +
          health * (ETF_POLICY.weights.health / 100) +
          environment * (ETF_POLICY.weights.environment / 100)
        : null;
    const vol = vol20(bars.map((b) => b.close)),
      annualVolatility = vol === null ? null : vol * Math.sqrt(252);
    return {
      score,
      averageTradingValue20: tv20,
      technical,
      priority,
      health,
      environment,
      environmentSource,
      annualVolatility,
      issues,
      u,
    };
  };
  return { at, calendar };
}
