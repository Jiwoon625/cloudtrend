// TrendScore US — 시장 게이트 → 섹터 게이트 → 종목 점수 파이프라인.
// 규칙 버전(ruleVersion)이 같고 입력이 같으면 결과가 항상 동일한 순수 함수다.
// 계산 불가능한 항목은 0점이 아니라 UNAVAILABLE로 처리하고 coverage에 반영한다.
import { bollinger, ichimoku, percentile, periodReturn, sma } from "./indicators";
import {
  US_BENCHMARKS,
  US_SECTOR_ETFS,
  sectorLabelKo,
  type UsDataset,
  type UsInstrument,
} from "./usDataset";
import type { DailyPrice } from "./types";

export const US_RULE_VERSION = "us-1.0.0";

export type ScoreStatus = "PASS" | "FAIL" | "UNAVAILABLE";
export type UsGrade = "S" | "A" | "B" | "C" | "D";
export type MarketState = "RISK_ON" | "NEUTRAL" | "RISK_OFF";
export type SectorState = "STRONG" | "NEUTRAL" | "WEAK" | "UNKNOWN";
export type ResearchPosture = "NORMAL" | "CAUTION" | "DEFENSIVE";
export type DataStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export type EligibilityStatus = "ELIGIBLE" | "NEW_LISTING" | "TACTICAL_ONLY" | "EXCLUDED";

export interface ScoreReason {
  key: string;
  label: string;
  definition: string;
  observed: string;
  threshold: string;
  points: number;
  maxPoints: number;
  status: ScoreStatus;
}

export interface UsScoreBlock {
  points: number;
  maxPoints: number;
  /** 계산 가능한 항목의 배점 합계 (결측 항목 제외) */
  availableMaxPoints: number;
  reasons: ScoreReason[];
}

export interface UsSnapshot {
  close: number;
  dayReturn: number | null;
  ma20: number | null;
  ma50: number | null;
  ma200: number | null;
  bbMiddle: number | null;
  cloudTop: number | null;
  cloudBottom: number | null;
  tenkan: number | null;
  kijun: number | null;
  volumeRatio20: number | null;
  dollarVolume60Median: number | null;
  return63: number | null;
  return126: number | null;
  return252: number | null;
  high252: number | null;
  distanceFrom252High: number | null;
  obvSlope20: number | null;
  bars: number;
}

export interface UsMarketSignal {
  key: string;
  label: string;
  observed: string;
  threshold: string;
  status: ScoreStatus;
}

export interface UsMarketGate {
  state: MarketState;
  signals: UsMarketSignal[];
  metCount: number;
  availableCount: number;
  breadthMa50: number | null;
  breadthSample: number;
  displayGradeCap: UsGrade;
  researchPosture: ResearchPosture;
  ruleVersion: string;
  incomplete: boolean;
}

export interface UsSectorGate {
  sector: string;
  label: string;
  proxyEtf: string;
  state: SectorState;
  score: number;
  availableConditions: number;
  conditions: ScoreReason[];
  excessReturn63: number | null;
  breadthMa50: number | null;
  members: number;
  displayGradeCap: UsGrade;
}

export interface UsEligibility {
  status: EligibilityStatus;
  scoreEligible: boolean;
  reasons: string[];
}

export interface UsRow {
  instrument: UsInstrument;
  snapshot: UsSnapshot;
  technical: UsScoreBlock;
  priority: UsScoreBlock;
  /** SEC 재무 데이터 미연결 → null (N/A) */
  fundamental: UsScoreBlock | null;
  etfHealth: UsScoreBlock | null;
  sectorScore: number | null;
  rawComposite: number;
  coverage: number;
  dataStatus: DataStatus;
  rawGrade: UsGrade;
  displayGrade: UsGrade;
  sectorState: SectorState;
  eligibility: UsEligibility;
}

export interface UsAnalysisResult {
  asOfDate: string;
  calculatedAt: string;
  ruleVersion: string;
  provider: string;
  dataVersion: string;
  notes: string[];
  capabilities: UsDataset["capabilities"];
  market: UsMarketGate;
  sectors: UsSectorGate[];
  rows: UsRow[];
  tradeDates: string[];
}

const GRADE_ORDER: UsGrade[] = ["D", "C", "B", "A", "S"];

function capGrade(grade: UsGrade, cap: UsGrade): UsGrade {
  return GRADE_ORDER.indexOf(grade) <= GRADE_ORDER.indexOf(cap) ? grade : cap;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function slope(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function fmt(v: number | null, digits = 2, suffix = ""): string {
  if (v === null || !Number.isFinite(v)) return "데이터 없음";
  return `${v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
}

function pct(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "데이터 없음";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

function usd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "데이터 없음";
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export function computeUsSnapshot(bars: DailyPrice[]): UsSnapshot {
  const i = bars.length - 1;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const last = bars[i]!;
  const bb = bollinger(closes, i, 20, 2);
  const ich = ichimoku(bars, i);
  const avgVol20 = sma(volumes, 20, i - 1);
  const window252 = bars.slice(Math.max(0, bars.length - 252));
  const high252 = window252.length >= 60 ? Math.max(...window252.map((b) => b.high)) : null;
  const dollar60 = bars
    .slice(Math.max(0, bars.length - 60))
    .map((b) => b.close * b.volume);

  // OBV 20일 기울기
  let obv = 0;
  const obvSeries: number[] = [];
  for (let k = 0; k < bars.length; k++) {
    if (k > 0) {
      const diff = bars[k]!.close - bars[k - 1]!.close;
      obv += diff > 0 ? bars[k]!.volume : diff < 0 ? -bars[k]!.volume : 0;
    }
    obvSeries.push(obv);
  }

  return {
    close: last.close,
    dayReturn: i > 0 ? last.close / bars[i - 1]!.close - 1 : null,
    ma20: sma(closes, 20, i),
    ma50: sma(closes, 50, i),
    ma200: sma(closes, 200, i),
    bbMiddle: bb?.middle ?? null,
    cloudTop: ich.cloudTop,
    cloudBottom: ich.cloudBottom,
    tenkan: ich.tenkan,
    kijun: ich.kijun,
    volumeRatio20: avgVol20 !== null && avgVol20 > 0 ? last.volume / avgVol20 : null,
    dollarVolume60Median: dollar60.length >= 20 ? median(dollar60) : null,
    return63: periodReturn(closes, i, 63),
    return126: periodReturn(closes, i, 126),
    return252: periodReturn(closes, i, 252),
    high252,
    distanceFrom252High: high252 !== null ? (last.close / high252 - 1) * 100 : null,
    obvSlope20: bars.length >= 21 ? slope(obvSeries.slice(-20)) : null,
    bars: bars.length,
  };
}

function boolReason(
  key: string,
  label: string,
  definition: string,
  condition: boolean | null,
  observed: string,
  threshold: string,
  maxPoints = 1,
): ScoreReason {
  return {
    key,
    label,
    definition,
    observed,
    threshold,
    maxPoints,
    points: condition === true ? maxPoints : 0,
    status: condition === null ? "UNAVAILABLE" : condition ? "PASS" : "FAIL",
  };
}

function block(reasons: ScoreReason[]): UsScoreBlock {
  return {
    reasons,
    points: reasons.reduce((a, r) => a + r.points, 0),
    maxPoints: reasons.reduce((a, r) => a + r.maxPoints, 0),
    availableMaxPoints: reasons
      .filter((r) => r.status !== "UNAVAILABLE")
      .reduce((a, r) => a + r.maxPoints, 0),
  };
}

/** Technical 7 — 미국 시장 기준(MA20/50/200) */
export function usTechnicalScore(s: UsSnapshot): UsScoreBlock {
  const cmp = (a: number | null, b: number | null): boolean | null =>
    a === null || b === null ? null : a > b;
  return block([
    boolReason(
      "ABOVE_CLOUD",
      "종가 > 일목 구름 상단",
      "일목균형표 선행스팬 1·2 중 상단보다 종가가 높은 상태.",
      cmp(s.close, s.cloudTop),
      `종가 ${fmt(s.close)} / 구름 상단 ${fmt(s.cloudTop)}`,
      "종가 > 구름 상단",
    ),
    boolReason(
      "TENKAN_KIJUN",
      "전환선 > 기준선",
      "9일 전환선이 26일 기준선 위에 있는 단기 우위 상태.",
      cmp(s.tenkan, s.kijun),
      `전환 ${fmt(s.tenkan)} / 기준 ${fmt(s.kijun)}`,
      "전환선 > 기준선",
    ),
    boolReason(
      "ABOVE_BB_MID",
      "종가 > 볼린저 중심선(20)",
      "20일 볼린저밴드 중심선(=MA20) 위 종가.",
      cmp(s.close, s.bbMiddle),
      `종가 ${fmt(s.close)} / 중심선 ${fmt(s.bbMiddle)}`,
      "종가 > BB 중심선",
    ),
    boolReason(
      "VOLUME_EXPANSION",
      "거래량 / 20일 평균 ≥ 1.2",
      "당일 거래량이 직전 20거래일 평균의 1.2배 이상.",
      s.volumeRatio20 === null ? null : s.volumeRatio20 >= 1.2,
      `${fmt(s.volumeRatio20)}배`,
      "≥ 1.2배",
    ),
    boolReason(
      "ABOVE_MA20",
      "종가 > MA20",
      "20일 이동평균 위 종가.",
      cmp(s.close, s.ma20),
      `종가 ${fmt(s.close)} / MA20 ${fmt(s.ma20)}`,
      "종가 > MA20",
    ),
    boolReason(
      "MA20_OVER_MA50",
      "MA20 > MA50",
      "중기 정배열 1단계.",
      cmp(s.ma20, s.ma50),
      `${fmt(s.ma20)} / ${fmt(s.ma50)}`,
      "MA20 > MA50",
    ),
    boolReason(
      "MA50_OVER_MA200",
      "MA50 > MA200",
      "장기 정배열(골든크로스 유지).",
      cmp(s.ma50, s.ma200),
      `${fmt(s.ma50)} / ${fmt(s.ma200)}`,
      "MA50 > MA200",
    ),
  ]);
}

export function usTechnicalGrade(points: number): "A" | "B" | "C" {
  if (points >= 6) return "A";
  if (points >= 4) return "B";
  return "C";
}

interface PeerContext {
  marketCapSorted: number[];
  dollarVolumeSorted: number[];
  excess126Sorted: number[];
  sectorExcess63Sorted: Map<string, number[]>;
  peerDollarVolumeSorted: Map<string, number[]>;
  peerAumSorted: Map<string, number[]>;
  peerSpreadSorted: Map<string, number[]>;
  spy: UsSnapshot;
  sectorSnapshots: Map<string, UsSnapshot>;
}

function topPercentile(sorted: number[], value: number | null, topShare: number): boolean | null {
  if (value === null || sorted.length < 5) return null;
  return percentile(sorted, value) >= (1 - topShare) * 100;
}

/** Stock Priority 10 */
function usStockPriority(
  inst: UsInstrument,
  s: UsSnapshot,
  ctx: PeerContext,
  capabilities: UsDataset["capabilities"],
): UsScoreBlock {
  const excess126 =
    s.return126 !== null && ctx.spy.return126 !== null ? s.return126 - ctx.spy.return126 : null;
  const sectorSnap = inst.sector ? ctx.sectorSnapshots.get(inst.sector) : undefined;
  const sectorExcess63 =
    s.return63 !== null && sectorSnap?.return63 !== undefined && sectorSnap.return63 !== null
      ? s.return63 - sectorSnap.return63
      : null;
  const sectorSorted = inst.sector ? (ctx.sectorExcess63Sorted.get(inst.sector) ?? []) : [];

  return block([
    {
      key: "INDEX_MEMBERSHIP",
      label: "주요 지수 편입",
      definition: "S&P 500·Nasdaq 100·Russell 1000 등 주요 지수 편입 여부.",
      observed: "지수 편입 데이터 미입력",
      threshold: "주요 지수 편입",
      points: 0,
      maxPoints: 2,
      status: "UNAVAILABLE",
    },
    boolReason(
      "OBV_ACCUMULATION",
      "거래량 축적 (OBV 20일 기울기 > 0)",
      "최근 20거래일 OBV 회귀 기울기가 양수인 매집 상태.",
      s.obvSlope20 === null ? null : s.obvSlope20 > 0,
      `기울기 ${s.obvSlope20 === null ? "데이터 없음" : s.obvSlope20.toExponential(2)}`,
      "> 0",
    ),
    {
      key: "SHAREHOLDER_YIELD",
      label: "Shareholder yield 양수",
      definition: "배당 + 자기주식 취득 - 주식 발행. SEC CompanyFacts 연결 후 계산.",
      observed: "SEC 데이터 미연결",
      threshold: "> 0",
      points: 0,
      maxPoints: 1,
      status: "UNAVAILABLE",
    },
    boolReason(
      "NEAR_52W_HIGH",
      "종가 ≥ 252일 고가의 95%",
      "신고가 근접도.",
      s.high252 === null ? null : s.close >= s.high252 * 0.95,
      `고가 대비 ${s.distanceFrom252High === null ? "데이터 없음" : `${s.distanceFrom252High.toFixed(2)}%`}`,
      "≥ -5%",
    ),
    boolReason(
      "SIZE",
      "시가총액 유니버스 상위 30%",
      "입력된 시가총액 기준 상대 규모.",
      capabilities.marketCap ? topPercentile(ctx.marketCapSorted, inst.marketCap, 0.3) : null,
      usd(inst.marketCap),
      "상위 30%",
    ),
    boolReason(
      "LIQUIDITY",
      "60일 median dollar volume 상위 30%",
      "거래대금 기준 유동성 상대순위.",
      topPercentile(ctx.dollarVolumeSorted, s.dollarVolume60Median, 0.3),
      usd(s.dollarVolume60Median),
      "상위 30%",
    ),
    boolReason(
      "RS_SPY_126",
      "6개월 SPY 초과수익 양수 & 상위 30%",
      "126거래일 수익률에서 SPY 수익률을 뺀 값.",
      excess126 === null
        ? null
        : excess126 > 0 && topPercentile(ctx.excess126Sorted, excess126, 0.3) === true,
      `초과수익 ${pct(excess126)}`,
      "> 0 이면서 상위 30%",
      2,
    ),
    boolReason(
      "SECTOR_LEADER_63",
      "3개월 섹터 ETF 초과수익 상위 30%",
      "동일 GICS 섹터 프록시 ETF 대비 63거래일 초과수익.",
      sectorExcess63 === null ? null : topPercentile(sectorSorted, sectorExcess63, 0.3),
      `초과수익 ${pct(sectorExcess63)}`,
      "상위 30%",
    ),
  ]);
}

/** ETF Priority 10 */
function usEtfPriority(inst: UsInstrument, s: UsSnapshot, ctx: PeerContext): UsScoreBlock {
  const peerKey = inst.sector ?? "UNCLASSIFIED";
  const excess126 =
    s.return126 !== null && ctx.spy.return126 !== null ? s.return126 - ctx.spy.return126 : null;
  const peerVol = ctx.peerDollarVolumeSorted.get(peerKey) ?? [];
  const peerAum = ctx.peerAumSorted.get(peerKey) ?? [];
  const peerSpread = ctx.peerSpreadSorted.get(peerKey) ?? [];
  const peer63 = ctx.sectorExcess63Sorted.get(peerKey) ?? [];
  const sectorSnap = inst.sector ? ctx.sectorSnapshots.get(inst.sector) : undefined;
  const peerExcess63 =
    s.return63 !== null && sectorSnap?.return63 != null ? s.return63 - sectorSnap.return63 : null;

  return block([
    boolReason(
      "RS_SPY_126",
      "6개월 SPY 대비 상대강도",
      "126거래일 수익률 - SPY 수익률 > 0.",
      excess126 === null ? null : excess126 > 0,
      `초과수익 ${pct(excess126)}`,
      "> 0",
      2,
    ),
    boolReason(
      "RS_PEER_63",
      "3개월 동종군 대비 상대강도",
      "동일 자산군(섹터) 프록시 대비 63거래일 초과수익 상위 30%.",
      peerExcess63 === null ? null : topPercentile(peer63, peerExcess63, 0.3),
      `초과수익 ${pct(peerExcess63)}`,
      "상위 30%",
      2,
    ),
    boolReason(
      "RET_252",
      "12개월 절대수익 양수",
      "252거래일 누적 수익률.",
      s.return252 === null ? null : s.return252 > 0,
      pct(s.return252),
      "> 0",
    ),
    boolReason(
      "NEAR_52W_HIGH",
      "52주 고가의 95% 이상",
      "신고가 근접도.",
      s.high252 === null ? null : s.close >= s.high252 * 0.95,
      `고가 대비 ${s.distanceFrom252High === null ? "데이터 없음" : `${s.distanceFrom252High.toFixed(2)}%`}`,
      "≥ -5%",
    ),
    boolReason(
      "VOLUME_EXPANSION",
      "거래량 / 20일 평균 ≥ 1.2",
      "거래량 확장.",
      s.volumeRatio20 === null ? null : s.volumeRatio20 >= 1.2,
      `${fmt(s.volumeRatio20)}배`,
      "≥ 1.2배",
    ),
    boolReason(
      "PEER_DOLLAR_VOLUME",
      "동종군 거래대금 상위 30%",
      "60일 median dollar volume 동종군 상대순위.",
      topPercentile(peerVol, s.dollarVolume60Median, 0.3),
      usd(s.dollarVolume60Median),
      "상위 30%",
    ),
    boolReason(
      "PEER_AUM",
      "동종군 AUM 상위 30%",
      "운용순자산 동종군 상대순위. aum 열이 없으면 N/A.",
      inst.aum === null ? null : topPercentile(peerAum, inst.aum, 0.3),
      usd(inst.aum),
      "상위 30%",
    ),
    boolReason(
      "PEER_SPREAD",
      "동종군 30일 median spread 우수 30%",
      "스프레드는 낮을수록 우수하므로 역방향 순위. spreadBps 열이 없으면 N/A.",
      inst.spreadBps === null
        ? null
        : topPercentile(
            peerSpread.map((v) => -v),
            -inst.spreadBps,
            0.3,
          ),
      inst.spreadBps === null ? "데이터 없음" : `${inst.spreadBps.toFixed(1)}bp`,
      "우수 30%",
    ),
  ]);
}

/** ETF Health 100 — 입력으로 계산 가능한 항목만 사용하고 나머지는 N/A로 남긴다. */
function usEtfHealth(inst: UsInstrument, s: UsSnapshot, ctx: PeerContext): UsScoreBlock | null {
  if (inst.securityType === "ETN") return null; // ETN은 ETF Health 대상 제외
  const peerKey = inst.sector ?? "UNCLASSIFIED";
  const peerVol = ctx.peerDollarVolumeSorted.get(peerKey) ?? [];
  const peerExpense = ctx.peerSpreadSorted.get(peerKey) ?? [];
  const structureMax = inst.leveraged || inst.inverse ? 3 : 15;

  const reasons: ScoreReason[] = [
    boolReason(
      "AUM",
      "운용순자산 규모",
      "AUM $1B 이상 만점, 입력이 없으면 N/A.",
      inst.aum === null ? null : inst.aum >= 1e9,
      usd(inst.aum),
      "≥ $1B",
      20,
    ),
    boolReason(
      "LIQUIDITY",
      "유동성 (60일 거래대금)",
      "60일 median dollar volume 동종군 상위 30% 및 $5M 이상.",
      s.dollarVolume60Median === null
        ? null
        : s.dollarVolume60Median >= 5e6 &&
          topPercentile(peerVol, s.dollarVolume60Median, 0.5) === true,
      usd(s.dollarVolume60Median),
      "≥ $5M & 동종군 상위 50%",
      10,
    ),
    boolReason(
      "SPREAD",
      "30일 median bid-ask spread",
      "10bp 이하 만점. spreadBps 열이 없으면 N/A.",
      inst.spreadBps === null ? null : inst.spreadBps <= 10,
      inst.spreadBps === null ? "데이터 없음" : `${inst.spreadBps.toFixed(1)}bp`,
      "≤ 10bp",
      10,
    ),
    {
      key: "TRACKING",
      label: "추적품질 (tracking difference·error)",
      definition: "NAV·벤치마크 시계열이 필요하며 현재 입력 경로에서 제공되지 않는다.",
      observed: "NAV/벤치마크 미연결",
      threshold: "tracking error 기준",
      points: 0,
      maxPoints: 20,
      status: "UNAVAILABLE",
    },
    boolReason(
      "EXPENSE",
      "비용 (expense ratio)",
      "0.30% 이하 만점. 입력이 없으면 N/A.",
      inst.expenseRatio === null ? null : inst.expenseRatio <= 0.3,
      inst.expenseRatio === null ? "데이터 없음" : `${inst.expenseRatio.toFixed(2)}%`,
      "≤ 0.30%",
      8,
    ),
    boolReason(
      "EXPENSE_PEER",
      "동종군 비용 percentile",
      "동종군 대비 저비용 상위 50%.",
      inst.expenseRatio === null
        ? null
        : topPercentile(
            peerExpense.map((v) => -v),
            -inst.expenseRatio,
            0.5,
          ),
      inst.expenseRatio === null ? "데이터 없음" : `${inst.expenseRatio.toFixed(2)}%`,
      "저비용 상위 50%",
      7,
    ),
    boolReason(
      "STRUCTURE",
      "구조 위험 (wrapper·레버리지·인버스)",
      "레버리지·인버스 상품은 구조점수 상한 3점(TACTICAL_ONLY).",
      !inst.leveraged && !inst.inverse && inst.securityType === "ETF",
      inst.leveraged || inst.inverse
        ? "레버리지/인버스"
        : inst.securityType === "ETF"
          ? "표준 오픈엔드 ETF"
          : inst.securityType,
      "표준 ETF 구조",
      structureMax,
    ),
    boolReason(
      "TENURE",
      "운용기간 (일봉 이력 252봉 이상)",
      "입력 일봉 이력으로 대체 측정한 상장·운용 지속성.",
      s.bars >= 252,
      `${s.bars}봉`,
      "≥ 252봉",
      10,
    ),
  ];
  return block(reasons);
}

/** Composite 40/20/30/10 — 결측 도메인은 가중치에서 제외하고 재정규화한다. */
function composite(
  technical: UsScoreBlock,
  priority: UsScoreBlock,
  quality: UsScoreBlock | null,
  sectorScore: number | null,
): { rawComposite: number; coverage: number } {
  const parts: Array<{ weight: number; value: number | null; coverage: number }> = [
    {
      weight: 0.4,
      value:
        technical.availableMaxPoints > 0
          ? (technical.points / technical.availableMaxPoints) * 100
          : null,
      coverage: technical.maxPoints > 0 ? technical.availableMaxPoints / technical.maxPoints : 0,
    },
    {
      weight: 0.2,
      value:
        priority.availableMaxPoints > 0
          ? (priority.points / priority.availableMaxPoints) * 100
          : null,
      coverage: priority.maxPoints > 0 ? priority.availableMaxPoints / priority.maxPoints : 0,
    },
    {
      weight: 0.3,
      value:
        quality && quality.availableMaxPoints > 0
          ? (quality.points / quality.availableMaxPoints) * 100
          : null,
      coverage: quality && quality.maxPoints > 0 ? quality.availableMaxPoints / quality.maxPoints : 0,
    },
    { weight: 0.1, value: sectorScore, coverage: sectorScore === null ? 0 : 1 },
  ];
  const usable = parts.filter((p) => p.value !== null);
  const weightSum = usable.reduce((a, p) => a + p.weight, 0);
  const rawComposite =
    weightSum === 0 ? 0 : usable.reduce((a, p) => a + p.weight * (p.value ?? 0), 0) / weightSum;
  const coverage = parts.reduce((a, p) => a + p.weight * p.coverage, 0);
  return { rawComposite, coverage };
}

function gradeOf(
  rawComposite: number,
  technicalPoints: number,
  coverage: number,
  marketState: MarketState,
): UsGrade {
  if (rawComposite >= 85 && technicalPoints >= 6 && coverage >= 0.9 && marketState !== "RISK_OFF")
    return "S";
  if (rawComposite >= 75) return "A";
  if (rawComposite >= 60) return "B";
  if (rawComposite >= 45) return "C";
  return "D";
}

function evaluateMarketGate(
  snapshots: Map<string, UsSnapshot>,
  breadth: { ratio: number | null; sample: number },
): UsMarketGate {
  const spy = snapshots.get("SPY");
  const qqq = snapshots.get("QQQ");
  const iwm = snapshots.get("IWM");
  const above = (s: UsSnapshot | undefined): boolean | null =>
    !s || s.ma200 === null ? null : s.close > s.ma200;

  const signals: UsMarketSignal[] = [
    {
      key: "SPY_ABOVE_MA200",
      label: "SPY 종가 > MA200",
      observed: spy ? `${fmt(spy.close)} / ${fmt(spy.ma200)}` : "데이터 없음",
      threshold: "종가 > MA200",
      status: above(spy) === null ? "UNAVAILABLE" : above(spy) ? "PASS" : "FAIL",
    },
    {
      key: "SPY_MA50_OVER_MA200",
      label: "SPY MA50 > MA200",
      observed: spy ? `${fmt(spy.ma50)} / ${fmt(spy.ma200)}` : "데이터 없음",
      threshold: "MA50 > MA200",
      status:
        !spy || spy.ma50 === null || spy.ma200 === null
          ? "UNAVAILABLE"
          : spy.ma50 > spy.ma200
            ? "PASS"
            : "FAIL",
    },
    {
      key: "QQQ_ABOVE_MA200",
      label: "QQQ 종가 > MA200",
      observed: qqq ? `${fmt(qqq.close)} / ${fmt(qqq.ma200)}` : "데이터 없음",
      threshold: "종가 > MA200",
      status: above(qqq) === null ? "UNAVAILABLE" : above(qqq) ? "PASS" : "FAIL",
    },
    {
      key: "IWM_ABOVE_MA200",
      label: "IWM 종가 > MA200",
      observed: iwm ? `${fmt(iwm.close)} / ${fmt(iwm.ma200)}` : "데이터 없음",
      threshold: "종가 > MA200",
      status: above(iwm) === null ? "UNAVAILABLE" : above(iwm) ? "PASS" : "FAIL",
    },
    {
      key: "BREADTH_MA50",
      label: "분석대상 주식 중 MA50 상회 비율",
      observed: breadth.ratio === null ? "데이터 없음" : `${breadth.ratio.toFixed(1)}% (${breadth.sample}종목)`,
      threshold: "Risk-On ≥ 55% / Risk-Off < 40%",
      status:
        breadth.ratio === null ? "UNAVAILABLE" : breadth.ratio >= 55 ? "PASS" : "FAIL",
    },
  ];

  const trendFlags = [above(spy), above(qqq), above(iwm)];
  const aboveCount = trendFlags.filter((f) => f === true).length;
  const belowCount = trendFlags.filter((f) => f === false).length;
  const spyTrend = above(spy) === true;
  const spyGolden = !!spy && spy.ma50 !== null && spy.ma200 !== null && spy.ma50 > spy.ma200;
  const breadthRatio = breadth.ratio;

  let state: MarketState = "NEUTRAL";
  if (spyTrend && spyGolden && aboveCount >= 2 && breadthRatio !== null && breadthRatio >= 55)
    state = "RISK_ON";
  else if (!spyTrend && !spyGolden && belowCount >= 2 && breadthRatio !== null && breadthRatio < 40)
    state = "RISK_OFF";

  const availableCount = signals.filter((s) => s.status !== "UNAVAILABLE").length;
  return {
    state,
    signals,
    metCount: signals.filter((s) => s.status === "PASS").length,
    availableCount,
    breadthMa50: breadthRatio,
    breadthSample: breadth.sample,
    displayGradeCap: state === "RISK_OFF" ? "B" : "S",
    researchPosture: state === "RISK_ON" ? "NORMAL" : state === "NEUTRAL" ? "CAUTION" : "DEFENSIVE",
    ruleVersion: US_RULE_VERSION,
    incomplete: availableCount < signals.length,
  };
}

export function runUsAnalysis(ds: UsDataset): UsAnalysisResult {
  const snapshots = new Map<string, UsSnapshot>();
  for (const inst of ds.instruments) {
    const bars = ds.bars[inst.symbol] ?? [];
    if (bars.length === 0) continue;
    snapshots.set(inst.symbol, computeUsSnapshot(bars));
  }
  const spy = snapshots.get("SPY");
  if (!spy) throw new Error("SPY 일봉이 없어 미국 시장 분석을 실행할 수 없습니다.");

  // ── 유니버스 자격 판정 ────────────────────────────────────────────────
  const eligibility = new Map<string, UsEligibility>();
  for (const inst of ds.instruments) {
    const s = snapshots.get(inst.symbol);
    const reasons: string[] = [];
    if (!s) {
      eligibility.set(inst.symbol, { status: "EXCLUDED", scoreEligible: false, reasons: ["일봉 없음"] });
      continue;
    }
    if (s.close < 5) reasons.push(`종가 $${s.close.toFixed(2)} < $5`);
    if (inst.assetType === "STOCK" && ds.capabilities.marketCap && inst.marketCap !== null && inst.marketCap < 3e8)
      reasons.push(`시가총액 ${usd(inst.marketCap)} < $300M`);
    if (s.dollarVolume60Median !== null && s.dollarVolume60Median < 5e6)
      reasons.push(`60일 median dollar volume ${usd(s.dollarVolume60Median)} < $5M`);

    let status: EligibilityStatus = reasons.length === 0 ? "ELIGIBLE" : "EXCLUDED";
    if (s.bars < 252) {
      status = "NEW_LISTING";
      reasons.push(`가격 이력 ${s.bars}봉 < 252봉`);
    }
    if (inst.leveraged || inst.inverse) {
      status = "TACTICAL_ONLY";
      reasons.push("레버리지·인버스 상품 — 일반 ETF와 분리해 표시");
    }
    if (inst.securityType === "ETN" || inst.securityType === "CEF") {
      reasons.push(`${inst.securityType} 구조 — ETF Health 대상 제외`);
    }
    eligibility.set(inst.symbol, {
      status,
      scoreEligible: status === "ELIGIBLE" || status === "TACTICAL_ONLY",
      reasons,
    });
  }

  // ── 시장 breadth & 게이트 ────────────────────────────────────────────
  const eligibleStocks = ds.instruments.filter(
    (i) => i.assetType === "STOCK" && eligibility.get(i.symbol)?.scoreEligible,
  );
  const breadthValues: number[] = eligibleStocks
    .map((i) => snapshots.get(i.symbol))
    .filter((s): s is UsSnapshot => !!s && s.ma50 !== null)
    .map((s) => (s.close > (s.ma50 as number) ? 1 : 0));
  const market = evaluateMarketGate(snapshots, {
    ratio:
      breadthValues.length >= 5
        ? (breadthValues.reduce((a, b) => a + b, 0) / breadthValues.length) * 100
        : null,
    sample: breadthValues.length,
  });

  // ── peer context ────────────────────────────────────────────────────
  const sectorSnapshots = new Map<string, UsSnapshot>();
  for (const { etf, sector } of US_SECTOR_ETFS) {
    const s = snapshots.get(etf);
    if (s) sectorSnapshots.set(sector, s);
  }

  const stocks = ds.instruments.filter((i) => i.assetType === "STOCK");
  const etfs = ds.instruments.filter((i) => i.assetType === "ETF");
  const sortedAsc = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

  const sectorExcess63Sorted = new Map<string, number[]>();
  const pushSectorExcess = (key: string, value: number): void => {
    const arr = sectorExcess63Sorted.get(key) ?? [];
    arr.push(value);
    sectorExcess63Sorted.set(key, arr);
  };
  for (const inst of ds.instruments) {
    const s = snapshots.get(inst.symbol);
    const key = inst.sector ?? "UNCLASSIFIED";
    const sectorSnap = inst.sector ? sectorSnapshots.get(inst.sector) : undefined;
    if (!s || s.return63 === null || sectorSnap?.return63 == null) continue;
    pushSectorExcess(key, s.return63 - sectorSnap.return63);
  }
  for (const [k, v] of sectorExcess63Sorted) sectorExcess63Sorted.set(k, sortedAsc(v));

  const groupSorted = (
    list: UsInstrument[],
    value: (i: UsInstrument) => number | null,
  ): Map<string, number[]> => {
    const map = new Map<string, number[]>();
    for (const inst of list) {
      const v = value(inst);
      if (v === null) continue;
      const key = inst.sector ?? "UNCLASSIFIED";
      const arr = map.get(key) ?? [];
      arr.push(v);
      map.set(key, arr);
    }
    for (const [k, v] of map) map.set(k, sortedAsc(v));
    return map;
  };

  const ctx: PeerContext = {
    marketCapSorted: sortedAsc(
      stocks.map((i) => i.marketCap).filter((v): v is number => v !== null),
    ),
    dollarVolumeSorted: sortedAsc(
      stocks
        .map((i) => snapshots.get(i.symbol)?.dollarVolume60Median ?? null)
        .filter((v): v is number => v !== null),
    ),
    excess126Sorted: sortedAsc(
      stocks
        .map((i) => {
          const s = snapshots.get(i.symbol);
          return s && s.return126 !== null && spy.return126 !== null
            ? s.return126 - spy.return126
            : null;
        })
        .filter((v): v is number => v !== null),
    ),
    sectorExcess63Sorted,
    peerDollarVolumeSorted: groupSorted(
      etfs,
      (i) => snapshots.get(i.symbol)?.dollarVolume60Median ?? null,
    ),
    peerAumSorted: groupSorted(etfs, (i) => i.aum),
    peerSpreadSorted: groupSorted(etfs, (i) => i.spreadBps ?? i.expenseRatio),
    spy,
    sectorSnapshots,
  };

  // ── 섹터 게이트 ─────────────────────────────────────────────────────
  const sectors: UsSectorGate[] = US_SECTOR_ETFS.map(({ etf, sector, label }) => {
    const snap = snapshots.get(etf);
    const members = ds.instruments.filter(
      (i) => i.assetType === "STOCK" && i.sector === sector && eligibility.get(i.symbol)?.scoreEligible,
    );
    const memberFlags = members
      .map((i) => snapshots.get(i.symbol))
      .filter((s): s is UsSnapshot => !!s && s.ma50 !== null)
      .map((s) => s.close > (s.ma50 as number));
    const breadth =
      memberFlags.length >= 3
        ? (memberFlags.filter(Boolean).length / memberFlags.length) * 100
        : null;
    const excess63 =
      snap && snap.return63 !== null && spy.return63 !== null ? snap.return63 - spy.return63 : null;

    const conditions: ScoreReason[] = [
      boolReason(
        "ETF_ABOVE_MA200",
        "섹터 ETF 종가 > MA200",
        "섹터 프록시 ETF의 장기 추세.",
        !snap || snap.ma200 === null ? null : snap.close > snap.ma200,
        snap ? `${fmt(snap.close)} / ${fmt(snap.ma200)}` : "데이터 없음",
        "종가 > MA200",
      ),
      boolReason(
        "ETF_MA50_OVER_MA200",
        "MA50 > MA200",
        "섹터 프록시 ETF 정배열.",
        !snap || snap.ma50 === null || snap.ma200 === null ? null : snap.ma50 > snap.ma200,
        snap ? `${fmt(snap.ma50)} / ${fmt(snap.ma200)}` : "데이터 없음",
        "MA50 > MA200",
      ),
      boolReason(
        "EXCESS_63",
        "3개월 SPY 초과수익 > 0",
        "63거래일 수익률 - SPY 수익률.",
        excess63 === null ? null : excess63 > 0,
        pct(excess63),
        "> 0",
      ),
      boolReason(
        "MEMBER_BREADTH",
        "소속 종목 MA50 상회 비율 ≥ 50%",
        "분석 대상 소속 종목의 breadth. 표본 3종목 미만이면 판단 보류.",
        breadth === null ? null : breadth >= 50,
        breadth === null ? `표본 ${memberFlags.length}종목` : `${breadth.toFixed(1)}%`,
        "≥ 50%",
      ),
    ];
    const availableConditions = conditions.filter((c) => c.status !== "UNAVAILABLE").length;
    const score = conditions.reduce((a, c) => a + c.points, 0);
    const state: SectorState =
      availableConditions === 0
        ? "UNKNOWN"
        : score >= 3
          ? "STRONG"
          : score === 2
            ? "NEUTRAL"
            : "WEAK";
    return {
      sector,
      label,
      proxyEtf: etf,
      state,
      score,
      availableConditions,
      conditions,
      excessReturn63: excess63 === null ? null : excess63 * 100,
      breadthMa50: breadth,
      members: members.length,
      displayGradeCap: state === "WEAK" ? "A" : "S",
    };
  });
  const sectorByName = new Map(sectors.map((s) => [s.sector, s]));

  // ── 종목 점수 ───────────────────────────────────────────────────────
  const rows: UsRow[] = [];
  for (const inst of ds.instruments) {
    const s = snapshots.get(inst.symbol);
    if (!s) continue;
    const technical = usTechnicalScore(s);
    const priority =
      inst.assetType === "STOCK"
        ? usStockPriority(inst, s, ctx, ds.capabilities)
        : usEtfPriority(inst, s, ctx);
    const etfHealth = inst.assetType === "ETF" ? usEtfHealth(inst, s, ctx) : null;
    const quality = inst.assetType === "STOCK" ? null : etfHealth;
    const sector = inst.sector ? sectorByName.get(inst.sector) : undefined;
    const sectorScore =
      sector && sector.availableConditions > 0
        ? (sector.score / 4) * 100
        : null;
    const { rawComposite, coverage } = composite(technical, priority, quality, sectorScore);
    const rawGrade = gradeOf(rawComposite, technical.points, coverage, market.state);
    const displayGrade = capGrade(
      capGrade(rawGrade, market.displayGradeCap),
      sector?.displayGradeCap ?? "S",
    );
    rows.push({
      instrument: inst,
      snapshot: s,
      technical,
      priority,
      fundamental: null,
      etfHealth,
      sectorScore,
      rawComposite,
      coverage,
      dataStatus: coverage >= 0.9 ? "COMPLETE" : coverage >= 0.4 ? "PARTIAL" : "UNAVAILABLE",
      rawGrade,
      displayGrade,
      sectorState: sector?.state ?? "UNKNOWN",
      eligibility: eligibility.get(inst.symbol) ?? {
        status: "EXCLUDED",
        scoreEligible: false,
        reasons: ["자격 판정 실패"],
      },
    });
  }

  rows.sort((a, b) => b.rawComposite - a.rawComposite);

  return {
    asOfDate: ds.asOfDate,
    calculatedAt: new Date().toISOString(),
    ruleVersion: US_RULE_VERSION,
    provider: ds.provider,
    dataVersion: ds.version,
    notes: ds.notes,
    capabilities: ds.capabilities,
    market,
    sectors,
    rows,
    tradeDates: ds.tradeDates,
  };
}

export function usSectorLabel(sector: string | null): string {
  return sectorLabelKo(sector);
}

export const US_BENCHMARK_SYMBOLS = US_BENCHMARKS;
