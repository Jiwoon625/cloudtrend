// 점수 산정 엔진: 실격 필터 / 시장 게이트 / 점수를 분리한다. 전부 순수 함수.
import type { IndicatorSnapshot } from "./indicators";
import type { EtfFacts, FinancialFacts, Instrument } from "./types";

export const STRATEGY_VERSION = "1.0.0";

export type RuleStatus = "PASS" | "FAIL" | "NO_DATA";

export interface RuleRow {
  group: string;
  rule: string;
  actual: string;
  threshold: string;
  status: RuleStatus;
  points: number;
  maxPoints: number;
}

export interface UniverseParams {
  minPrice: number;
  maxPrice: number;
  minMarketCap: number; // 원
  minTradingValue: number; // 원
  etfMinAum: number;
  etfMinTradingValue20d: number;
  etfMaxPremiumDiscount: number; // %
  excludeLeveragedInverse: boolean;
}

export const DEFAULT_UNIVERSE: UniverseParams = {
  minPrice: 3000,
  maxPrice: 500000,
  minMarketCap: 300_000_000_000,
  minTradingValue: 3_000_000_000,
  etfMinAum: 50_000_000_000,
  etfMinTradingValue20d: 1_000_000_000,
  etfMaxPremiumDiscount: 1,
  excludeLeveragedInverse: true,
};

export interface MarketGate {
  benchmarkAboveMa60: boolean | null;
  benchmarkAboveCloud: boolean | null;
  vkospiBelow30: boolean | null;
  foreignNet5dPositive: boolean | null;
  metCount: number;
  evaluatedCount: number;
  status: "RISK_ON" | "NEUTRAL" | "RISK_OFF";
  incomplete: boolean;
}

export function evaluateMarketGate(input: {
  benchmark: IndicatorSnapshot;
  vkospi: number | null;
  marketForeignNet5d: number | null;
}): MarketGate {
  const c = input.benchmark;
  const aboveMa60 = c.ma60 !== null ? c.close > c.ma60 : null;
  const aboveCloud = c.ichimoku.cloudTop !== null ? c.close > c.ichimoku.cloudTop : null;
  const vk = input.vkospi !== null ? input.vkospi < 30 : null;
  const fr = input.marketForeignNet5d !== null ? input.marketForeignNet5d > 0 : null;
  const flags = [aboveMa60, aboveCloud, vk, fr];
  const evaluated = flags.filter((f) => f !== null).length;
  const met = flags.filter((f) => f === true).length;
  const status = met >= 4 ? "RISK_ON" : met >= 2 ? "NEUTRAL" : "RISK_OFF";
  return {
    benchmarkAboveMa60: aboveMa60,
    benchmarkAboveCloud: aboveCloud,
    vkospiBelow30: vk,
    foreignNet5dPositive: fr,
    metCount: met,
    evaluatedCount: evaluated,
    status,
    incomplete: evaluated < 4,
  };
}

export interface UniverseResult {
  passed: boolean;
  failedRules: string[];
}

export function evaluateUniverse(
  inst: Instrument,
  snap: IndicatorSnapshot,
  marketCap: number,
  tradingValue: number,
  barCount: number,
  etf: EtfFacts | undefined,
  params: UniverseParams,
): UniverseResult {
  const failed: string[] = [];
  if (!inst.isActive) failed.push("거래정지 또는 비활성 종목");
  if (barCount < 120) failed.push("최근 120거래일 데이터 부족");

  if (inst.instrumentType === "STOCK") {
    if (inst.isPreferredStock) failed.push("우선주 제외");
    if (inst.isManagementIssue) failed.push("관리종목 제외");
    if (inst.isInvestmentWarning) failed.push("투자경고종목 제외");
    if (snap.close < params.minPrice) failed.push(`주가 ${params.minPrice.toLocaleString()}원 미만`);
    if (snap.close > params.maxPrice) failed.push(`주가 ${params.maxPrice.toLocaleString()}원 초과`);
    if (marketCap < params.minMarketCap) failed.push("시가총액 기준 미달");
    if (tradingValue < params.minTradingValue) failed.push("당일 거래대금 기준 미달");
  } else {
    if (params.excludeLeveragedInverse && (inst.isLeveraged || inst.isInverse))
      failed.push("레버리지·인버스 기본 제외");
    if (!etf) failed.push("ETF 메타데이터 없음");
    else {
      if (etf.assetsUnderManagement < params.etfMinAum) failed.push("순자산 기준 미달");
      if (etf.averageTradingValue20d < params.etfMinTradingValue20d)
        failed.push("20일 평균 거래대금 기준 미달");
      if (Math.abs(etf.premiumDiscountRate) > params.etfMaxPremiumDiscount)
        failed.push("괴리율 기준 초과");
    }
  }
  return { passed: failed.length === 0, failedRules: failed };
}

export interface ScoreBlock {
  points: number;
  maxPoints: number;
  availableMaxPoints: number;
  rows: RuleRow[];
}

function fmtPct(v: number | null, digits = 1) {
  return v === null ? "데이터 없음" : `${v.toFixed(digits)}%`;
}
function fmtNum(v: number | null, digits = 0) {
  return v === null ? "데이터 없음" : v.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}

/** Technical Signal Score, 7점 만점 */
export function technicalScore(snap: IndicatorSnapshot, valuePercentile: number | null): ScoreBlock {
  const rows: RuleRow[] = [];
  const ich = snap.ichimoku;

  // 7.1 일목 추세 (2)
  let ichPoints = 0;
  let ichStatus: RuleStatus = "NO_DATA";
  let ichActual = "데이터 없음";
  if (ich.cloudTop !== null && ich.cloudBottom !== null) {
    const above = snap.close > ich.cloudTop;
    const inside = snap.close >= ich.cloudBottom && snap.close <= ich.cloudTop;
    ichActual = above ? "구름 상단 위" : inside ? "구름 내부" : "구름 아래";
    if (above) {
      const extra = ich.tenkanAboveKijun === true && ich.chikouAbovePast26Close === true;
      ichPoints = extra ? 2 : 1;
      ichStatus = "PASS";
      ichActual += extra ? " + 전환선>기준선 + 후행스팬 양전" : " (보조조건 일부 미충족)";
    } else {
      ichStatus = "FAIL";
    }
  }
  rows.push({
    group: "일목 추세",
    rule: "구름 상단 위 + 전환선>기준선 + 종가>26일전 종가",
    actual: ichActual,
    threshold: "3개 모두 충족 시 +2",
    status: ichStatus,
    points: ichPoints,
    maxPoints: 2,
  });

  // 7.2 볼린저 모멘텀 (2)
  const b = snap.bollinger;
  let bbPoints = 0;
  let bbStatus: RuleStatus = "NO_DATA";
  let bbActual = "데이터 없음";
  if (b.bb) {
    const breakout = b.bbBreakout === true;
    const squeeze = b.bbSqueezePrior === true || b.bbSqueezeAbsolute === true;
    const expanding = b.bbWidthExpanding === true;
    if (breakout && squeeze && expanding) {
      bbPoints = 2;
      bbActual = "사전 스퀴즈 후 상단 돌파 + 밴드폭 확장";
    } else if (breakout || squeeze) {
      bbPoints = 1;
      bbActual = breakout ? "상단 돌파만 발생" : "스퀴즈 진행 중";
    } else {
      bbActual = `밴드폭 ${b.bb.width.toFixed(2)}%, 돌파 없음`;
    }
    if (b.headFakeWarning === true) {
      bbPoints = 0;
      bbActual = "상단 재진입 + 밴드폭 미확장 (Head Fake)";
    }
    bbStatus = bbPoints > 0 ? "PASS" : "FAIL";
  }
  rows.push({
    group: "볼린저 모멘텀",
    rule: "스퀴즈 후 상단 돌파 + 밴드폭 확장",
    actual: bbActual,
    threshold: "동시 충족 시 +2",
    status: bbStatus,
    points: bbPoints,
    maxPoints: 2,
  });

  // 7.3 거래량 수급 (2)
  let volPoints = 0;
  let volStatus: RuleStatus = "NO_DATA";
  if (snap.volumeRatio20 !== null) {
    const top30 = valuePercentile !== null ? valuePercentile >= 70 : false;
    if (snap.volumeRatio20 >= 200 && top30) volPoints = 2;
    else if (snap.volumeRatio20 >= 130) volPoints = 1;
    volStatus = volPoints > 0 ? "PASS" : "FAIL";
  }
  rows.push({
    group: "거래량 수급",
    rule: "20일 평균 거래량 대비 비율 + 거래대금 상위 30%",
    actual:
      snap.volumeRatio20 === null
        ? "데이터 없음"
        : `${snap.volumeRatio20.toFixed(1)}% / 거래대금 백분위 ${valuePercentile === null ? "-" : valuePercentile.toFixed(0)}`,
    threshold: "200% 이상 + 상위 30% → +2, 130% 이상 → +1",
    status: volStatus,
    points: volPoints,
    maxPoints: 2,
  });

  // 7.4 이동평균 배열 (1)
  let maPoints = 0;
  let maStatus: RuleStatus = "NO_DATA";
  if (snap.maAligned !== null && snap.ma20Slope !== null) {
    maPoints = snap.maAligned && snap.ma20Slope > 0 ? 1 : 0;
    maStatus = maPoints > 0 ? "PASS" : "FAIL";
  }
  rows.push({
    group: "이동평균 배열",
    rule: "MA20 > MA60 > MA120 + MA20 상승",
    actual:
      snap.ma20 === null
        ? "데이터 없음"
        : `MA20 ${fmtNum(snap.ma20)} / MA60 ${fmtNum(snap.ma60)} / MA120 ${fmtNum(snap.ma120)} / 기울기 ${fmtNum(snap.ma20Slope, 1)}`,
    threshold: "정배열 + 기울기 > 0 → +1",
    status: maStatus,
    points: maPoints,
    maxPoints: 1,
  });

  const points = rows.reduce((a, r) => a + r.points, 0);
  const availableMaxPoints = rows.reduce(
    (a, r) => a + (r.status === "NO_DATA" ? 0 : r.maxPoints),
    0,
  );
  return { points, maxPoints: 7, availableMaxPoints, rows };
}

export type TechnicalGrade = "A" | "B" | "C";

export function technicalGrade(points: number): TechnicalGrade {
  if (points >= 6) return "A";
  if (points >= 4) return "B";
  return "C";
}

export function actionLabel(grade: TechnicalGrade, gate: MarketGate["status"]): string {
  if (grade === "A") {
    if (gate === "RISK_ON") return "강한 관심 후보";
    if (gate === "NEUTRAL") return "축소 검토";
    return "시장 위험, 관망";
  }
  if (grade === "B") return "리테스트 대기";
  return "관망";
}

/** Priority Quality Score, 10점 만점 */
export function priorityScore(
  inst: Instrument,
  snap: IndicatorSnapshot,
  facts: FinancialFacts | undefined,
  marketCap: number,
  benchmarkDayReturn: number | null,
): ScoreBlock {
  const rows: RuleRow[] = [];
  const inIndex = ["KOSPI200", "KOSDAQ150", "KRX300"].some((c) =>
    inst.indexMemberships.includes(c),
  );
  rows.push({
    group: "지수 편입",
    rule: "KOSPI200 / KOSDAQ150 / KRX300 편입 (중복 1회)",
    actual: inst.indexMemberships.length ? inst.indexMemberships.join(", ") : "미편입",
    threshold: "편입 시 +2",
    status: inIndex ? "PASS" : "FAIL",
    points: inIndex ? 2 : 0,
    maxPoints: 2,
  });

  const f60 = snap.foreignNet60d;
  rows.push({
    group: "외국인 수급",
    rule: "최근 3개월(60일) 외국인 누적 순매수 > 0",
    actual: f60 === null ? "데이터 없음" : `${(f60 / 100_000_000).toFixed(1)}억 원`,
    threshold: "양수 시 +2",
    status: f60 === null ? "NO_DATA" : f60 > 0 ? "PASS" : "FAIL",
    points: f60 !== null && f60 > 0 ? 2 : 0,
    maxPoints: 2,
  });

  const valueUp = inst.indexMemberships.includes("KOREA_VALUEUP");
  rows.push({
    group: "밸류업",
    rule: "코리아 밸류업 지수 편입",
    actual: valueUp ? "편입" : "미편입",
    threshold: "편입 시 +1",
    status: valueUp ? "PASS" : "FAIL",
    points: valueUp ? 1 : 0,
    maxPoints: 1,
  });

  const yoy = facts?.quarterlyOpProfitYoY ?? null;
  rows.push({
    group: "실적 모멘텀",
    rule: "최근 분기 영업이익 흑자전환 또는 YoY +30% 이상",
    actual: yoy === null ? "데이터 없음" : fmtPct(yoy * 100),
    threshold: "충족 시 +2",
    status: yoy === null ? "NO_DATA" : yoy >= 0.3 ? "PASS" : "FAIL",
    points: yoy !== null && yoy >= 0.3 ? 2 : 0,
    maxPoints: 2,
  });

  const d = snap.distanceFrom52wHigh;
  rows.push({
    group: "신고가",
    rule: "52주 신고가 대비 10% 이내",
    actual: d === null ? "데이터 없음" : fmtPct(d),
    threshold: "-10% 이내 시 +1",
    status: d === null ? "NO_DATA" : d >= -10 ? "PASS" : "FAIL",
    points: d !== null && d >= -10 ? 1 : 0,
    maxPoints: 1,
  });

  const capOk = marketCap >= 300_000_000_000;
  rows.push({
    group: "규모",
    rule: "시가총액 3,000억 원 이상",
    actual: `${(marketCap / 1_000_000_000_000).toFixed(2)}조 원`,
    threshold: "충족 시 +1",
    status: capOk ? "PASS" : "FAIL",
    points: capOk ? 1 : 0,
    maxPoints: 1,
  });

  const excess =
    snap.dayReturn !== null && benchmarkDayReturn !== null
      ? (snap.dayReturn - benchmarkDayReturn) * 100
      : null;
  rows.push({
    group: "상대 성과",
    rule: "당일 벤치마크 대비 초과수익률 2%p 이상",
    actual: excess === null ? "데이터 없음" : `${excess.toFixed(2)}%p`,
    threshold: "2%p 이상 시 +1",
    status: excess === null ? "NO_DATA" : excess >= 2 ? "PASS" : "FAIL",
    points: excess !== null && excess >= 2 ? 1 : 0,
    maxPoints: 1,
  });

  const points = rows.reduce((a, r) => a + r.points, 0);
  const availableMaxPoints = rows.reduce(
    (a, r) => a + (r.status === "NO_DATA" ? 0 : r.maxPoints),
    0,
  );
  return { points, maxPoints: 10, availableMaxPoints, rows };
}

/** Fundamental Score, 100점 환산 (주식 전용) */
export function fundamentalScore(facts: FinancialFacts | undefined): ScoreBlock {
  const rows: RuleRow[] = [];
  const add = (
    group: string,
    rule: string,
    actual: string,
    threshold: string,
    status: RuleStatus,
    points: number,
    maxPoints: number,
  ) => rows.push({ group, rule, actual, threshold, status, points, maxPoints });

  if (!facts) {
    return { points: 0, maxPoints: 100, availableMaxPoints: 0, rows };
  }

  // 수익성 25
  const roe = facts.roe;
  add(
    "수익성",
    "ROE",
    roe === null ? "데이터 없음" : fmtPct(roe * 100),
    "12% 이상 15점 / 8% 이상 8점",
    roe === null ? "NO_DATA" : roe >= 0.08 ? "PASS" : "FAIL",
    roe === null ? 0 : roe >= 0.12 ? 15 : roe >= 0.08 ? 8 : 0,
    15,
  );
  const om = facts.operatingMargin;
  add(
    "수익성",
    "영업이익률",
    om === null ? "데이터 없음" : fmtPct(om * 100),
    "10% 이상 10점 / 5% 이상 5점",
    om === null ? "NO_DATA" : om >= 0.05 ? "PASS" : "FAIL",
    om === null ? 0 : om >= 0.1 ? 10 : om >= 0.05 ? 5 : 0,
    10,
  );

  // 성장성 25
  const rc = facts.revenueCagr3y;
  add(
    "성장성",
    "매출 3년 CAGR",
    rc === null ? "데이터 없음" : fmtPct(rc * 100),
    "10% 이상 12점",
    rc === null ? "NO_DATA" : rc >= 0.1 ? "PASS" : "FAIL",
    rc !== null && rc >= 0.1 ? 12 : 0,
    12,
  );
  const oc = facts.operatingProfitCagr3y;
  if (oc === null && facts.quarterlyOpProfitYoY !== null && facts.quarterlyOpProfitYoY > 0) {
    add(
      "성장성",
      "영업이익 3년 CAGR (계산 불가 → 흑자전환 대체)",
      "CAGR 계산 불가, 최근 분기 개선",
      "대체 시 최대 8점",
      "PASS",
      8,
      13,
    );
  } else {
    add(
      "성장성",
      "영업이익 3년 CAGR",
      oc === null ? "데이터 없음" : fmtPct(oc * 100),
      "15% 이상 13점",
      oc === null ? "NO_DATA" : oc >= 0.15 ? "PASS" : "FAIL",
      oc !== null && oc >= 0.15 ? 13 : 0,
      13,
    );
  }

  // 재무건전성 25
  const dr = facts.debtRatio;
  add(
    "재무건전성",
    "부채비율 100% 이하",
    dr === null ? "데이터 없음" : fmtPct(dr * 100),
    "100% 이하 10점",
    dr === null ? "NO_DATA" : dr <= 1 ? "PASS" : "FAIL",
    dr !== null && dr <= 1 ? 10 : 0,
    10,
  );
  const cr = facts.currentRatio;
  add(
    "재무건전성",
    "유동비율 150% 이상",
    cr === null ? "데이터 없음" : fmtPct(cr * 100),
    "150% 이상 8점",
    cr === null ? "NO_DATA" : cr >= 1.5 ? "PASS" : "FAIL",
    cr !== null && cr >= 1.5 ? 8 : 0,
    8,
  );
  const ic = facts.interestCoverage;
  add(
    "재무건전성",
    "이자보상배율 3배 이상",
    ic === null ? "데이터 없음 (분모 0 또는 음수 포함)" : `${ic.toFixed(1)}배`,
    "3배 이상 7점",
    ic === null ? "NO_DATA" : ic >= 3 ? "PASS" : "FAIL",
    ic !== null && ic >= 3 ? 7 : 0,
    7,
  );

  // 밸류에이션 25
  const fp = facts.forwardPer;
  const ip = facts.industryAveragePer;
  add(
    "밸류에이션",
    "Forward PER ≤ 업종 평균",
    fp === null || ip === null ? "데이터 없음" : `${fp.toFixed(1)}배 vs 업종 ${ip.toFixed(1)}배`,
    "이하 7점",
    fp === null || ip === null ? "NO_DATA" : fp <= ip ? "PASS" : "FAIL",
    fp !== null && ip !== null && fp <= ip ? 7 : 0,
    7,
  );
  const hp = facts.historicalFiveYearAveragePer;
  add(
    "밸류에이션",
    "Forward PER 5년 평균 대비 20% 이상 할인",
    fp === null || hp === null ? "데이터 없음" : `${fp.toFixed(1)}배 vs 5년 ${hp.toFixed(1)}배`,
    "20% 이상 할인 5점",
    fp === null || hp === null ? "NO_DATA" : fp <= hp * 0.8 ? "PASS" : "FAIL",
    fp !== null && hp !== null && fp <= hp * 0.8 ? 5 : 0,
    5,
  );
  const pbr = facts.pbr;
  add(
    "밸류에이션",
    "PBR 1.0~3.0",
    pbr === null ? "데이터 없음" : `${pbr.toFixed(2)}배`,
    "구간 내 5점 (1배 미만 자동 가점 없음)",
    pbr === null ? "NO_DATA" : pbr >= 1 && pbr <= 3 ? "PASS" : "FAIL",
    pbr !== null && pbr >= 1 && pbr <= 3 ? 5 : 0,
    5,
  );
  const ev = facts.evEbitda;
  const iev = facts.industryAverageEvEbitda;
  add(
    "밸류에이션",
    "EV/EBITDA ≤ 업종 평균",
    ev === null || iev === null ? "데이터 없음" : `${ev.toFixed(1)} vs ${iev.toFixed(1)}`,
    "이하 5점",
    ev === null || iev === null ? "NO_DATA" : ev <= iev ? "PASS" : "FAIL",
    ev !== null && iev !== null && ev <= iev ? 5 : 0,
    5,
  );
  const dy = facts.dividendYield;
  add(
    "밸류에이션",
    "배당수익률 2% 이상",
    dy === null ? "데이터 없음" : fmtPct(dy * 100, 2),
    "2% 이상 3점",
    dy === null ? "NO_DATA" : dy >= 0.02 ? "PASS" : "FAIL",
    dy !== null && dy >= 0.02 ? 3 : 0,
    3,
  );

  const points = rows.reduce((a, r) => a + r.points, 0);
  const availableMaxPoints = rows.reduce(
    (a, r) => a + (r.status === "NO_DATA" ? 0 : r.maxPoints),
    0,
  );
  return { points, maxPoints: 100, availableMaxPoints, rows };
}

/** ETF 상품건전성, 100점 */
export function etfHealthScore(inst: Instrument, etf: EtfFacts | undefined): ScoreBlock {
  const rows: RuleRow[] = [];
  if (!etf) return { points: 0, maxPoints: 100, availableMaxPoints: 0, rows };
  const aum = etf.assetsUnderManagement;
  let aumPts = 0;
  if (aum >= 50_000_000_000) aumPts += 20;
  if (aum >= 100_000_000_000) aumPts += 10;
  rows.push({
    group: "유동성",
    rule: "순자산 규모",
    actual: `${(aum / 100_000_000).toFixed(0)}억 원`,
    threshold: "500억 20점 / 1,000억 추가 10점",
    status: aumPts > 0 ? "PASS" : "FAIL",
    points: aumPts,
    maxPoints: 30,
  });
  const tvPts = etf.averageTradingValue20d >= 1_000_000_000 ? 20 : 0;
  rows.push({
    group: "유동성",
    rule: "20일 평균 거래대금 10억 원 이상",
    actual: `${(etf.averageTradingValue20d / 100_000_000).toFixed(1)}억 원`,
    threshold: "충족 시 20점",
    status: tvPts > 0 ? "PASS" : "FAIL",
    points: tvPts,
    maxPoints: 20,
  });
  const pd = Math.abs(etf.premiumDiscountRate);
  const pdPts = pd <= 0.5 ? 20 : pd <= 1 ? 10 : 0;
  rows.push({
    group: "추적 품질",
    rule: "괴리율 절댓값",
    actual: `${etf.premiumDiscountRate.toFixed(2)}%`,
    threshold: "0.5% 이내 20점 / 1.0% 이내 10점",
    status: pdPts > 0 ? "PASS" : "FAIL",
    points: pdPts,
    maxPoints: 20,
  });
  let ter = 0;
  if (etf.totalExpenseRatio <= 0.5) ter += 15;
  if (etf.totalExpenseRatio <= 0.3) ter += 5;
  rows.push({
    group: "비용",
    rule: "총보수",
    actual: `${etf.totalExpenseRatio.toFixed(2)}%`,
    threshold: "0.5% 이하 15점 / 0.3% 이하 추가 5점",
    status: ter > 0 ? "PASS" : "FAIL",
    points: ter,
    maxPoints: 20,
  });
  const plain = !inst.isLeveraged && !inst.isInverse;
  rows.push({
    group: "구조",
    rule: "레버리지·인버스 아님",
    actual: plain ? "일반형" : inst.isLeveraged ? "레버리지" : "인버스",
    threshold: "충족 시 10점",
    status: plain ? "PASS" : "FAIL",
    points: plain ? 10 : 0,
    maxPoints: 10,
  });
  const points = rows.reduce((a, r) => a + r.points, 0);
  return { points, maxPoints: 100, availableMaxPoints: 100, rows };
}

export function normalize(block: ScoreBlock): number | null {
  if (block.availableMaxPoints === 0) return null;
  return (block.points / block.availableMaxPoints) * 100;
}

export interface Weights {
  technical: number;
  priority: number;
  fundamental: number;
  marketSector: number;
}

export const STOCK_WEIGHTS: Weights = {
  technical: 0.45,
  priority: 0.2,
  fundamental: 0.25,
  marketSector: 0.1,
};
export const ETF_WEIGHTS: Weights = {
  technical: 0.55,
  priority: 0.15,
  fundamental: 0.15, // ETF: 상품건전성 점수로 대체
  marketSector: 0.15,
};

export function totalScore(input: {
  technicalNormalized: number | null;
  priorityNormalized: number | null;
  qualityScore: number | null; // 펀더멘털 또는 ETF 건전성
  marketSectorScore: number | null;
  weights: Weights;
}): { total: number; dataCompletenessRatio: number } {
  const parts: Array<[number | null, number]> = [
    [input.technicalNormalized, input.weights.technical],
    [input.priorityNormalized, input.weights.priority],
    [input.qualityScore, input.weights.fundamental],
    [input.marketSectorScore, input.weights.marketSector],
  ];
  let weighted = 0;
  let availableWeight = 0;
  for (const [v, w] of parts) {
    if (v === null) continue;
    weighted += v * w;
    availableWeight += w;
  }
  const total = availableWeight === 0 ? 0 : weighted / availableWeight;
  return { total, dataCompletenessRatio: availableWeight };
}

export const WARNING_LABELS: Record<string, string> = {
  HEAD_FAKE: "Head Fake 의심",
  LOW_VOLUME_BREAKOUT: "저거래량 돌파",
  PRICE_INSIDE_CLOUD: "구름 내부",
  PRICE_BELOW_CLOUD: "구름 아래",
  MA20_TURNING_DOWN: "20일선 하락 전환",
  MARKET_RISK_OFF: "시장 Risk-Off",
  VKOSPI_HIGH: "VKOSPI 高",
  FOREIGN_FLOW_NEGATIVE: "외국인 순매도",
  LOW_LIQUIDITY: "유동성 부족",
  NEAR_52W_HIGH: "52주 신고가 근접",
  OVEREXTENDED_FROM_MA20: "20일선 과열 이격",
  DATA_INCOMPLETE: "데이터 미완전",
  STALE_DATA: "데이터 지연",
  ETF_PREMIUM_DISCOUNT_HIGH: "괴리율 과다",
  LEVERAGED_ETF: "레버리지·인버스",
  EXIT_TRIGGER: "청산 트리거",
  ICHIMOKU_FAIL: "일목 조건 미충족",
};

export function collectWarnings(input: {
  snap: IndicatorSnapshot;
  gate: MarketGate;
  etf?: EtfFacts | undefined;
  inst: Instrument;
  dataCompletenessRatio: number;
  vkospi: number | null;
}): string[] {
  const w: string[] = [];
  const { snap, gate, inst, etf } = input;
  if (snap.bollinger.headFakeWarning === true) w.push("HEAD_FAKE");
  if (snap.bollinger.bbBreakout === true && (snap.volumeRatio20 ?? 0) < 130)
    w.push("LOW_VOLUME_BREAKOUT");
  const ich = snap.ichimoku;
  if (ich.cloudTop !== null && ich.cloudBottom !== null) {
    if (snap.close < ich.cloudBottom) w.push("PRICE_BELOW_CLOUD");
    else if (snap.close <= ich.cloudTop) w.push("PRICE_INSIDE_CLOUD");
    if (snap.close <= ich.cloudTop) w.push("ICHIMOKU_FAIL");
  }
  if (snap.ma20Slope !== null && snap.ma20Slope < 0) w.push("MA20_TURNING_DOWN");
  if (gate.status === "RISK_OFF") w.push("MARKET_RISK_OFF");
  if (input.vkospi !== null && input.vkospi >= 30) w.push("VKOSPI_HIGH");
  if (snap.foreignNet20d !== null && snap.foreignNet20d < 0) w.push("FOREIGN_FLOW_NEGATIVE");
  if (snap.distanceFrom52wHigh !== null && snap.distanceFrom52wHigh >= -3) w.push("NEAR_52W_HIGH");
  if (
    (snap.extensionFromMa20 !== null && snap.extensionFromMa20 >= 15) ||
    (snap.atrExtension !== null && snap.atrExtension >= 3)
  )
    w.push("OVEREXTENDED_FROM_MA20");
  if (input.dataCompletenessRatio < 0.7) w.push("DATA_INCOMPLETE");
  if (etf && Math.abs(etf.premiumDiscountRate) > 1) w.push("ETF_PREMIUM_DISCOUNT_HIGH");
  if (inst.isLeveraged || inst.isInverse) w.push("LEVERAGED_ETF");
  if (snap.ma20 !== null && snap.close < snap.ma20) w.push("EXIT_TRIGGER");
  return [...new Set(w)];
}

export interface PositionSizingInput {
  totalCapital: number;
  riskPercent: number; // 1 = 1%
  entryPrice: number;
  atr14: number;
  atrMultiple: number;
  maxWeightPercent: number;
  currentOpenRiskPercent: number;
}

export interface PositionSizingResult {
  stopPrice: number;
  riskPerShare: number;
  riskBasedQuantity: number;
  weightCappedQuantity: number;
  finalQuantity: number;
  investment: number;
  weightPercent: number;
  maxLoss: number;
  r1: number;
  r2: number;
  r3: number;
  firstTrancheQuantity: number;
  secondTrancheQuantity: number;
  openRiskAfter: number;
  openRiskExceeded: boolean;
  errors: string[];
}

export function calculatePositionSizing(input: PositionSizingInput): PositionSizingResult {
  const errors: string[] = [];
  const stopPrice = input.entryPrice - input.atrMultiple * input.atr14;
  const riskPerShare = input.entryPrice - stopPrice;
  if (input.atr14 <= 0) errors.push("ATR이 0 이하입니다. 손절 폭을 계산할 수 없습니다.");
  if (stopPrice >= input.entryPrice) errors.push("손절가가 진입가 이상입니다.");
  if (input.riskPercent <= 0) errors.push("허용 리스크 비율이 0입니다.");

  const riskBudget = input.totalCapital * (input.riskPercent / 100);
  const riskBasedQuantity =
    riskPerShare > 0 && riskBudget > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const weightCappedQuantity =
    input.entryPrice > 0
      ? Math.floor((input.totalCapital * (input.maxWeightPercent / 100)) / input.entryPrice)
      : 0;
  const finalQuantity = Math.max(0, Math.min(riskBasedQuantity, weightCappedQuantity));
  const investment = finalQuantity * input.entryPrice;
  const maxLoss = finalQuantity * riskPerShare;
  const openRiskAfter =
    input.currentOpenRiskPercent +
    (input.totalCapital > 0 ? (maxLoss / input.totalCapital) * 100 : 0);

  return {
    stopPrice,
    riskPerShare,
    riskBasedQuantity,
    weightCappedQuantity,
    finalQuantity,
    investment,
    weightPercent: input.totalCapital > 0 ? (investment / input.totalCapital) * 100 : 0,
    maxLoss,
    r1: input.entryPrice + riskPerShare,
    r2: input.entryPrice + 2 * riskPerShare,
    r3: input.entryPrice + 3 * riskPerShare,
    firstTrancheQuantity: Math.floor(finalQuantity / 2),
    secondTrancheQuantity: finalQuantity - Math.floor(finalQuantity / 2),
    openRiskAfter,
    openRiskExceeded: openRiskAfter > 6,
    errors,
  };
}
