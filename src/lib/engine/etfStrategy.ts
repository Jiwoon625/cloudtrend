import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import researchMapping from "./etfResearchMapping.json";

export const ETF_POLICY = {
  version: "etf-v01-m0-std20-t15-covered-call-v2",
  weights: { technical: 62.5, priority: 7.5, health: 15, environment: 15 },
  entryScore: 80,
  maxPositions: 10,
  baseWeight: 0.1,
  volatilityWindow: 20,
  volatilityTarget: 0.15,
  costBuffer: 0.0015,
  researchCutoff: "2026-09-11",
} as const;
export type EtfMapping = (typeof researchMapping)[keyof typeof researchMapping];
export const ETF_MAPPING: Record<string, EtfMapping> = researchMapping;

export function isEtfStrategyAssetClass(mapping: EtfMapping | undefined): boolean {
  return mapping?.assetClass === "equity" || mapping?.assetClass === "option_overlay";
}
type N = number | null;
export interface EtfStrategySnapshot {
  version: string;
  date: string;
  previousDate: string | null;
  eligible: boolean;
  score: N;
  previousScore: N;
  technical: N;
  priority: N;
  health: N;
  environment: N;
  environmentSource: "stock_sector" | "peer_mix_lag1" | "own_index_lag1" | "unavailable";
  region: string | null;
  sector: string | null;
  annualVolatility: N;
  entryWeight: N;
  underlyingClose: N;
  underlyingMa60: N;
  onset: boolean;
  exit: "MA60" | "DATA_UNAVAILABLE" | null;
  issues: string[];
}
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
export function etfEntryWeight(annualVolatility: N): N {
  if (!finite(annualVolatility) || annualVolatility < 0) return null;
  return annualVolatility === 0
    ? ETF_POLICY.baseWeight
    : ETF_POLICY.baseWeight * Math.min(1, ETF_POLICY.volatilityTarget / annualVolatility);
}
export function etfOrderPlan(input: {
  equity: number;
  cash: number;
  heldSymbols: string[];
  candidates: Array<{ symbol: string; price: number; strategy?: EtfStrategySnapshot | undefined }>;
}) {
  let cash = input.cash;
  const held = new Set(input.heldSymbols),
    orders: Array<{
      symbol: string;
      weight: number;
      budget: number;
      quantity: number;
      estimatedCost: number;
    }> = [];
  if (!positive(input.equity) || !finite(cash) || cash < 0 || cash > input.equity) return orders;
  const seen = new Set<string>();
  for (const c of [...input.candidates].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    if (held.size + orders.length >= ETF_POLICY.maxPositions) break;
    if (held.has(c.symbol) || seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    const s = c.strategy;
    if (!s || s.version !== ETF_POLICY.version || !s.eligible || !s.onset || !positive(c.price))
      continue;
    const weight = etfEntryWeight(s.annualVolatility);
    if (weight === null) continue;
    const budget = Math.min(cash, input.equity * weight);
    const quantity = Math.floor(budget / (c.price * (1 + ETF_POLICY.costBuffer)));
    if (quantity < 1) continue;
    const estimatedCost = quantity * c.price * (1 + ETF_POLICY.costBuffer);
    cash -= estimatedCost;
    orders.push({ symbol: c.symbol, weight, budget, quantity, estimatedCost });
  }
  return orders;
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
export function etfTechnical(bars: DailyPrice[]): N {
  const c = bars.map((b) => b.close),
    last = c.at(-1),
    m20 = avg(c, 20),
    m60 = avg(c, 60),
    m120 = avg(c, 120),
    old60 = avg(c, 60, c.length - 6),
    top = cloud(bars),
    vol = vol20(c);
  if (
    !positive(last) ||
    !positive(m20) ||
    !positive(m60) ||
    !positive(m120) ||
    !positive(old60) ||
    !positive(top) ||
    vol === null
  )
    return null;
  return mean(
    [last / top - 1, m20 / m60 - 1, m60 / m120 - 1, last / m20 - 1, m60 / old60 - 1].map((x) =>
      smooth(x, vol),
    ),
  );
}
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
export function etfFamily(name: string): string {
  const t = name.toUpperCase().replace(/[^A-Z0-9가-힣]/g, "");
  const patterns: Array<[RegExp, string]> = [
    [/코스피200|KOSPI200/, "KOSPI200"],
    [/코스닥150|KOSDAQ150/, "KOSDAQ150"],
    [/SP500/, "SP500"],
    [/NASDAQ100|나스닥100/, "NASDAQ100"],
    [/CSI300/, "CSI300"],
    [/TOPIX/, "TOPIX"],
    [/NIKKEI225/, "NIKKEI225"],
    [/NIFTY50/, "NIFTY50"],
    [/HANGSENGCHINAH/, "HSCEI"],
    [/HANGSENGTECH/, "HSTECH"],
    [/DOWJONESUSDIVIDEND100/, "US_DIV100"],
  ];
  for (const [p, key] of patterns)
    if (
      p.test(t) &&
      !(
        ["KOSPI200", "KOSDAQ150"].includes(key) &&
        /정보기술|바이오|헬스|소재|건설|중공업|금융|에너지|소비/.test(t)
      )
    )
      return key;
  return t.replace(/PRICERETURN|TOTALRETURN|시장가격지수|시장가격|지수|INDEX|\(PR\)|\(TR\)/g, "");
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
  const market =
    ds.indexSeries.find((x) => x.indexCode === "KOSPI")?.bars.filter((b) => b.tradeDate <= date) ??
    [];
  if (market.at(-1)?.tradeDate !== date) return new Map();
  const m = priceFeatures(market),
    groups = new Map<string, ReturnType<typeof priceFeatures>[]>();
  for (const inst of ds.instruments) {
    if (inst.instrumentType !== "STOCK") continue;
    const bars = (ds.bars[inst.symbol] ?? []).filter((b) => b.tradeDate <= date);
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

/** Regional returns are equal-family medians, exclude the target's own family.
 * Only the last 70 regional observations are needed; multiplicative levels are scale invariant. */
function peerEnvironments(ds: MarketDataset, mapping: Record<string, EtfMapping>) {
  const dates = ds.tradeDates.filter((d) => d <= ds.asOfDate).slice(-73),
    validDates = new Set(dates);
  const groups = new Map<string, Map<string, Map<string, { ret: number[]; breadth: number[] }>>>();
  for (const inst of ds.instruments) {
    const m = mapping[inst.symbol];
    if (
      inst.instrumentType !== "ETF" ||
      !isEtfStrategyAssetClass(m) ||
      inst.isLeveraged ||
      inst.isInverse
    )
      continue;
    const bars = (ds.bars[inst.symbol] ?? []).filter((b) => b.tradeDate <= ds.asOfDate),
      family = etfFamily(m.underlyingIndexName);
    let region = groups.get(m.region);
    if (!region) {
      region = new Map();
      groups.set(m.region, region);
    }
    let byDate = region.get(family);
    if (!byDate) {
      byDate = new Map();
      region.set(family, byDate);
    }
    for (let i = Math.max(0, bars.length - 80); i < bars.length; i++) {
      const b = bars[i]!;
      if (!validDates.has(b.tradeDate)) continue;
      const values = bars
        .slice(Math.max(0, i - 64), i + 1)
        .map((x) => (positive(x.etfUnderlyingIndexClose) ? x.etfUnderlyingIndexClose : null));
      const r = returns(values).at(-1),
        breadth = regime(values).breadth;
      const v = byDate.get(b.tradeDate) ?? { ret: [], breadth: [] };
      if (finite(r)) v.ret.push(r);
      if (finite(breadth)) v.breadth.push(breadth);
      byDate.set(b.tradeDate, v);
    }
  }
  const out = new Map<string, Map<string, number>>();
  for (const [region, families] of groups)
    for (const family of families.keys()) {
      const rets: N[] = [],
        levels: N[] = [];
      let level = 1;
      const byDate = new Map<string, number>();
      for (const date of dates) {
        const other = [...families].filter(([f]) => f !== family).map(([, v]) => v.get(date));
        const r = other.map((v) => median(v?.ret ?? [])).filter(finite),
          b = other.map((v) => median(v?.breadth ?? [])).filter(finite);
        const ret = r.length >= 3 ? median(r) : null;
        rets.push(ret);
        if (ret !== null) level *= 1 + ret;
        levels.push(ret === null ? null : level);
        const m20 = avg(levels, 20),
          m60 = avg(levels, 60),
          old60 = avg(levels, 60, levels.length - 6),
          vol = sampleStd(rets.slice(-20));
        if (
          rets.length < 65 ||
          !rets.slice(-65).every(finite) ||
          !positive(m20) ||
          !positive(m60) ||
          !positive(old60) ||
          vol === null ||
          b.length < 3
        )
          continue;
        const trend = mean(
          [level / m20 - 1, level / m60 - 1, m20 / m60 - 1, m60 / old60 - 1].map((x) =>
            smooth(x, vol),
          ),
        );
        byDate.set(date, (trend + mean(b)) / 2);
      }
      out.set(`${region}:${family}`, byDate);
    }
  return out;
}

export function calculateEtfStrategies(
  ds: MarketDataset,
  mapping = ETF_MAPPING,
): Map<string, EtfStrategySnapshot> {
  const out = new Map<string, EtfStrategySnapshot>(),
    peers = peerEnvironments(ds, mapping),
    sectors = new Map<string, Map<string, number>>();
  const calendar = ds.tradeDates.filter((d) => d <= ds.asOfDate),
    previousDate = calendar.at(-2) ?? null;
  const sectorAt = (date: string) => {
    let v = sectors.get(date);
    if (!v) {
      v = stockSectors(ds, date);
      sectors.set(date, v);
    }
    return v;
  };
  const kospi = ds.indexSeries.find((x) => x.indexCode === "KOSPI")?.bars ?? [];
  for (const inst of ds.instruments) {
    if (inst.instrumentType !== "ETF") continue;
    const m = mapping[inst.symbol],
      all = (ds.bars[inst.symbol] ?? []).filter((b) => b.tradeDate <= ds.asOfDate);
    const at = (date: string) => {
      const bars = all.filter((b) => b.tradeDate <= date),
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
      const tv20 = avg(tv, 20);
      if (!positive(cap) || tv20 === null) issues.push("KRX 시총·20일 거래대금 필요");
      const health =
        positive(cap) && tv20 !== null
          ? (((cap >= 50e9 ? 20 : 0) + (cap >= 100e9 ? 10 : 0) + (tv20 >= 1e9 ? 20 : 0) + 10) /
              60) *
            100
          : null;
      const market = kospi.filter((b) => b.tradeDate <= date),
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
        const peer = peers
          .get(`${m.region}:${etfFamily(m.underlyingIndexName)}`)
          ?.get(prev.tradeDate);
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
          ? technical * 0.625 + priority * 0.075 + health * 0.15 + environment * 0.15
          : null;
      const vol = vol20(bars.map((b) => b.close)),
        annualVolatility = vol === null ? null : vol * Math.sqrt(252);
      return {
        score,
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
    const current = at(ds.asOfDate),
      previous = previousDate ? at(previousDate) : null;
    const eligible = current.issues.length === 0 && current.score !== null;
    out.set(inst.symbol, {
      version: ETF_POLICY.version,
      date: ds.asOfDate,
      previousDate,
      eligible,
      score: current.score,
      previousScore: previous?.score ?? null,
      technical: current.technical,
      priority: current.priority,
      health: current.health,
      environment: current.environment,
      environmentSource: current.environmentSource,
      region: m?.region ?? null,
      sector: m?.sectorCode ?? null,
      annualVolatility: current.annualVolatility,
      entryWeight: eligible ? etfEntryWeight(current.annualVolatility) : null,
      underlyingClose: current.u.close,
      underlyingMa60: current.u.ma60,
      onset:
        eligible &&
        previous?.score !== null &&
        previous?.score !== undefined &&
        all.some((b) => b.tradeDate === previousDate) &&
        previous.score < 80 &&
        current.score! >= 80,
      exit:
        all.at(-1)?.tradeDate !== ds.asOfDate || current.u.close === null || current.u.ma60 === null
          ? "DATA_UNAVAILABLE"
          : current.u.close < current.u.ma60
            ? "MA60"
            : null,
      issues: current.issues,
    });
  }
  return out;
}
