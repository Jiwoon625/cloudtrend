// 섹터 로테이션 엔진.
// 가격 리더십(추세·상대강도)과 자금흐름(실제 투자자 수급·거래대금)을 "분리해서" 계산하고,
// 두 점수를 결합한 최종 로테이션 점수·상태·4분면·섹터 간 이동 신뢰도를 산출한다.
//
// 데이터 한계 (토스증권 Open API 기준):
// - 제공: 일봉 OHLCV/거래대금, 발행주식수 기반 시가총액, 외국인·기관 순매수(수량×종가 환산)
// - 미제공: 개인/연기금/투신/보험/금융투자/사모/기타법인 수급, 외국인 보유비중,
//           ETF 설정·환매(상장좌수)·순자산총액, 유통시가총액
// 미제공 항목은 0점 처리하지 않고 가중치를 비례 재조정하며, 데이터 완전성으로 표시한다.
import { percentile, periodReturn } from "./indicators";
import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";

export interface RotationWeights {
  priceLeadership: number;
  moneyFlow: number;
  rotationMomentum: number;
}

export const DEFAULT_ROTATION_WEIGHTS: RotationWeights = {
  priceLeadership: 0.4,
  moneyFlow: 0.45,
  rotationMomentum: 0.15,
};

/** 데이터 공급자가 제공하지 않아 평가에서 제외한 항목 */
export const EXCLUDED_FLOW_ITEMS = [
  "연기금·투신·보험 등 기관 세부 주체별 수급 (공급자 미제공)",
  "개인 순매수 (공급자 미제공)",
  "외국인 보유수량·보유비중 (공급자 미제공)",
  "ETF 설정·환매/상장좌수/순자산총액 → ETF 추정 순유입 (공급자 미제공)",
  "유통 시가총액 (공급자 미제공, 전체 시가총액으로 대체)",
];

export type FlowStatus =
  | "STRONG_INFLOW"
  | "EARLY_INFLOW"
  | "SUSTAINED_INFLOW"
  | "OVERHEATED"
  | "NEUTRAL"
  | "EARLY_OUTFLOW"
  | "SUSTAINED_OUTFLOW"
  | "CAPITULATION"
  | "INSUFFICIENT_DATA";

export const FLOW_STATUS_LABEL: Record<FlowStatus, string> = {
  STRONG_INFLOW: "강한 유입",
  EARLY_INFLOW: "초기 유입",
  SUSTAINED_INFLOW: "유입 지속",
  OVERHEATED: "과열 유입",
  NEUTRAL: "중립",
  EARLY_OUTFLOW: "초기 유출",
  SUSTAINED_OUTFLOW: "유출 지속",
  CAPITULATION: "투매·과매도",
  INSUFFICIENT_DATA: "판단 보류",
};

export type Quadrant = "LEADING" | "IMPROVING" | "WEAKENING" | "LAGGING";
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  LEADING: "주도",
  IMPROVING: "개선",
  WEAKENING: "약화",
  LAGGING: "소외",
};

export interface ScoreComponent {
  label: string;
  weight: number;
  /** 0~1 정규화 값. null = 데이터 없음(가중치 재조정 대상) */
  ratio: number | null;
  detail: string;
}

export interface ComponentScore {
  /** 가용 가중치 기준으로 재조정된 0~100 점수. null = 전부 결측 */
  score: number | null;
  /** 가용 가중치 비율 0~100 */
  completeness: number;
  components: ScoreComponent[];
  missing: string[];
}

export interface SectorBreadth {
  advancing: number | null;
  up5: number | null;
  up20: number | null;
  aboveMa20: number | null;
  aboveMa60: number | null;
  aboveMa120: number | null;
  maAligned: number | null;
  newHigh52w: number | null;
  nearHigh52w: number | null;
  newLow52w: number | null;
  foreignBuy5d: number | null;
  institutionBuy5d: number | null;
  bothBuy5d: number | null;
  turnoverIncreasing: number | null;
}

export interface SectorRotationRow {
  sectorCode: string;
  sectorName: string;
  memberCount: number;
  marketCap: number | null;

  priceLeadership: ComponentScore;
  moneyFlow: ComponentScore;
  rotationMomentum: number | null;
  rotationScore: number;
  rank: number;
  prevRank: number;

  rs20: number | null;
  rs60: number | null;
  rs120: number | null;
  aboveMa20: boolean | null;
  aboveMa60: boolean | null;
  aboveMa120: boolean | null;

  equalWeightReturn20: number | null;
  capWeightReturn20: number | null;

  foreignNet1d: number | null;
  foreignNet5d: number | null;
  foreignNet20d: number | null;
  foreignNet60d: number | null;
  institutionNet1d: number | null;
  institutionNet5d: number | null;
  institutionNet20d: number | null;
  institutionNet60d: number | null;
  /** 순매수 ÷ 섹터 시가총액 (%) */
  foreignNet5dPerCap: number | null;
  institutionNet5dPerCap: number | null;
  /** 순매수 ÷ 20일 평균 거래대금 (배) */
  foreignNet5dPerTurnover: number | null;
  institutionNet5dPerTurnover: number | null;

  turnoverShare1d: number;
  turnoverShare5d: number;
  turnoverShare20d: number;
  turnoverShareChange5d: number;
  turnoverShareChange20d: number | null;
  relativeTurnover: number | null;

  breadth: SectorBreadth;
  /** 섹터 순매수 절대금액에서 1개 종목이 차지하는 비중 (%) */
  supplyConcentration: number | null;
  /** 섹터 시가총액에서 1개 종목이 차지하는 비중 (%) */
  capConcentration: number | null;

  status: FlowStatus;
  statusReason: string;
  quadrant: Quadrant;
  quadrantMove: string;
  isNextLeaderCandidate: boolean;
  isDistributionCandidate: boolean;

  prevPriceLeadership: number | null;
  prevMoneyFlow: number | null;
  priceLeadershipChange5d: number | null;
  moneyFlowChange5d: number | null;

  reliability: number;
  reliabilityTag: "HIGH" | "MEDIUM" | "CAUTION" | "LIMITED";
  anomalies: string[];
  representativeEtf: string | null;
  representativeEtfSymbol: string | null;
  dataCompleteness: number;
}

export interface RotationLink {
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  /** 0~100 로테이션 증거 점수 (금액이 아님) */
  evidenceScore: number;
  confidence: "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  outflowEvidence: string[];
  inflowEvidence: string[];
  caveats: string[];
  sentence: string;
}

export const CONFIDENCE_LABEL: Record<RotationLink["confidence"], string> = {
  VERY_HIGH: "매우 높음",
  HIGH: "높음",
  MEDIUM: "보통",
  LOW: "낮음",
  UNKNOWN: "판단 불가",
};

export interface MarketFlowState {
  state: "MARKET_INFLOW" | "ROTATION" | "MARKET_OUTFLOW" | "UNCLEAR";
  label: string;
  reasons: string[];
  foreignNet5d: number | null;
  institutionNet5d: number | null;
  turnoverChange5dPercent: number | null;
  advancingRatio: number | null;
  inflowSectorCount: number;
  outflowSectorCount: number;
}

/** 섹터 점수 시계열 한 시점 */
export interface SectorTimelinePoint {
  /** 기준일 (해당 시점 마지막 거래일) */
  date: string;
  priceLeadership: number | null;
  moneyFlow: number | null;
  /** 5일 평균 거래대금 점유율 (%) */
  turnoverShare5d: number | null;
}

export interface SectorTimeline {
  sectorCode: string;
  sectorName: string;
  points: SectorTimelinePoint[];
}

export interface SectorRotationResult {
  asOfDate: string;
  sectors: SectorRotationRow[];
  links: RotationLink[];
  market: MarketFlowState;
  commentary: string[];
  excludedItems: string[];
  weights: RotationWeights;
  overallCompleteness: number;
  /** 최근 약 5주간 5거래일 간격 점수 추이 (과거 → 현재) */
  timeline: SectorTimeline[];
}


// ───────────────────────── helpers ─────────────────────────

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

const finite = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

/** 구간 합. 하나라도 결측이면 null */
function sumWindow(values: Array<number | null>, endIndex: number, n: number): number | null {
  if (endIndex - n + 1 < 0) return null;
  let s = 0;
  for (let i = endIndex - n + 1; i <= endIndex; i++) {
    const v = values[i];
    if (!finite(v)) return null;
    s += v;
  }
  return s;
}

function avgWindow(values: number[], endIndex: number, n: number): number | null {
  const s = sumWindow(values, endIndex, n);
  return s === null ? null : s / n;
}

function ratioOf(count: number, total: number): number | null {
  return total === 0 ? null : (count / total) * 100;
}

/** 값 목록의 백분위(0~1)를 반환. 결측은 null 유지 */
function pctRatio(sortedAsc: number[], v: number | null): number | null {
  if (!finite(v) || sortedAsc.length === 0) return null;
  return percentile(sortedAsc, v) / 100;
}

interface MemberMetric {
  symbol: string;
  name: string;
  marketCap: number | null;
  r20: number | null;
  r60: number | null;
  r120: number | null;
  turnover1: number;
  turnover5: number | null;
  turnover20: number | null;
  aboveMa20: boolean | null;
  aboveMa60: boolean | null;
  aboveMa120: boolean | null;
  maAligned: boolean | null;
  newHigh: boolean | null;
  nearHigh: boolean | null;
  newLow: boolean | null;
  advancing: boolean | null;
  up5: boolean | null;
  up20: boolean | null;
  foreign1: number | null;
  foreign5: number | null;
  foreign20: number | null;
  foreign60: number | null;
  inst1: number | null;
  inst5: number | null;
  inst20: number | null;
  inst60: number | null;
  turnoverIncreasing: boolean | null;
  barCount: number;
  halted: boolean;
}

function memberMetric(symbol: string, name: string, bars: DailyPrice[], offset: number): MemberMetric | null {
  const li = bars.length - 1 - offset;
  if (li < 1) return null;
  const closes = bars.map((b) => b.close);
  const values = bars.map((b) => b.tradingValue);
  const fgn = bars.map((b) => b.foreignNetBuyValue);
  const ins = bars.map((b) => b.institutionNetBuyValue);
  const last = bars[li]!;
  const ma = (n: number) => avgWindow(closes, li, n);
  const ma20 = ma(20);
  const ma60 = ma(60);
  const ma120 = ma(120);
  const window52 = bars.slice(Math.max(0, li - 249), li + 1);
  const high52 = window52.length >= 60 ? Math.max(...window52.map((b) => b.high)) : null;
  const low52 = window52.length >= 60 ? Math.min(...window52.map((b) => b.low)) : null;
  const t5 = avgWindow(values, li, 5);
  const t20 = avgWindow(values, li, 20);
  const prev = bars[li - 1]!;
  return {
    symbol,
    name,
    marketCap: last.marketCap,
    r20: periodReturn(closes, li, 20),
    r60: periodReturn(closes, li, 60),
    r120: periodReturn(closes, li, 120),
    turnover1: last.tradingValue,
    turnover5: t5,
    turnover20: t20,
    aboveMa20: ma20 === null ? null : last.close > ma20,
    aboveMa60: ma60 === null ? null : last.close > ma60,
    aboveMa120: ma120 === null ? null : last.close > ma120,
    maAligned: ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120,
    newHigh: high52 === null ? null : last.close >= high52 * 0.999,
    nearHigh: high52 === null ? null : last.close >= high52 * 0.95,
    newLow: low52 === null ? null : last.close <= low52 * 1.001,
    advancing: prev.close > 0 ? last.close > prev.close : null,
    up5: (periodReturn(closes, li, 5) ?? null) === null ? null : periodReturn(closes, li, 5)! > 0,
    up20: (periodReturn(closes, li, 20) ?? null) === null ? null : periodReturn(closes, li, 20)! > 0,
    foreign1: finite(fgn[li]) ? fgn[li]! : null,
    foreign5: sumWindow(fgn, li, 5),
    foreign20: sumWindow(fgn, li, 20),
    foreign60: sumWindow(fgn, li, 60),
    inst1: finite(ins[li]) ? ins[li]! : null,
    inst5: sumWindow(ins, li, 5),
    inst20: sumWindow(ins, li, 20),
    inst60: sumWindow(ins, li, 60),
    turnoverIncreasing: t5 === null || t20 === null || t20 === 0 ? null : t5 > t20,
    barCount: li + 1,
    halted: last.volume === 0,
  };
}

interface RawSector {
  sectorCode: string;
  sectorName: string;
  members: MemberMetric[];
  marketCap: number | null;
  rs20: number | null;
  rs60: number | null;
  rs120: number | null;
  equalWeightReturn20: number | null;
  capWeightReturn20: number | null;
  turnoverShare1d: number;
  turnoverShare5d: number;
  turnoverShare20d: number;
  relativeTurnover: number | null;
  breadth: SectorBreadth;
  foreignNet1d: number | null;
  foreignNet5d: number | null;
  foreignNet20d: number | null;
  foreignNet60d: number | null;
  institutionNet1d: number | null;
  institutionNet5d: number | null;
  institutionNet20d: number | null;
  institutionNet60d: number | null;
  turnover20Total: number | null;
  supplyConcentration: number | null;
  capConcentration: number | null;
}

interface Frame {
  sectors: RawSector[];
  totalTurnover1: number;
  totalTurnover5: number;
  totalTurnover20: number;
  advancingRatio: number | null;
  foreignNet5d: number | null;
  institutionNet5d: number | null;
}

function sumOrNull(xs: Array<number | null>): number | null {
  const ok = xs.filter(finite);
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => a + b, 0);
}

function buildFrame(ds: MarketDataset, offset: number): Frame | null {
  const kospi = ds.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi) return null;
  const kCloses = kospi.bars.map((b) => b.close);
  const kli = kospi.bars.length - 1 - offset;
  if (kli < 1) return null;
  const mr20 = periodReturn(kCloses, kli, 20);
  const mr60 = periodReturn(kCloses, kli, 60);
  const mr120 = periodReturn(kCloses, kli, 120);

  const bySector = new Map<string, { name: string; members: MemberMetric[] }>();
  for (const inst of ds.instruments) {
    if (inst.instrumentType !== "STOCK") continue;
    const bars = ds.bars[inst.symbol] ?? [];
    const m = memberMetric(inst.symbol, inst.name, bars, offset);
    if (!m) continue;
    const key = inst.sectorCode;
    const entry = bySector.get(key) ?? { name: inst.sectorName, members: [] };
    entry.members.push(m);
    bySector.set(key, entry);
  }
  if (bySector.size === 0) return null;

  const allMembers = [...bySector.values()].flatMap((v) => v.members);
  const totalTurnover1 = allMembers.reduce((a, m) => a + m.turnover1, 0);
  const totalTurnover5 = allMembers.reduce((a, m) => a + (m.turnover5 ?? 0), 0);
  const totalTurnover20 = allMembers.reduce((a, m) => a + (m.turnover20 ?? 0), 0);
  const advancingAll = allMembers.map((m) => m.advancing).filter((v): v is boolean => v !== null);

  const sectors: RawSector[] = [...bySector.entries()].map(([code, { name, members }]) => {
    const total = members.length;
    const b = (pred: (m: MemberMetric) => boolean | null): number | null => {
      const valid = members.map(pred).filter((v): v is boolean => v !== null);
      return valid.length === 0 ? null : ratioOf(valid.filter(Boolean).length, valid.length);
    };
    const caps = members.map((m) => m.marketCap).filter(finite);
    const capSum = caps.length > 0 ? caps.reduce((a, x) => a + x, 0) : null;
    const capWeighted =
      capSum && capSum > 0
        ? members.reduce((acc, m) => {
            if (!finite(m.marketCap) || !finite(m.r20)) return acc;
            return acc + (m.marketCap / capSum) * m.r20;
          }, 0)
        : null;
    const eq20 = median(members.map((m) => m.r20).filter(finite));
    const eq60 = median(members.map((m) => m.r60).filter(finite));
    const eq120 = median(members.map((m) => m.r120).filter(finite));
    const t1 = members.reduce((a, m) => a + m.turnover1, 0);
    const t5 = members.reduce((a, m) => a + (m.turnover5 ?? 0), 0);
    const t20 = members.reduce((a, m) => a + (m.turnover20 ?? 0), 0);
    const nets5 = members.map((m) => (finite(m.foreign5) ? m.foreign5 : 0) + (finite(m.inst5) ? m.inst5 : 0));
    const absTotal = nets5.reduce((a, x) => a + Math.abs(x), 0);
    const maxAbs = nets5.length > 0 ? Math.max(...nets5.map(Math.abs)) : 0;

    return {
      sectorCode: code,
      sectorName: name,
      members,
      marketCap: capSum,
      rs20: finite(eq20) && finite(mr20) ? (eq20 - mr20) * 100 : null,
      rs60: finite(eq60) && finite(mr60) ? (eq60 - mr60) * 100 : null,
      rs120: finite(eq120) && finite(mr120) ? (eq120 - mr120) * 100 : null,
      equalWeightReturn20: finite(eq20) ? eq20 * 100 : null,
      capWeightReturn20: finite(capWeighted) ? capWeighted * 100 : null,
      turnoverShare1d: totalTurnover1 > 0 ? (t1 / totalTurnover1) * 100 : 0,
      turnoverShare5d: totalTurnover5 > 0 ? (t5 / totalTurnover5) * 100 : 0,
      turnoverShare20d: totalTurnover20 > 0 ? (t20 / totalTurnover20) * 100 : 0,
      relativeTurnover: t20 > 0 ? t5 / (t20 / 1) : null,
      breadth: {
        advancing: b((m) => m.advancing),
        up5: b((m) => m.up5),
        up20: b((m) => m.up20),
        aboveMa20: b((m) => m.aboveMa20),
        aboveMa60: b((m) => m.aboveMa60),
        aboveMa120: b((m) => m.aboveMa120),
        maAligned: b((m) => m.maAligned),
        newHigh52w: b((m) => m.newHigh),
        nearHigh52w: b((m) => m.nearHigh),
        newLow52w: b((m) => m.newLow),
        foreignBuy5d: b((m) => (finite(m.foreign5) ? m.foreign5 > 0 : null)),
        institutionBuy5d: b((m) => (finite(m.inst5) ? m.inst5 > 0 : null)),
        bothBuy5d: b((m) =>
          finite(m.foreign5) && finite(m.inst5) ? m.foreign5 > 0 && m.inst5 > 0 : null,
        ),
        turnoverIncreasing: b((m) => m.turnoverIncreasing),
      },
      foreignNet1d: sumOrNull(members.map((m) => m.foreign1)),
      foreignNet5d: sumOrNull(members.map((m) => m.foreign5)),
      foreignNet20d: sumOrNull(members.map((m) => m.foreign20)),
      foreignNet60d: sumOrNull(members.map((m) => m.foreign60)),
      institutionNet1d: sumOrNull(members.map((m) => m.inst1)),
      institutionNet5d: sumOrNull(members.map((m) => m.inst5)),
      institutionNet20d: sumOrNull(members.map((m) => m.inst20)),
      institutionNet60d: sumOrNull(members.map((m) => m.inst60)),
      turnover20Total: t20 > 0 ? t20 : null,
      supplyConcentration: absTotal > 0 ? (maxAbs / absTotal) * 100 : null,
      capConcentration:
        capSum && capSum > 0 && caps.length > 0 ? (Math.max(...caps) / capSum) * 100 : null,
      // total은 breadth 계산에만 사용
      ...(total ? {} : {}),
    };
  });

  return {
    sectors,
    totalTurnover1,
    totalTurnover5,
    totalTurnover20,
    advancingRatio:
      advancingAll.length === 0 ? null : (advancingAll.filter(Boolean).length / advancingAll.length) * 100,
    foreignNet5d: sumOrNull(sectors.map((s) => s.foreignNet5d)),
    institutionNet5d: sumOrNull(sectors.map((s) => s.institutionNet5d)),
  };
}

// ───────────────────────── 점수 ─────────────────────────

function combine(components: ScoreComponent[]): ComponentScore {
  const available = components.filter((c) => c.ratio !== null);
  const missing = components.filter((c) => c.ratio === null).map((c) => c.label);
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const availWeight = available.reduce((a, c) => a + c.weight, 0);
  const score =
    availWeight === 0
      ? null
      : (available.reduce((a, c) => a + c.weight * (c.ratio ?? 0), 0) / availWeight) * 100;
  return {
    score,
    completeness: totalWeight === 0 ? 0 : (availWeight / totalWeight) * 100,
    components,
    missing,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function scoreFrame(frame: Frame): Map<string, { price: ComponentScore; flow: ComponentScore }> {
  const s = frame.sectors;
  const sortAsc = (get: (r: RawSector) => number | null) =>
    s.map(get).filter(finite).sort((a, b) => a - b);

  const rs20s = sortAsc((r) => r.rs20);
  const rs60s = sortAsc((r) => r.rs60);
  const rs120s = sortAsc((r) => r.rs120);
  const fgnIntensity = (r: RawSector): number | null =>
    finite(r.foreignNet5d) && finite(r.turnover20Total) && r.turnover20Total > 0
      ? r.foreignNet5d / r.turnover20Total
      : null;
  const insIntensity = (r: RawSector): number | null =>
    finite(r.institutionNet5d) && finite(r.turnover20Total) && r.turnover20Total > 0
      ? r.institutionNet5d / r.turnover20Total
      : null;
  const fgnS = sortAsc(fgnIntensity);
  const insS = sortAsc(insIntensity);
  const shareChange = (r: RawSector) => r.turnoverShare5d - r.turnoverShare20d;
  const shareS = sortAsc(shareChange);

  const out = new Map<string, { price: ComponentScore; flow: ComponentScore }>();
  for (const r of s) {
    const trendFlags = [r.breadth.aboveMa20, r.breadth.aboveMa60, r.breadth.aboveMa120]
      .filter((v): v is number => v !== null)
      .map((v) => v / 100);
    const priceBreadth = [r.breadth.advancing, r.breadth.aboveMa20, r.breadth.maAligned]
      .filter((v): v is number => v !== null)
      .map((v) => v / 100);
    const price = combine([
      {
        label: "RS20 백분위",
        weight: 20,
        ratio: pctRatio(rs20s, r.rs20),
        detail: r.rs20 === null ? "데이터 없음" : `RS20 ${r.rs20.toFixed(2)}%p`,
      },
      {
        label: "RS60 백분위",
        weight: 20,
        ratio: pctRatio(rs60s, r.rs60),
        detail: r.rs60 === null ? "데이터 없음" : `RS60 ${r.rs60.toFixed(2)}%p`,
      },
      {
        label: "RS120 백분위",
        weight: 10,
        ratio: pctRatio(rs120s, r.rs120),
        detail: r.rs120 === null ? "데이터 없음" : `RS120 ${r.rs120.toFixed(2)}%p`,
      },
      {
        label: "추세 상태 (MA20/60/120 상회 비율)",
        weight: 15,
        ratio: trendFlags.length === 0 ? null : mean(trendFlags),
        detail:
          trendFlags.length === 0
            ? "데이터 없음"
            : `${(mean(trendFlags)! * 100).toFixed(0)}% 평균 상회`,
      },
      {
        label: "가격 Breadth (상승·MA20 상회·정배열)",
        weight: 20,
        ratio: priceBreadth.length === 0 ? null : mean(priceBreadth),
        detail:
          priceBreadth.length === 0
            ? "데이터 없음"
            : `${(mean(priceBreadth)! * 100).toFixed(0)}% 평균`,
      },
      {
        label: "신고가 Breadth (52주 고점 5% 이내)",
        weight: 10,
        ratio: r.breadth.nearHigh52w === null ? null : r.breadth.nearHigh52w / 100,
        detail:
          r.breadth.nearHigh52w === null ? "데이터 없음" : `${r.breadth.nearHigh52w.toFixed(1)}%`,
      },
      {
        label: "상대 거래대금 (5일/20일)",
        weight: 5,
        ratio: r.relativeTurnover === null ? null : clamp01((r.relativeTurnover - 0.7) / 0.8),
        detail:
          r.relativeTurnover === null ? "데이터 없음" : `${r.relativeTurnover.toFixed(2)}배`,
      },
    ]);

    const flow = combine([
      {
        label: "외국인 수급 강도 (5일 순매수 ÷ 20일 거래대금)",
        weight: 25,
        ratio: pctRatio(fgnS, fgnIntensity(r)),
        detail:
          fgnIntensity(r) === null
            ? "데이터 없음"
            : `${(fgnIntensity(r)! * 100).toFixed(2)}% (거래대금 대비)`,
      },
      {
        label: "기관 수급 강도 (5일 순매수 ÷ 20일 거래대금)",
        weight: 20,
        ratio: pctRatio(insS, insIntensity(r)),
        detail:
          insIntensity(r) === null
            ? "데이터 없음"
            : `${(insIntensity(r)! * 100).toFixed(2)}% (거래대금 대비)`,
      },
      {
        label: "외국인·기관 동시매수 Breadth",
        weight: 10,
        ratio: r.breadth.bothBuy5d === null ? null : r.breadth.bothBuy5d / 100,
        detail: r.breadth.bothBuy5d === null ? "데이터 없음" : `${r.breadth.bothBuy5d.toFixed(1)}%`,
      },
      {
        label: "거래대금 점유율 변화 (5일 vs 20일)",
        weight: 15,
        ratio: pctRatio(shareS, shareChange(r)),
        detail: `${shareChange(r) >= 0 ? "+" : ""}${shareChange(r).toFixed(2)}%p`,
      },
      {
        label: "연기금·투신·보험 중장기 수급",
        weight: 10,
        ratio: null,
        detail: "공급자 미제공 — 가중치 재조정",
      },
      {
        label: "ETF 추정 순유입",
        weight: 10,
        ratio: null,
        detail: "설정·환매/순자산 데이터 미제공 — 가중치 재조정",
      },
      {
        label: "외국인 보유비중 변화",
        weight: 10,
        ratio: null,
        detail: "공급자 미제공 — 가중치 재조정",
      },
    ]);
    out.set(r.sectorCode, { price, flow });
  }
  return out;
}

// ───────────────────────── 상태 판정 ─────────────────────────

function classify(input: {
  flow: number | null;
  price: number | null;
  flowChange: number | null;
  priceChange: number | null;
  shareChange5d: number;
  foreign5: number | null;
  foreign20: number | null;
  inst5: number | null;
  inst20: number | null;
  rs20: number | null;
  rs60: number | null;
  nearHighBreadth: number | null;
  relativeTurnover: number | null;
  return20: number | null;
  completeness: number;
}): { status: FlowStatus; reason: string } {
  const {
    flow,
    price,
    flowChange,
    shareChange5d,
    foreign5,
    foreign20,
    inst5,
    inst20,
    rs20,
    rs60,
    nearHighBreadth,
    relativeTurnover,
    return20,
    completeness,
  } = input;

  if (flow === null || price === null || completeness < 40)
    return { status: "INSUFFICIENT_DATA", reason: "수급·가격 데이터 부족으로 판단 보류" };

  const buy5 = (finite(foreign5) && foreign5 > 0) || (finite(inst5) && inst5 > 0);
  const sell5 = (finite(foreign5) && foreign5 < 0) || (finite(inst5) && inst5 < 0);
  const buy20 = (finite(foreign20) && foreign20 > 0) || (finite(inst20) && inst20 > 0);
  const sell20 = (finite(foreign20) && foreign20 < 0) || (finite(inst20) && inst20 < 0);
  const bothSell5 = finite(foreign5) && foreign5 < 0 && finite(inst5) && inst5 < 0;
  const bothSell20 = finite(foreign20) && foreign20 < 0 && finite(inst20) && inst20 < 0;

  if (
    price >= 70 &&
    flow >= 60 &&
    ((nearHighBreadth ?? 0) >= 50 || (relativeTurnover ?? 0) >= 1.6) &&
    (return20 ?? 0) >= 15
  )
    return { status: "OVERHEATED", reason: "가격·수급 모두 강하나 단기 급등·거래 과열로 반전 위험" };

  if (flow >= 70 && buy5 && shareChange5d > 0 && (flowChange ?? 0) >= 0)
    return { status: "STRONG_INFLOW", reason: "자금흐름 70점 이상 + 5일 순매수 + 거래대금 점유율 상승" };

  if (buy5 && buy20 && (rs20 ?? 0) > 0 && (rs60 ?? 0) > 0)
    return { status: "SUSTAINED_INFLOW", reason: "5일·20일 수급과 RS20·RS60이 모두 양호" };

  if ((flowChange ?? 0) > 5 && buy5 && !buy20 && shareChange5d > 0)
    return { status: "EARLY_INFLOW", reason: "5일 수급·점유율은 개선, 20일 수급은 아직 약함" };

  if (bothSell5 && bothSell20 && (rs20 ?? 0) < 0 && shareChange5d < 0 && (return20 ?? 0) <= -12)
    return { status: "CAPITULATION", reason: "강한 자금 유출 + 단기 낙폭 과대 (반등 가능성은 있으나 자금흐름 반전 미확인)" };

  if (sell5 && sell20 && (rs20 ?? 0) < 0 && (rs60 ?? 0) < 0 && shareChange5d < 0)
    return { status: "SUSTAINED_OUTFLOW", reason: "5일·20일 순매도 + RS 약화 + 점유율 감소" };

  if (price >= 50 && ((flowChange ?? 0) < -3 || sell5) && shareChange5d < 0)
    return { status: "EARLY_OUTFLOW", reason: "가격은 아직 강하나 수급·점유율이 먼저 약화" };

  return { status: "NEUTRAL", reason: "유입·유출 신호 혼재" };
}

function quadrantOf(price: number | null, flow: number | null): Quadrant {
  const p = price ?? 50;
  const f = flow ?? 50;
  if (p >= 50 && f >= 50) return "LEADING";
  if (p < 50 && f >= 50) return "IMPROVING";
  if (p >= 50 && f < 50) return "WEAKENING";
  return "LAGGING";
}

// ───────────────────────── 메인 ─────────────────────────

export interface RotationInput {
  /** 대표 ETF 후보: 국내 산업 섹터 ETF만(레버리지·인버스·채권·해외 제외) */
  representativeEtf: Map<string, { symbol: string; name: string }>;
  weights?: RotationWeights;
}

export function computeSectorRotation(
  ds: MarketDataset,
  input: RotationInput,
): SectorRotationResult | null {
  const weights = input.weights ?? DEFAULT_ROTATION_WEIGHTS;
  const now = buildFrame(ds, 0);
  if (!now) return null;
  const prev = buildFrame(ds, 5);
  const prev20 = buildFrame(ds, 20);
  const nowScores = scoreFrame(now);
  const prevScores = prev ? scoreFrame(prev) : null;
  const prevByCode = new Map((prev?.sectors ?? []).map((s) => [s.sectorCode, s]));
  const prev20ByCode = new Map((prev20?.sectors ?? []).map((s) => [s.sectorCode, s]));

  interface Draft extends Omit<SectorRotationRow, "rank" | "prevRank" | "rotationMomentum" | "rotationScore" | "quadrantMove" | "isNextLeaderCandidate" | "isDistributionCandidate"> {
    momentumRaw: number[];
  }

  const drafts: Draft[] = now.sectors.map((r) => {
    const sc = nowScores.get(r.sectorCode)!;
    const p = prevByCode.get(r.sectorCode);
    const pScore = p && prevScores ? prevScores.get(r.sectorCode)! : null;
    const priceNow = sc.price.score;
    const flowNow = sc.flow.score;
    const pricePrev = pScore?.price.score ?? null;
    const flowPrev = pScore?.flow.score ?? null;
    const priceChange = finite(priceNow) && finite(pricePrev) ? priceNow - pricePrev : null;
    const flowChange = finite(flowNow) && finite(flowPrev) ? flowNow - flowPrev : null;
    const shareChange5d = r.turnoverShare5d - r.turnoverShare20d;
    const shareChange20d = p ? r.turnoverShare5d - p.turnoverShare5d : null;
    const bothBreadthChange =
      finite(r.breadth.bothBuy5d) && finite(p?.breadth.bothBuy5d ?? null)
        ? r.breadth.bothBuy5d - p!.breadth.bothBuy5d!
        : null;

    const anomalies: string[] = [];
    if (r.members.length < 3) anomalies.push(`섹터 구성 종목 수 ${r.members.length}개로 통계 신뢰도 낮음`);
    if (finite(r.capConcentration) && r.capConcentration >= 50)
      anomalies.push(`단일 종목 시가총액 비중 ${r.capConcentration.toFixed(1)}% (지수 왜곡 가능)`);
    if (finite(r.supplyConcentration) && r.supplyConcentration >= 70)
      anomalies.push(`단일 종목이 섹터 순매수의 ${r.supplyConcentration.toFixed(1)}% 차지 (수급 집중도 높음)`);
    const halted = r.members.filter((m) => m.halted).length;
    if (halted > 0) anomalies.push(`거래 없음(정지 의심) 종목 ${halted}개 포함`);
    const shortHist = r.members.filter((m) => m.barCount < 120).length;
    if (shortHist > 0) anomalies.push(`과거 데이터 120봉 미만 종목 ${shortHist}개 (신규 상장 등)`);
    const eq = r.equalWeightReturn20;
    const cw = r.capWeightReturn20;
    if (finite(eq) && finite(cw) && Math.abs(eq - cw) >= 5)
      anomalies.push(
        cw > eq
          ? `대형주 집중형 상승 (시총가중 ${cw.toFixed(1)}% vs 동일가중 ${eq.toFixed(1)}%)`
          : `중소형주 확산형 상승 (동일가중 ${eq.toFixed(1)}% vs 시총가중 ${cw.toFixed(1)}%)`,
      );
    if (finite(r.breadth.advancing) && finite(cw) && r.breadth.advancing < 40 && cw > 0)
      anomalies.push("Breadth와 시가총액 흐름 불일치");

    const flowCoverage =
      r.members.length === 0
        ? 0
        : (r.members.filter((m) => finite(m.foreign5) || finite(m.inst5)).length / r.members.length) * 100;
    const priceCoverage =
      r.members.length === 0
        ? 0
        : (r.members.filter((m) => finite(m.r60)).length / r.members.length) * 100;

    const reliability = Math.max(
      0,
      Math.min(
        100,
        priceCoverage * 0.3 +
          flowCoverage * 0.3 +
          Math.min(100, r.members.length * 10) * 0.2 +
          (finite(r.capConcentration) ? Math.max(0, 100 - r.capConcentration) : 50) * 0.1 +
          (anomalies.length === 0 ? 100 : Math.max(0, 100 - anomalies.length * 20)) * 0.1,
      ),
    );
    const reliabilityTag: SectorRotationRow["reliabilityTag"] =
      reliability >= 85 ? "HIGH" : reliability >= 70 ? "MEDIUM" : reliability >= 50 ? "CAUTION" : "LIMITED";

    const status = classify({
      flow: flowNow,
      price: priceNow,
      flowChange,
      priceChange,
      shareChange5d,
      foreign5: r.foreignNet5d,
      foreign20: r.foreignNet20d,
      inst5: r.institutionNet5d,
      inst20: r.institutionNet20d,
      rs20: r.rs20,
      rs60: r.rs60,
      nearHighBreadth: r.breadth.nearHigh52w,
      relativeTurnover: r.relativeTurnover,
      return20: r.equalWeightReturn20,
      completeness: sc.flow.completeness,
    });

    const etf = input.representativeEtf.get(r.sectorCode) ?? null;

    return {
      sectorCode: r.sectorCode,
      sectorName: r.sectorName,
      memberCount: r.members.length,
      marketCap: r.marketCap,
      priceLeadership: sc.price,
      moneyFlow: sc.flow,
      rs20: r.rs20,
      rs60: r.rs60,
      rs120: r.rs120,
      aboveMa20: r.breadth.aboveMa20 === null ? null : r.breadth.aboveMa20 > 50,
      aboveMa60: r.breadth.aboveMa60 === null ? null : r.breadth.aboveMa60 > 50,
      aboveMa120: r.breadth.aboveMa120 === null ? null : r.breadth.aboveMa120 > 50,
      equalWeightReturn20: r.equalWeightReturn20,
      capWeightReturn20: r.capWeightReturn20,
      foreignNet1d: r.foreignNet1d,
      foreignNet5d: r.foreignNet5d,
      foreignNet20d: r.foreignNet20d,
      foreignNet60d: r.foreignNet60d,
      institutionNet1d: r.institutionNet1d,
      institutionNet5d: r.institutionNet5d,
      institutionNet20d: r.institutionNet20d,
      institutionNet60d: r.institutionNet60d,
      foreignNet5dPerCap:
        finite(r.foreignNet5d) && finite(r.marketCap) && r.marketCap > 0
          ? (r.foreignNet5d / r.marketCap) * 100
          : null,
      institutionNet5dPerCap:
        finite(r.institutionNet5d) && finite(r.marketCap) && r.marketCap > 0
          ? (r.institutionNet5d / r.marketCap) * 100
          : null,
      foreignNet5dPerTurnover:
        finite(r.foreignNet5d) && finite(r.turnover20Total) && r.turnover20Total > 0
          ? r.foreignNet5d / r.turnover20Total
          : null,
      institutionNet5dPerTurnover:
        finite(r.institutionNet5d) && finite(r.turnover20Total) && r.turnover20Total > 0
          ? r.institutionNet5d / r.turnover20Total
          : null,
      turnoverShare1d: r.turnoverShare1d,
      turnoverShare5d: r.turnoverShare5d,
      turnoverShare20d: r.turnoverShare20d,
      turnoverShareChange5d: shareChange5d,
      turnoverShareChange20d: prev20ByCode.get(r.sectorCode)
        ? r.turnoverShare5d - prev20ByCode.get(r.sectorCode)!.turnoverShare5d
        : shareChange20d,
      relativeTurnover: r.relativeTurnover,
      breadth: r.breadth,
      supplyConcentration: r.supplyConcentration,
      capConcentration: r.capConcentration,
      status: status.status,
      statusReason: status.reason,
      quadrant: quadrantOf(priceNow, flowNow),
      prevPriceLeadership: pricePrev,
      prevMoneyFlow: flowPrev,
      priceLeadershipChange5d: priceChange,
      moneyFlowChange5d: flowChange,
      reliability,
      reliabilityTag,
      anomalies,
      representativeEtf: etf?.name ?? null,
      representativeEtfSymbol: etf?.symbol ?? null,
      dataCompleteness: (sc.price.completeness + sc.flow.completeness) / 2,
      momentumRaw: [
        priceChange ?? Number.NaN,
        flowChange ?? Number.NaN,
        shareChange5d,
        bothBreadthChange ?? Number.NaN,
      ],
    };
  });

  // 로테이션 모멘텀: 변화량들의 섹터 간 백분위 평균
  const momentumSeries = [0, 1, 2, 3].map((i) =>
    drafts.map((d) => d.momentumRaw[i]!).filter((v) => Number.isFinite(v)).sort((a, b) => a - b),
  );
  const withMomentum = drafts.map((d) => {
    const parts = [0, 1, 2, 3]
      .map((i) => pctRatio(momentumSeries[i]!, Number.isFinite(d.momentumRaw[i]!) ? d.momentumRaw[i]! : null))
      .filter((v): v is number => v !== null);
    const momentum = parts.length === 0 ? null : (mean(parts)! * 100);
    const price = d.priceLeadership.score;
    const flow = d.moneyFlow.score;
    const w = weights;
    const items: Array<[number, number | null]> = [
      [w.priceLeadership, price],
      [w.moneyFlow, flow],
      [w.rotationMomentum, momentum],
    ];
    const availW = items.filter(([, v]) => finite(v)).reduce((a, [x]) => a + x, 0);
    const rotationScore =
      availW === 0 ? 0 : items.reduce((a, [x, v]) => a + (finite(v) ? x * v : 0), 0) / availW;
    return { ...d, rotationMomentum: momentum, rotationScore };
  });

  // 전주(5일 전) 기준 순위
  const prevRankOrder = prevScores
    ? [...prevScores.entries()]
        .map(([code, v]) => ({
          code,
          score:
            (v.price.score ?? 0) * weights.priceLeadership + (v.flow.score ?? 0) * weights.moneyFlow,
        }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.code)
    : [];

  const ranked = [...withMomentum]
    .sort((a, b) => b.rotationScore - a.rotationScore)
    .map((d, i) => {
      const prevQuadrant = quadrantOf(d.prevPriceLeadership, d.prevMoneyFlow);
      const moved = prevQuadrant !== d.quadrant;
      const isNext = prevQuadrant === "IMPROVING" && d.quadrant === "LEADING";
      const isDist = prevQuadrant === "LEADING" && d.quadrant === "WEAKENING";
      const { momentumRaw: _m, ...rest } = d;
      const row: SectorRotationRow = {
        ...rest,
        rank: i + 1,
        prevRank: prevRankOrder.indexOf(d.sectorCode) + 1 || i + 1,
        rotationMomentum: d.rotationMomentum,
        rotationScore: d.rotationScore,
        quadrantMove: moved
          ? `${QUADRANT_LABEL[prevQuadrant]} → ${QUADRANT_LABEL[d.quadrant]}`
          : `${QUADRANT_LABEL[d.quadrant]} 유지`,
        isNextLeaderCandidate: isNext || (d.quadrant === "IMPROVING" && (d.moneyFlowChange5d ?? 0) > 3),
        isDistributionCandidate: isDist || (d.quadrant === "WEAKENING" && (d.moneyFlowChange5d ?? 0) < -3),
      };
      return row;
    });

  const links = buildLinks(ranked);
  const market = marketState(now, prev, ranked);
  const commentary = buildCommentary(ranked, market);
  const overallCompleteness =
    ranked.length === 0 ? 0 : mean(ranked.map((r) => r.dataCompleteness))!;

  return {
    asOfDate: ds.asOfDate,
    sectors: ranked,
    links,
    market,
    commentary,
    excludedItems: EXCLUDED_FLOW_ITEMS,
    weights,
    overallCompleteness,
  };
}

const eok = (v: number | null): string =>
  finite(v) ? `${(v / 100_000_000).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억 원` : "데이터 없음";

function buildLinks(rows: SectorRotationRow[]): RotationLink[] {
  const outflow = rows
    .filter((r) => r.status === "EARLY_OUTFLOW" || r.status === "SUSTAINED_OUTFLOW" || r.status === "CAPITULATION")
    .sort((a, b) => (a.moneyFlow.score ?? 50) - (b.moneyFlow.score ?? 50))
    .slice(0, 3);
  const inflow = rows
    .filter((r) => r.status === "STRONG_INFLOW" || r.status === "EARLY_INFLOW" || r.status === "SUSTAINED_INFLOW")
    .sort((a, b) => (b.moneyFlow.score ?? 0) - (a.moneyFlow.score ?? 0))
    .slice(0, 3);

  const links: RotationLink[] = [];
  for (const from of outflow) {
    for (const to of inflow) {
      if (from.sectorCode === to.sectorCode) continue;
      const outEv: string[] = [];
      const inEv: string[] = [];
      if (finite(from.foreignNet5d) && from.foreignNet5d < 0)
        outEv.push(`외국인 5일 순매도 ${eok(Math.abs(from.foreignNet5d))}`);
      if (finite(from.institutionNet5d) && from.institutionNet5d < 0)
        outEv.push(`기관 5일 순매도 ${eok(Math.abs(from.institutionNet5d))}`);
      if (finite(from.foreignNet20d) && from.foreignNet20d < 0)
        outEv.push(`외국인 20일 순매도 ${eok(Math.abs(from.foreignNet20d))}`);
      if (from.turnoverShareChange5d < 0)
        outEv.push(`거래대금 점유율 ${from.turnoverShareChange5d.toFixed(2)}%p 감소`);
      if ((from.moneyFlowChange5d ?? 0) < 0)
        outEv.push(`자금흐름 점수 ${from.moneyFlowChange5d!.toFixed(1)}점 하락`);
      if ((from.priceLeadershipChange5d ?? 0) < 0)
        outEv.push(`가격 리더십 점수 ${from.priceLeadershipChange5d!.toFixed(1)}점 하락`);

      if (finite(to.foreignNet5d) && to.foreignNet5d > 0)
        inEv.push(`외국인 5일 순매수 ${eok(to.foreignNet5d)}`);
      if (finite(to.institutionNet5d) && to.institutionNet5d > 0)
        inEv.push(`기관 5일 순매수 ${eok(to.institutionNet5d)}`);
      if (finite(to.foreignNet20d) && to.foreignNet20d > 0)
        inEv.push(`외국인 20일 순매수 ${eok(to.foreignNet20d)}`);
      if (to.turnoverShareChange5d > 0)
        inEv.push(`거래대금 점유율 +${to.turnoverShareChange5d.toFixed(2)}%p 증가`);
      if ((to.moneyFlowChange5d ?? 0) > 0)
        inEv.push(`자금흐름 점수 +${to.moneyFlowChange5d!.toFixed(1)}점 상승`);
      if ((to.priceLeadershipChange5d ?? 0) > 0)
        inEv.push(`가격 리더십 점수 +${to.priceLeadershipChange5d!.toFixed(1)}점 상승`);

      const investorOpposite =
        finite(from.foreignNet5d) && finite(to.foreignNet5d) && from.foreignNet5d < 0 && to.foreignNet5d > 0
          ? 1
          : 0;
      const instOpposite =
        finite(from.institutionNet5d) &&
        finite(to.institutionNet5d) &&
        from.institutionNet5d < 0 &&
        to.institutionNet5d > 0
          ? 1
          : 0;
      const shareOpposite = from.turnoverShareChange5d < 0 && to.turnoverShareChange5d > 0 ? 1 : 0;
      const priceOpposite =
        (from.priceLeadershipChange5d ?? 0) < 0 && (to.priceLeadershipChange5d ?? 0) > 0 ? 1 : 0;
      const evidenceScore =
        (investorOpposite * 30 + instOpposite * 25 + shareOpposite * 25 + priceOpposite * 20) *
        Math.min(1, (from.reliability + to.reliability) / 200 + 0.2);

      let confidence: RotationLink["confidence"];
      if (from.dataCompleteness < 40 || to.dataCompleteness < 40) confidence = "UNKNOWN";
      else if (investorOpposite && instOpposite && shareOpposite && priceOpposite) confidence = "VERY_HIGH";
      else if ((investorOpposite || instOpposite) && shareOpposite) confidence = "HIGH";
      else if (shareOpposite || priceOpposite) confidence = "MEDIUM";
      else confidence = "LOW";

      const sentence =
        confidence === "VERY_HIGH" || confidence === "HIGH"
          ? `${from.sectorName} 비중 축소와 ${to.sectorName} 비중 확대가 동시에 관찰되어 두 섹터 간 로테이션 가능성이 높습니다.`
          : confidence === "MEDIUM"
            ? `${from.sectorName}의 상대적 약화와 ${to.sectorName}의 강세가 동시에 나타나고 있으나 직접적인 자금 이동은 추가 수급 확인이 필요합니다.`
            : confidence === "LOW"
              ? `가격 상대강도 기준으로 ${from.sectorName} → ${to.sectorName} 리더십 변화는 관찰되지만 현금 이동으로 단정할 근거는 부족합니다.`
              : `${from.sectorName}·${to.sectorName} 데이터가 부족해 로테이션 여부는 판단 보류입니다.`;

      links.push({
        fromCode: from.sectorCode,
        fromName: from.sectorName,
        toCode: to.sectorCode,
        toName: to.sectorName,
        evidenceScore,
        confidence,
        outflowEvidence: outEv,
        inflowEvidence: inEv,
        caveats: [
          "연결선은 실제 송금 경로가 아니라 동시에 관찰된 흐름에 기반한 추정입니다.",
          "신규 증시 자금, 현금화, 파생 포지션, ETF 설정·환매로 인해 두 섹터 금액이 직접 연결되지 않을 수 있습니다.",
          "직접 추적되지 않은 이동 금액은 표시하지 않습니다.",
        ],
        sentence,
      });
    }
  }
  return links.sort((a, b) => b.evidenceScore - a.evidenceScore).slice(0, 6);
}

function marketState(now: Frame, prev: Frame | null, rows: SectorRotationRow[]): MarketFlowState {
  const inflowCount = rows.filter((r) =>
    ["STRONG_INFLOW", "EARLY_INFLOW", "SUSTAINED_INFLOW", "OVERHEATED"].includes(r.status),
  ).length;
  const outflowCount = rows.filter((r) =>
    ["EARLY_OUTFLOW", "SUSTAINED_OUTFLOW", "CAPITULATION"].includes(r.status),
  ).length;
  const turnoverChange =
    prev && prev.totalTurnover5 > 0 ? ((now.totalTurnover5 - prev.totalTurnover5) / prev.totalTurnover5) * 100 : null;
  const total = sumOrNull([now.foreignNet5d, now.institutionNet5d]);
  const reasons: string[] = [];
  reasons.push(`외국인 5일 순매수 합계 ${eok(now.foreignNet5d)}`);
  reasons.push(`기관 5일 순매수 합계 ${eok(now.institutionNet5d)}`);
  if (turnoverChange !== null)
    reasons.push(`5일 평균 거래대금 5거래일 전 대비 ${turnoverChange >= 0 ? "+" : ""}${turnoverChange.toFixed(1)}%`);
  if (now.advancingRatio !== null) reasons.push(`상승 종목 비율 ${now.advancingRatio.toFixed(1)}%`);
  reasons.push(`유입 판정 섹터 ${inflowCount}개 / 유출 판정 섹터 ${outflowCount}개`);

  let state: MarketFlowState["state"] = "UNCLEAR";
  const capScale = rows.reduce((a, r) => a + (r.marketCap ?? 0), 0) || 1;
  const netRatio = finite(total) ? (total / capScale) * 10000 : null; // bp
  if (netRatio === null) state = "UNCLEAR";
  else if (netRatio > 2 && (turnoverChange ?? 0) > -5 && inflowCount >= outflowCount) state = "MARKET_INFLOW";
  else if (netRatio < -2 && outflowCount >= inflowCount) state = "MARKET_OUTFLOW";
  else if (inflowCount >= 2 && outflowCount >= 2) state = "ROTATION";
  else state = "UNCLEAR";

  return {
    state,
    label:
      state === "MARKET_INFLOW"
        ? "시장 전체 유입 국면"
        : state === "MARKET_OUTFLOW"
          ? "시장 전체 유출 국면"
          : state === "ROTATION"
            ? "섹터 순환매 국면"
            : "혼조 및 판단 보류",
    reasons,
    foreignNet5d: now.foreignNet5d,
    institutionNet5d: now.institutionNet5d,
    turnoverChange5dPercent: turnoverChange,
    advancingRatio: now.advancingRatio,
    inflowSectorCount: inflowCount,
    outflowSectorCount: outflowCount,
  };
}

function buildCommentary(rows: SectorRotationRow[], market: MarketFlowState): string[] {
  const out: string[] = [];
  const strong = rows.find((r) => r.status === "STRONG_INFLOW" || r.status === "SUSTAINED_INFLOW");
  if (strong)
    out.push(
      `${strong.sectorName}는 최근 5거래일 외국인 ${eok(strong.foreignNet5d)}, 기관 ${eok(strong.institutionNet5d)} 순매수를 기록했고 거래대금 점유율도 20일 평균 대비 ${strong.turnoverShareChange5d >= 0 ? "+" : ""}${strong.turnoverShareChange5d.toFixed(2)}%p 변화해 ${FLOW_STATUS_LABEL[strong.status]}으로 분류됩니다.`,
    );
  const weakening = rows.find((r) => r.status === "EARLY_OUTFLOW" || r.status === "SUSTAINED_OUTFLOW");
  if (weakening)
    out.push(
      `${weakening.sectorName}는 RS20 ${weakening.rs20 === null ? "데이터 없음" : `${weakening.rs20.toFixed(2)}%p`}인 가운데 외국인 20일 누적 ${eok(weakening.foreignNet20d)}, 거래대금 점유율 ${weakening.turnoverShareChange5d.toFixed(2)}%p 변화로 기존 주도주 약화 가능성이 있습니다.`,
    );
  const next = rows.find((r) => r.isNextLeaderCandidate);
  if (next)
    out.push(
      `${next.sectorName}는 가격 리더십 ${next.priceLeadership.score?.toFixed(1) ?? "판단 보류"}점보다 자금흐름 ${next.moneyFlow.score?.toFixed(1) ?? "판단 보류"}점이 먼저 개선(5일 ${next.moneyFlowChange5d === null ? "변화 미확인" : `${next.moneyFlowChange5d >= 0 ? "+" : ""}${next.moneyFlowChange5d.toFixed(1)}점`})되어 차기 주도 섹터 후보로 분류됩니다.`,
    );
  const concentrated = rows.find(
    (r) => finite(r.breadth.bothBuy5d) && r.breadth.bothBuy5d < 30 && (r.priceLeadership.score ?? 0) >= 60,
  );
  if (concentrated)
    out.push(
      `${concentrated.sectorName}는 가격 리더십 ${concentrated.priceLeadership.score!.toFixed(1)}점 대비 외국인·기관 동시매수 확산도가 ${concentrated.breadth.bothBuy5d!.toFixed(1)}%에 그쳐 단기 집중형 상승일 가능성이 있습니다.`,
    );
  out.push(
    `${market.label}: ${market.reasons.slice(0, 3).join(", ")} (유입 ${market.inflowSectorCount}개 / 유출 ${market.outflowSectorCount}개 섹터).`,
  );
  return out.slice(0, 5);
}
