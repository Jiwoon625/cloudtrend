import type { MarketDataset } from "../src/lib/engine/dataset";
import { DEFAULT_ROTATION_WEIGHTS } from "../src/lib/engine/sectorRotation";
import { buildFullUniverseSectorDataset } from "../src/lib/engine/sectorRotationFullUniverse";
import { THEME_SECTORS } from "../src/lib/engine/sectors";
import type { DailyPrice, Instrument } from "../src/lib/engine/types";

interface Prepared {
  instrument: Instrument;
  bars: DailyPrice[];
  dateIndex: Map<string, number>;
  closePrefix: number[];
  turnoverPrefix: number[];
  foreignPrefix: number[];
  foreignMissingPrefix: number[];
  institutionPrefix: number[];
  institutionMissingPrefix: number[];
  rollingHigh250: number[];
}

interface MemberMetric {
  r20: number | null;
  r60: number | null;
  r120: number | null;
  turnover5: number | null;
  turnover20: number | null;
  aboveMa20: boolean | null;
  aboveMa60: boolean | null;
  aboveMa120: boolean | null;
  maAligned: boolean | null;
  nearHigh: boolean | null;
  advancing: boolean | null;
  foreign5: number | null;
  institution5: number | null;
}

interface Agg {
  sectorCode: string;
  sectorName: string;
  r20: number[];
  r60: number[];
  r120: number[];
  turnover5: number;
  turnover20: number;
  turnover5Count: number;
  turnover20Count: number;
  aboveMa20True: number;
  aboveMa20Valid: number;
  aboveMa60True: number;
  aboveMa60Valid: number;
  aboveMa120True: number;
  aboveMa120Valid: number;
  maAlignedTrue: number;
  maAlignedValid: number;
  nearHighTrue: number;
  nearHighValid: number;
  advancingTrue: number;
  advancingValid: number;
  foreign5Sum: number;
  foreign5Valid: number;
  institution5Sum: number;
  institution5Valid: number;
  bothBuyTrue: number;
  bothBuyValid: number;
}

interface RawSector {
  sectorCode: string;
  sectorName: string;
  rs20: number | null;
  rs60: number | null;
  rs120: number | null;
  turnoverShare5: number;
  turnoverShare20: number;
  relativeTurnover: number | null;
  advancing: number | null;
  aboveMa20: number | null;
  aboveMa60: number | null;
  aboveMa120: number | null;
  maAligned: number | null;
  nearHigh: number | null;
  bothBuy5: number | null;
  foreign5: number | null;
  institution5: number | null;
  turnover20Total: number | null;
}

interface LevelScore {
  sectorCode: string;
  price: number | null;
  flow: number | null;
  turnoverShareDiff: number;
  bothBuy5: number | null;
}

const finite = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

function mean(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = Math.floor((sorted.length - 1) / 2);
  const hi = Math.ceil((sorted.length - 1) / 2);
  return (sorted[lo]! + sorted[hi]!) / 2;
}

function prefix(values: number[]) {
  const out = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!;
  return out;
}

function nullablePrefix(values: Array<number | null>) {
  const sum = new Array<number>(values.length + 1).fill(0);
  const missing = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum[i + 1] = sum[i]! + (finite(v) ? v : 0);
    missing[i + 1] = missing[i]! + (finite(v) ? 0 : 1);
  }
  return { sum, missing };
}

function windowSum(sum: number[], end: number, period: number) {
  const start = end - period + 1;
  return start < 0 ? null : sum[end + 1]! - sum[start]!;
}

function nullableWindowSum(sum: number[], missing: number[], end: number, period: number) {
  const start = end - period + 1;
  if (start < 0) return null;
  if (missing[end + 1]! - missing[start]! > 0) return null;
  return sum[end + 1]! - sum[start]!;
}

function rollingHigh(bars: DailyPrice[], window = 250, minimum = 60) {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  const deque: number[] = [];
  let head = 0;
  for (let i = 0; i < bars.length; i++) {
    while (head < deque.length && deque[head]! < i - window + 1) head++;
    while (deque.length > head && bars[deque[deque.length - 1]!]!.high <= bars[i]!.high) deque.pop();
    deque.push(i);
    if (i >= minimum - 1) out[i] = bars[deque[head]!]!.high;
    if (head > 256 && head * 2 > deque.length) {
      deque.splice(0, head);
      head = 0;
    }
  }
  return out;
}

function prepare(instrument: Instrument, bars: DailyPrice[]): Prepared {
  const foreign = nullablePrefix(bars.map((b) => b.foreignNetBuyValue));
  const institution = nullablePrefix(bars.map((b) => b.institutionNetBuyValue));
  return {
    instrument,
    bars,
    dateIndex: new Map(bars.map((b, i) => [b.tradeDate, i])),
    closePrefix: prefix(bars.map((b) => b.close)),
    turnoverPrefix: prefix(bars.map((b) => b.tradingValue)),
    foreignPrefix: foreign.sum,
    foreignMissingPrefix: foreign.missing,
    institutionPrefix: institution.sum,
    institutionMissingPrefix: institution.missing,
    rollingHigh250: rollingHigh(bars),
  };
}

function periodReturn(bars: DailyPrice[], end: number, period: number) {
  const past = bars[end - period]?.close;
  const current = bars[end]?.close;
  return finite(past) && finite(current) && past > 0 ? current / past - 1 : null;
}

function memberMetric(item: Prepared, date: string): MemberMetric | null {
  const i = item.dateIndex.get(date);
  if (i === undefined || i < 1) return null;
  const bar = item.bars[i]!;
  const avg = (p: number) => {
    const v = windowSum(item.closePrefix, i, p);
    return v === null ? null : v / p;
  };
  const turnoverAvg = (p: number) => {
    const v = windowSum(item.turnoverPrefix, i, p);
    return v === null ? null : v / p;
  };
  const ma20 = avg(20), ma60 = avg(60), ma120 = avg(120);
  const high = item.rollingHigh250[i];
  return {
    r20: periodReturn(item.bars, i, 20),
    r60: periodReturn(item.bars, i, 60),
    r120: periodReturn(item.bars, i, 120),
    turnover5: turnoverAvg(5),
    turnover20: turnoverAvg(20),
    aboveMa20: ma20 === null ? null : bar.close > ma20,
    aboveMa60: ma60 === null ? null : bar.close > ma60,
    aboveMa120: ma120 === null ? null : bar.close > ma120,
    maAligned: ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120,
    nearHigh: Number.isFinite(high) ? bar.close >= high * 0.95 : null,
    advancing: bar.close > item.bars[i - 1]!.close,
    foreign5: nullableWindowSum(item.foreignPrefix, item.foreignMissingPrefix, i, 5),
    institution5: nullableWindowSum(item.institutionPrefix, item.institutionMissingPrefix, i, 5),
  };
}

function createAgg(code: string, name: string): Agg {
  return {
    sectorCode: code, sectorName: name, r20: [], r60: [], r120: [], turnover5: 0, turnover20: 0,
    turnover5Count: 0, turnover20Count: 0, aboveMa20True: 0, aboveMa20Valid: 0,
    aboveMa60True: 0, aboveMa60Valid: 0, aboveMa120True: 0, aboveMa120Valid: 0,
    maAlignedTrue: 0, maAlignedValid: 0, nearHighTrue: 0, nearHighValid: 0,
    advancingTrue: 0, advancingValid: 0, foreign5Sum: 0, foreign5Valid: 0,
    institution5Sum: 0, institution5Valid: 0, bothBuyTrue: 0, bothBuyValid: 0,
  };
}

function addBool(agg: Agg, key: "aboveMa20" | "aboveMa60" | "aboveMa120" | "maAligned" | "nearHigh" | "advancing", value: boolean | null) {
  if (value === null) return;
  (agg[`${key}True` as keyof Agg] as number) += value ? 1 : 0;
  (agg[`${key}Valid` as keyof Agg] as number) += 1;
}

function ratio(t: number, n: number) {
  return n > 0 ? t / n * 100 : null;
}

function buildRawDay(prepared: Prepared[], sectorDefs: Array<{ code: string; name: string }>, date: string, kospiBars: DailyPrice[], marketIndex: number): RawSector[] {
  const allowed = new Set(sectorDefs.map((s) => s.code));
  const names = new Map(sectorDefs.map((s) => [s.code, s.name]));
  const aggs = new Map<string, Agg>();
  for (const item of prepared) {
    const code = item.instrument.sectorCode;
    if (!allowed.has(code)) continue;
    const metric = memberMetric(item, date);
    if (!metric) continue;
    const agg = aggs.get(code) ?? createAgg(code, names.get(code) ?? item.instrument.sectorName);
    if (finite(metric.r20)) agg.r20.push(metric.r20);
    if (finite(metric.r60)) agg.r60.push(metric.r60);
    if (finite(metric.r120)) agg.r120.push(metric.r120);
    if (finite(metric.turnover5)) { agg.turnover5 += metric.turnover5; agg.turnover5Count++; }
    if (finite(metric.turnover20)) { agg.turnover20 += metric.turnover20; agg.turnover20Count++; }
    addBool(agg, "aboveMa20", metric.aboveMa20);
    addBool(agg, "aboveMa60", metric.aboveMa60);
    addBool(agg, "aboveMa120", metric.aboveMa120);
    addBool(agg, "maAligned", metric.maAligned);
    addBool(agg, "nearHigh", metric.nearHigh);
    addBool(agg, "advancing", metric.advancing);
    if (finite(metric.foreign5)) { agg.foreign5Sum += metric.foreign5; agg.foreign5Valid++; }
    if (finite(metric.institution5)) { agg.institution5Sum += metric.institution5; agg.institution5Valid++; }
    if (finite(metric.foreign5) && finite(metric.institution5)) {
      agg.bothBuyValid++;
      if (metric.foreign5 > 0 && metric.institution5 > 0) agg.bothBuyTrue++;
    }
    aggs.set(code, agg);
  }
  const mr20 = periodReturn(kospiBars, marketIndex, 20);
  const mr60 = periodReturn(kospiBars, marketIndex, 60);
  const mr120 = periodReturn(kospiBars, marketIndex, 120);
  const complete = sectorDefs.map((s) => aggs.get(s.code)).filter((x): x is Agg => !!x);
  const total5 = complete.reduce((s, a) => s + (a.turnover5Count ? a.turnover5 : 0), 0);
  const total20 = complete.reduce((s, a) => s + (a.turnover20Count ? a.turnover20 : 0), 0);
  return complete.map((a) => {
    const eq20 = median(a.r20), eq60 = median(a.r60), eq120 = median(a.r120);
    return {
      sectorCode: a.sectorCode,
      sectorName: a.sectorName,
      rs20: finite(eq20) && finite(mr20) ? (eq20 - mr20) * 100 : null,
      rs60: finite(eq60) && finite(mr60) ? (eq60 - mr60) * 100 : null,
      rs120: finite(eq120) && finite(mr120) ? (eq120 - mr120) * 100 : null,
      turnoverShare5: total5 > 0 ? a.turnover5 / total5 * 100 : 0,
      turnoverShare20: total20 > 0 ? a.turnover20 / total20 * 100 : 0,
      relativeTurnover: a.turnover5Count && a.turnover20Count && a.turnover20 > 0 ? a.turnover5 / a.turnover20 : null,
      advancing: ratio(a.advancingTrue, a.advancingValid),
      aboveMa20: ratio(a.aboveMa20True, a.aboveMa20Valid),
      aboveMa60: ratio(a.aboveMa60True, a.aboveMa60Valid),
      aboveMa120: ratio(a.aboveMa120True, a.aboveMa120Valid),
      maAligned: ratio(a.maAlignedTrue, a.maAlignedValid),
      nearHigh: ratio(a.nearHighTrue, a.nearHighValid),
      bothBuy5: ratio(a.bothBuyTrue, a.bothBuyValid),
      foreign5: a.foreign5Valid ? a.foreign5Sum : null,
      institution5: a.institution5Valid ? a.institution5Sum : null,
      turnover20Total: a.turnover20Count && a.turnover20 > 0 ? a.turnover20 : null,
    };
  });
}

function percentileRatio(sorted: number[], value: number | null) {
  if (!finite(value) || !sorted.length) return null;
  let below = 0;
  for (const x of sorted) if (x < value) below++;
  return below / sorted.length;
}

function combine(parts: Array<{ weight: number; ratio: number | null }>) {
  const available = parts.filter((p) => finite(p.ratio));
  const weight = available.reduce((s, p) => s + p.weight, 0);
  return weight ? available.reduce((s, p) => s + p.weight * (p.ratio ?? 0), 0) / weight * 100 : null;
}

function avgRatios(values: Array<number | null>) {
  const valid = values.filter(finite).map((v) => v / 100);
  return mean(valid);
}

function scoreLevel(raw: RawSector[]): LevelScore[] {
  const sorted = (getter: (r: RawSector) => number | null) => raw.map(getter).filter(finite).sort((a, b) => a - b);
  const rs20 = sorted((r) => r.rs20), rs60 = sorted((r) => r.rs60), rs120 = sorted((r) => r.rs120);
  const foreignIntensity = (r: RawSector) => finite(r.foreign5) && finite(r.turnover20Total) && r.turnover20Total > 0 ? r.foreign5 / r.turnover20Total : null;
  const institutionIntensity = (r: RawSector) => finite(r.institution5) && finite(r.turnover20Total) && r.turnover20Total > 0 ? r.institution5 / r.turnover20Total : null;
  const foreigns = sorted(foreignIntensity), institutions = sorted(institutionIntensity);
  const shareDiff = (r: RawSector) => r.turnoverShare5 - r.turnoverShare20;
  const shares = sorted(shareDiff);
  return raw.map((r) => {
    const trend = avgRatios([r.aboveMa20, r.aboveMa60, r.aboveMa120]);
    const breadth = avgRatios([r.advancing, r.aboveMa20, r.maAligned]);
    const price = combine([
      { weight: 20, ratio: percentileRatio(rs20, r.rs20) },
      { weight: 20, ratio: percentileRatio(rs60, r.rs60) },
      { weight: 10, ratio: percentileRatio(rs120, r.rs120) },
      { weight: 15, ratio: trend },
      { weight: 20, ratio: breadth },
      { weight: 10, ratio: r.nearHigh === null ? null : r.nearHigh / 100 },
      { weight: 5, ratio: r.relativeTurnover === null ? null : Math.min(1, Math.max(0, (r.relativeTurnover - 0.7) / 0.8)) },
    ]);
    const flow = combine([
      { weight: 25, ratio: percentileRatio(foreigns, foreignIntensity(r)) },
      { weight: 20, ratio: percentileRatio(institutions, institutionIntensity(r)) },
      { weight: 10, ratio: r.bothBuy5 === null ? null : r.bothBuy5 / 100 },
      { weight: 15, ratio: percentileRatio(shares, shareDiff(r)) },
      { weight: 10, ratio: null }, { weight: 10, ratio: null }, { weight: 10, ratio: null },
    ]);
    return { sectorCode: r.sectorCode, price, flow, turnoverShareDiff: shareDiff(r), bothBuy5: r.bothBuy5 };
  });
}

export function buildHistoricalRotationScoreMap(input: MarketDataset) {
  const dataset = buildFullUniverseSectorDataset(input);
  const kospi = dataset.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi) return new Map<string, number>();
  const availableCodes = new Set(dataset.instruments.filter((i) => i.instrumentType === "STOCK").map((i) => i.sectorCode));
  const sectorDefs = THEME_SECTORS.filter((s) => s.code !== "MARKET_IDX" && s.code !== "ETC" && availableCodes.has(s.code));
  const prepared = dataset.instruments
    .filter((i) => i.instrumentType === "STOCK" && sectorDefs.some((s) => s.code === i.sectorCode))
    .map((i) => prepare(i, dataset.bars[i.symbol] ?? []))
    .filter((p) => p.bars.length > 1);
  const levelByIndex = new Map<number, LevelScore[]>();
  const out = new Map<string, number>();
  for (let marketIndex = 120; marketIndex < kospi.bars.length; marketIndex++) {
    const date = kospi.bars[marketIndex]!.tradeDate;
    const raw = buildRawDay(prepared, sectorDefs, date, kospi.bars, marketIndex);
    if (raw.length !== sectorDefs.length) continue;
    const level = scoreLevel(raw);
    levelByIndex.set(marketIndex, level);
    const prev = levelByIndex.get(marketIndex - 5);
    if (!prev) continue;
    const prevByCode = new Map(prev.map((x) => [x.sectorCode, x]));
    const drafts = level.map((cur) => {
      const p = prevByCode.get(cur.sectorCode);
      return {
        ...cur,
        momentumParts: [
          finite(cur.price) && finite(p?.price) ? cur.price - p.price : null,
          finite(cur.flow) && finite(p?.flow) ? cur.flow - p.flow : null,
          cur.turnoverShareDiff,
          finite(cur.bothBuy5) && finite(p?.bothBuy5) ? cur.bothBuy5 - p.bothBuy5 : null,
        ],
      };
    });
    const momentumSeries = [0, 1, 2, 3].map((part) => drafts.map((d) => d.momentumParts[part]).filter(finite).sort((a, b) => a - b));
    for (const draft of drafts) {
      const ratios = draft.momentumParts.map((v, part) => percentileRatio(momentumSeries[part]!, v)).filter(finite);
      const momentum = ratios.length ? mean(ratios)! * 100 : null;
      const items: Array<[number, number | null]> = [
        [DEFAULT_ROTATION_WEIGHTS.priceLeadership, draft.price],
        [DEFAULT_ROTATION_WEIGHTS.moneyFlow, draft.flow],
        [DEFAULT_ROTATION_WEIGHTS.rotationMomentum, momentum],
      ];
      const availableWeight = items.filter(([, v]) => finite(v)).reduce((s, [w]) => s + w, 0);
      const rotationScore = availableWeight
        ? items.reduce((s, [w, v]) => s + (finite(v) ? w * v : 0), 0) / availableWeight
        : 0;
      out.set(`${date}|${draft.sectorCode}`, rotationScore);
    }
  }
  return out;
}
