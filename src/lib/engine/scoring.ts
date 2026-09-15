// 점수 산정 엔진: 실격 필터 / 시장 게이트 / 점수를 분리한다. 전부 순수 함수.
import { DEFAULT_ROTATION_WEIGHTS, type RotationWeights } from "./sectorRotation";
import {
  VF_FEATURE_WEIGHTS,
  VF_MODEL_LABEL,
  VF_MODEL_VERSION,
  VF_SECTOR_PL_OVERHEAT_THRESHOLD,
} from "./vfConfig";
import type { IndicatorSnapshot } from "./indicators";
import type { EtfFacts, FinancialFacts, Instrument } from "./types";

export const STRATEGY_VERSION = VF_MODEL_LABEL;

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
  minMarketCap: number;
  minTradingValue: number;
  etfMinAum: number;
  etfMinTradingValue20d: number;
  etfMaxPremiumDiscount: number;
  excludeLeveragedInverse: boolean;
}

export const DEFAULT_UNIVERSE: UniverseParams = {
  minPrice: 3000,
  maxPrice: 10_000_000,
  minMarketCap: 300_000_000_000,
  minTradingValue: 0,
  etfMinAum: 50_000_000_000,
  etfMinTradingValue20d: 1_000_000_000,
  etfMaxPremiumDiscount: 1,
  excludeLeveragedInverse: true,
};

export interface UniverseAvailability {
  marketCap: boolean;
  etfFacts: boolean;
}

export const ALL_AVAILABLE: UniverseAvailability = { marketCap: true, etfFacts: true };

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
  return {
    benchmarkAboveMa60: aboveMa60,
    benchmarkAboveCloud: aboveCloud,
    vkospiBelow30: vk,
    foreignNet5dPositive: fr,
    metCount: met,
    evaluatedCount: evaluated,
    status: met >= 4 ? "RISK_ON" : met >= 2 ? "NEUTRAL" : "RISK_OFF",
    incomplete: evaluated < 4,
  };
}

export interface UniverseResult {
  passed: boolean;
  failedRules: string[];
  skippedRules: string[];
}

export function evaluateUniverse(
  inst: Instrument,
  snap: IndicatorSnapshot,
  marketCap: number | null,
  _tradingValue: number,
  barCount: number,
  etf: EtfFacts | undefined,
  params: UniverseParams,
  availability: UniverseAvailability = ALL_AVAILABLE,
): UniverseResult {
  const failed: string[] = [];
  const skipped: string[] = [];
  if (!inst.isActive) failed.push("거래정지 또는 비활성 종목");
  if (barCount < 120) failed.push("최근 120거래일 데이터 부족");

  if (inst.instrumentType === "STOCK") {
    if (inst.isPreferredStock) failed.push("우선주 제외");
    if (inst.isManagementIssue) failed.push("관리종목 제외");
    if (inst.isInvestmentWarning) failed.push("투자경고종목 제외");
    if (snap.close < params.minPrice) failed.push(`주가 ${params.minPrice.toLocaleString()}원 미만`);
    if (snap.close > params.maxPrice) failed.push(`주가 ${params.maxPrice.toLocaleString()}원 초과`);
    if (!availability.marketCap || marketCap === null) skipped.push("시가총액 기준 (데이터 없음)");
    else if (marketCap < params.minMarketCap) failed.push("시가총액 기준 미달");
  } else {
    if (params.excludeLeveragedInverse && (inst.isLeveraged || inst.isInverse))
      failed.push("레버리지·인버스 기본 제외");
    if (!availability.etfFacts) skipped.push("ETF 상품 메타데이터 기준 (데이터 없음)");
    else if (!etf) failed.push("ETF 메타데이터 없음");
    else {
      if (etf.assetsUnderManagement < params.etfMinAum) failed.push("순자산 기준 미달");
      if (etf.averageTradingValue20d < params.etfMinTradingValue20d)
        failed.push("20일 평균 거래대금 기준 미달");
      if (Math.abs(etf.premiumDiscountRate) > params.etfMaxPremiumDiscount)
        failed.push("괴리율 기준 초과");
    }
  }
  return { passed: failed.length === 0, failedRules: failed, skippedRules: skipped };
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

export interface TechnicalFlagsV3 {
  cloudAbove: boolean | null;
  maAligned: boolean | null;
  tenkanAboveKijun: boolean | null;
  ma20SlopeUp: boolean | null;
  return20Positive: boolean | null;
  bbBreakout: boolean | null;
  highCloseVolume: boolean | null;
}

export function technicalFlagsV3(
  snap: IndicatorSnapshot,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): TechnicalFlagsV3 {
  const t = cfg.technical;
  const ich = snap.ichimoku;
  const b = snap.bollinger;
  const clv = snap.closeLocationValue;
  return {
    cloudAbove: ich.cloudTop === null ? null : snap.close > ich.cloudTop,
    maAligned: snap.maAligned,
    tenkanAboveKijun: ich.tenkanAboveKijun,
    ma20SlopeUp: snap.ma20Slope === null ? null : snap.ma20Slope > 0,
    return20Positive: snap.return20 === null ? null : snap.return20 > 0,
    bbBreakout: b.bb === null ? null : b.headFakeWarning === true ? false : b.bbBreakout === true,
    highCloseVolume:
      snap.volumeRatio20 === null || clv === null
        ? null
        : snap.volumeRatio20 >= t.volumeStrongRatio && clv >= t.clvThreshold,
  };
}

export function momentumPoints(
  flags: TechnicalFlagsV3,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): { points: number; met: number; evaluated: number } {
  const evaluated = flags.tenkanAboveKijun === null ? 0 : 1;
  const met = flags.tenkanAboveKijun === true ? 1 : 0;
  return { points: met ? cfg.technical.momentumMax : 0, met, evaluated };
}

/** ETF/legacy technical sub-score. V8 stock operation uses v8FinalStockScore instead. */
export function technicalScore(
  snap: IndicatorSnapshot,
  valuePercentile: number | null,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreBlock {
  const rows: RuleRow[] = [];
  const t = cfg.technical;
  const ich = snap.ichimoku;
  const flags = technicalFlagsV3(snap, cfg);
  const cloudActual =
    ich.cloudTop === null
      ? "데이터 없음"
      : flags.cloudAbove
        ? `구름 상단 위 (종가 ${fmtNum(snap.close)} > 상단 ${fmtNum(ich.cloudTop)})`
        : ich.cloudBottom !== null && snap.close >= ich.cloudBottom
          ? "구름 내부"
          : "구름 아래";
  rows.push({
    group: "Trend Core",
    rule: "일목 구름 상단 위 (종가 > 선행스팬 상단)",
    actual: cloudActual,
    threshold: `충족 시 +${t.cloudAboveMax}`,
    status: flags.cloudAbove === null ? "NO_DATA" : flags.cloudAbove ? "PASS" : "FAIL",
    points: flags.cloudAbove === true ? t.cloudAboveMax : 0,
    maxPoints: t.cloudAboveMax,
  });
  rows.push({
    group: "Trend Core",
    rule: "이동평균 정배열 (MA20 > MA60 > MA120)",
    actual:
      snap.ma20 === null
        ? "데이터 없음"
        : `MA20 ${fmtNum(snap.ma20)} / MA60 ${fmtNum(snap.ma60)} / MA120 ${fmtNum(snap.ma120)}`,
    threshold: `정배열 시 +${t.maAlignedMax}`,
    status: flags.maAligned === null ? "NO_DATA" : flags.maAligned ? "PASS" : "FAIL",
    points: flags.maAligned === true ? t.maAlignedMax : 0,
    maxPoints: t.maAlignedMax,
  });
  const mom = momentumPoints(flags, cfg);
  rows.push({
    group: "Momentum Confirmation",
    rule: "전환선 > 기준선",
    actual:
      flags.tenkanAboveKijun === null ? "데이터 없음" : flags.tenkanAboveKijun ? "충족" : "미충족",
    threshold: `충족 시 +${t.momentumMax}`,
    status: mom.evaluated === 0 ? "NO_DATA" : mom.met > 0 ? "PASS" : "FAIL",
    points: mom.points,
    maxPoints: t.momentumMax,
  });
  const b = snap.bollinger;
  rows.push({
    group: "Breakout",
    rule: "볼린저 상단 돌파 (Head Fake 시 0점, 스퀴즈는 점수 미반영)",
    actual:
      b.bb === null
        ? "데이터 없음"
        : b.headFakeWarning === true
          ? "상단 재진입 + 밴드폭 미확장 (Head Fake)"
          : b.bbBreakout === true
            ? "상단 돌파"
            : `밴드폭 ${b.bb.width.toFixed(2)}%, 돌파 없음`,
    threshold: `돌파 시 +${t.breakoutMax}`,
    status: flags.bbBreakout === null ? "NO_DATA" : flags.bbBreakout ? "PASS" : "FAIL",
    points: flags.bbBreakout === true ? t.breakoutMax : 0,
    maxPoints: t.breakoutMax,
  });
  rows.push({
    group: "Volume",
    rule: `고가 마감 거래량 (거래량 ≥ ${t.volumeStrongRatio}% AND CLV ≥ ${t.clvThreshold})`,
    actual:
      flags.highCloseVolume === null
        ? "데이터 없음"
        : `거래량 ${snap.volumeRatio20!.toFixed(0)}% / CLV ${snap.closeLocationValue!.toFixed(2)}${
            valuePercentile === null
              ? ""
              : ` (참고: 거래대금 백분위 ${valuePercentile.toFixed(0)}, 점수 미반영)`
          }`,
    threshold: `동시 충족 시 +${t.volumeMax}`,
    status: flags.highCloseVolume === null ? "NO_DATA" : flags.highCloseVolume ? "PASS" : "FAIL",
    points: flags.highCloseVolume === true ? t.volumeMax : 0,
    maxPoints: t.volumeMax,
  });
  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;
  const availableMaxPoints = rows.reduce(
    (sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints),
    0,
  );
  return { points, maxPoints: technicalMaxPoints(cfg), availableMaxPoints, rows };
}

/**
 * Legacy/base 9.5-point Vf score. Kept as the research base so historical V8 study code does not double-count
 * the sector slot. Live operation must use v8FinalStockScore.
 */
export function vfStockScore(
  snap: IndicatorSnapshot,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
  options: { exclude52wHigh?: boolean } = {},
): ScoreBlock {
  const rows: RuleRow[] = [];
  const t = cfg.technical;
  const p = cfg.priority;
  const flags = technicalFlagsV3(snap, cfg);
  const add = (
    group: string,
    rule: string,
    actual: string,
    flag: boolean | null,
    maxPoints: number,
  ) =>
    rows.push({
      group,
      rule,
      actual,
      threshold: `충족 시 +${maxPoints}`,
      status: flag === null ? "NO_DATA" : flag ? "PASS" : "FAIL",
      points: flag === true ? maxPoints : 0,
      maxPoints,
    });

  add(
    "Vf Trend",
    "일목 구름 상단 위",
    flags.cloudAbove === null
      ? "데이터 없음"
      : flags.cloudAbove
        ? `종가 ${fmtNum(snap.close)} > 구름 상단 ${fmtNum(snap.ichimoku.cloudTop)}`
        : "미충족",
    flags.cloudAbove,
    t.cloudAboveMax,
  );
  add(
    "Vf Momentum",
    "전환선 > 기준선",
    flags.tenkanAboveKijun === null ? "데이터 없음" : flags.tenkanAboveKijun ? "충족" : "미충족",
    flags.tenkanAboveKijun,
    t.momentumMax,
  );
  add(
    "Vf Breakout",
    "볼린저 상단 돌파 (Head Fake 시 미충족)",
    flags.bbBreakout === null ? "데이터 없음" : flags.bbBreakout ? "상단 돌파" : "미돌파",
    flags.bbBreakout,
    t.breakoutMax,
  );
  add(
    "Vf Trend",
    "이동평균 정배열 (MA20 > MA60 > MA120)",
    flags.maAligned === null ? "데이터 없음" : flags.maAligned ? "정배열" : "미충족",
    flags.maAligned,
    t.maAlignedMax,
  );
  add(
    "Vf Volume",
    `고가 마감 거래량 (거래량 ≥ ${t.volumeStrongRatio}% AND CLV ≥ ${t.clvThreshold})`,
    flags.highCloseVolume === null
      ? "데이터 없음"
      : `거래량 ${snap.volumeRatio20!.toFixed(0)}% / CLV ${snap.closeLocationValue!.toFixed(2)}`,
    flags.highCloseVolume,
    t.volumeMax,
  );

  const nearHigh =
    snap.distanceFrom52wHigh === null
      ? null
      : snap.distanceFrom52wHigh >= p.nearHighThresholdPercent;
  if (!options.exclude52wHigh)
    add(
      "Vf Leadership",
      `52주 신고가 대비 ${Math.abs(p.nearHighThresholdPercent)}% 이내`,
      snap.distanceFrom52wHigh === null ? "데이터 없음" : fmtPct(snap.distanceFrom52wHigh),
      nearHigh,
      p.nearHighPoints,
    );

  const foreignPositive = snap.foreignNet20d === null ? null : snap.foreignNet20d > 0;
  add(
    "Vf Flow",
    "최근 20거래일 외국인 누적 순매수 > 0",
    snap.foreignNet20d === null
      ? "데이터 없음"
      : `${(snap.foreignNet20d / 100_000_000).toFixed(1)}억 원`,
    foreignPositive,
    p.foreignPoints,
  );

  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;
  const maxPoints = Math.round(rows.reduce((sum, row) => sum + row.maxPoints, 0) * 100) / 100;
  const availableMaxPoints =
    Math.round(
      rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0) * 100,
    ) / 100;
  return { points, maxPoints, availableMaxPoints, rows };
}

/** V8 Final 10-point operating score = base 9.5 + Sector Price Leadership 0.5 slot. */
export function v8FinalStockScore(
  snap: IndicatorSnapshot,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
  options: { exclude52wHigh?: boolean; sectorPriceLeadership?: number | null } = {},
): ScoreBlock {
  const base = vfStockScore(snap, cfg, { exclude52wHigh: options.exclude52wHigh });
  const priceLeadership = options.sectorPriceLeadership ?? null;
  const overheated =
    priceLeadership !== null && priceLeadership >= VF_SECTOR_PL_OVERHEAT_THRESHOLD;
  const sectorPoints = overheated ? 0 : VF_FEATURE_WEIGHTS.SECTOR_PRICE_LEADERSHIP;
  const sectorRow: RuleRow = {
    group: "V8 Sector",
    rule: `Sector Price Leadership 과열 억제 (PL < ${VF_SECTOR_PL_OVERHEAT_THRESHOLD})`,
    actual:
      priceLeadership === null
        ? "데이터 없음 · V8 기본 슬롯 유지"
        : `PL ${priceLeadership.toFixed(1)} / 100${overheated ? " · 과열" : ""}`,
    threshold: `PL < ${VF_SECTOR_PL_OVERHEAT_THRESHOLD} 또는 데이터 없음 시 +${VF_FEATURE_WEIGHTS.SECTOR_PRICE_LEADERSHIP}`,
    status: overheated ? "FAIL" : "PASS",
    points: sectorPoints,
    maxPoints: VF_FEATURE_WEIGHTS.SECTOR_PRICE_LEADERSHIP,
  };
  const rows = [...base.rows, sectorRow];
  return {
    points: Math.round((base.points + sectorPoints) * 100) / 100,
    maxPoints: Math.round((base.maxPoints + sectorRow.maxPoints) * 100) / 100,
    availableMaxPoints: Math.round((base.availableMaxPoints + sectorRow.maxPoints) * 100) / 100,
    rows,
  };
}

export const HISTORICAL_TECHNICAL_MAX = 10;

/** Full V8 Final raw score only when every core rule is calculable. Never rescale missing data. */
export function historicalTechnicalScore(
  snap: IndicatorSnapshot,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const score = v8FinalStockScore(snap, cfg);
  const missingRules = score.rows.filter((row) => row.status === "NO_DATA").map((row) => row.rule);
  return {
    points:
      missingRules.length === 0 && Number.isFinite(score.points) && score.availableMaxPoints === score.maxPoints
        ? score.points
        : null,
    rawPoints: score.points,
    rawMaxPoints: score.maxPoints,
    availableMaxPoints: score.availableMaxPoints,
    missingRules,
  };
}

/** Strict live score: incomplete core data cannot be promoted by re-normalizing the remaining features. */
export function strictRawTechnicalScore(block: ScoreBlock): number | null {
  if (block.maxPoints <= 0 || block.availableMaxPoints !== block.maxPoints) return null;
  return Number.isFinite(block.points) ? block.points : null;
}

/** Vf score grade: 80+ A, 60+ B, otherwise C. */
export function vfGrade(score: number | null): TechnicalGrade {
  if (score !== null && score >= 80) return "A";
  if (score !== null && score >= 60) return "B";
  return "C";
}

export type TechnicalGrade = "A" | "B" | "C";

export function technicalGrade(
  points: number,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): TechnicalGrade {
  if (points >= cfg.grade.aMin) return "A";
  if (points >= cfg.grade.bMin) return "B";
  return "C";
}

/** Display-only fallback label. Market Gate no longer overrides V8 Final trading signals. */
export function actionLabel(grade: TechnicalGrade, _gate: MarketGate["status"]): string {
  if (grade === "A") return "관심 후보";
  if (grade === "B") return "관찰 후보";
  return "관찰";
}

export function priorityScore(
  inst: Instrument,
  snap: IndicatorSnapshot,
  _facts: FinancialFacts | undefined,
  marketCap: number | null,
  benchmarkDayReturn: number | null,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreBlock {
  const rows: RuleRow[] = [];
  const c = cfg.priority;
  const inIndex = ["KOSPI200", "KOSDAQ150", "KRX300"].some((code) =>
    inst.indexMemberships.includes(code),
  );
  rows.push({
    group: "지수 편입",
    rule: "KOSPI200 / KOSDAQ150 / KRX300 편입 (중복 1회)",
    actual: inst.indexMemberships.length ? inst.indexMemberships.join(", ") : "미편입",
    threshold: `편입 시 +${c.indexPoints}`,
    status: inIndex ? "PASS" : "FAIL",
    points: inIndex ? c.indexPoints : 0,
    maxPoints: c.indexPoints,
  });
  const f20 = snap.foreignNet20d;
  rows.push({
    group: "외국인 수급",
    rule: "최근 20거래일 외국인 누적 순매수 > 0",
    actual: f20 === null ? "데이터 없음" : `${(f20 / 100_000_000).toFixed(1)}억 원`,
    threshold: `양수 시 +${c.foreignPoints}`,
    status: f20 === null ? "NO_DATA" : f20 > 0 ? "PASS" : "FAIL",
    points: f20 !== null && f20 > 0 ? c.foreignPoints : 0,
    maxPoints: c.foreignPoints,
  });
  const d = snap.distanceFrom52wHigh;
  const nearOk = d !== null && d >= c.nearHighThresholdPercent;
  rows.push({
    group: "신고가",
    rule: `52주 신고가 대비 ${Math.abs(c.nearHighThresholdPercent)}% 이내`,
    actual: d === null ? "데이터 없음" : fmtPct(d),
    threshold: `${c.nearHighThresholdPercent}% 이내 시 +${c.nearHighPoints}`,
    status: d === null ? "NO_DATA" : nearOk ? "PASS" : "FAIL",
    points: nearOk ? c.nearHighPoints : 0,
    maxPoints: c.nearHighPoints,
  });
  const capOk = marketCap !== null && marketCap >= c.minMarketCap;
  rows.push({
    group: "규모",
    rule: `시가총액 ${(c.minMarketCap / 100_000_000).toLocaleString("ko-KR")}억 원 이상`,
    actual:
      marketCap === null ? "데이터 없음" : `${(marketCap / 1_000_000_000_000).toFixed(2)}조 원`,
    threshold: `충족 시 +${c.sizePoints}`,
    status: marketCap === null ? "NO_DATA" : capOk ? "PASS" : "FAIL",
    points: capOk ? c.sizePoints : 0,
    maxPoints: c.sizePoints,
  });
  const excess =
    snap.dayReturn !== null && benchmarkDayReturn !== null
      ? (snap.dayReturn - benchmarkDayReturn) * 100
      : null;
  const excessOk = excess !== null && excess >= c.excessReturnThresholdPp;
  rows.push({
    group: "상대 성과",
    rule: `당일 벤치마크 대비 초과수익률 ${c.excessReturnThresholdPp}%p 이상`,
    actual: excess === null ? "데이터 없음" : `${excess.toFixed(2)}%p`,
    threshold: `${c.excessReturnThresholdPp}%p 이상 시 +${c.relativePoints}`,
    status: excess === null ? "NO_DATA" : excessOk ? "PASS" : "FAIL",
    points: excessOk ? c.relativePoints : 0,
    maxPoints: c.relativePoints,
  });
  const valueUp = inst.indexMemberships.includes("KOREA_VALUEUP");
  rows.push({
    group: "참고지표 (점수 미반영)",
    rule: "코리아 밸류업 지수 편입",
    actual: valueUp ? "편입" : "미편입",
    threshold: "점수 미반영 (참고 정보)",
    status: valueUp ? "PASS" : "FAIL",
    points: 0,
    maxPoints: 0,
  });
  const points = rows.reduce((sum, row) => sum + row.points, 0);
  const availableMaxPoints = rows.reduce(
    (sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints),
    0,
  );
  return { points, maxPoints: priorityMaxPoints(cfg), availableMaxPoints, rows };
}

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
  if (!facts) return { points: 0, maxPoints: 100, availableMaxPoints: 0, rows };

  const roe = facts.roe;
  add("수익성", "ROE", roe === null ? "데이터 없음" : fmtPct(roe * 100), "12% 이상 15점 / 8% 이상 8점", roe === null ? "NO_DATA" : roe >= 0.08 ? "PASS" : "FAIL", roe === null ? 0 : roe >= 0.12 ? 15 : roe >= 0.08 ? 8 : 0, 15);
  const om = facts.operatingMargin;
  add("수익성", "영업이익률", om === null ? "데이터 없음" : fmtPct(om * 100), "10% 이상 10점 / 5% 이상 5점", om === null ? "NO_DATA" : om >= 0.05 ? "PASS" : "FAIL", om === null ? 0 : om >= 0.1 ? 10 : om >= 0.05 ? 5 : 0, 10);
  const rc = facts.revenueCagr3y;
  add("성장성", "매출 3년 CAGR", rc === null ? "데이터 없음" : fmtPct(rc * 100), "10% 이상 12점", rc === null ? "NO_DATA" : rc >= 0.1 ? "PASS" : "FAIL", rc !== null && rc >= 0.1 ? 12 : 0, 12);
  const oc = facts.operatingProfitCagr3y;
  if (oc === null && facts.quarterlyOpProfitYoY !== null && facts.quarterlyOpProfitYoY > 0)
    add("성장성", "영업이익 3년 CAGR (계산 불가 → 흑자전환 대체)", "CAGR 계산 불가, 최근 분기 개선", "대체 시 최대 8점", "PASS", 8, 13);
  else
    add("성장성", "영업이익 3년 CAGR", oc === null ? "데이터 없음" : fmtPct(oc * 100), "15% 이상 13점", oc === null ? "NO_DATA" : oc >= 0.15 ? "PASS" : "FAIL", oc !== null && oc >= 0.15 ? 13 : 0, 13);
  const dr = facts.debtRatio;
  add("재무건전성", "부채비율 100% 이하", dr === null ? "데이터 없음" : fmtPct(dr * 100), "100% 이하 10점", dr === null ? "NO_DATA" : dr <= 1 ? "PASS" : "FAIL", dr !== null && dr <= 1 ? 10 : 0, 10);
  const cr = facts.currentRatio;
  add("재무건전성", "유동비율 150% 이상", cr === null ? "데이터 없음" : fmtPct(cr * 100), "150% 이상 8점", cr === null ? "NO_DATA" : cr >= 1.5 ? "PASS" : "FAIL", cr !== null && cr >= 1.5 ? 8 : 0, 8);
  const ic = facts.interestCoverage;
  add("재무건전성", "이자보상배율 3배 이상", ic === null ? "데이터 없음 (분모 0 또는 음수 포함)" : `${ic.toFixed(1)}배`, "3배 이상 7점", ic === null ? "NO_DATA" : ic >= 3 ? "PASS" : "FAIL", ic !== null && ic >= 3 ? 7 : 0, 7);
  const fp = facts.forwardPer;
  const ip = facts.industryAveragePer;
  add("밸류에이션", "Forward PER ≤ 업종 평균", fp === null || ip === null ? "데이터 없음" : `${fp.toFixed(1)}배 vs 업종 ${ip.toFixed(1)}배`, "이하 7점", fp === null || ip === null ? "NO_DATA" : fp <= ip ? "PASS" : "FAIL", fp !== null && ip !== null && fp <= ip ? 7 : 0, 7);
  const hp = facts.historicalFiveYearAveragePer;
  add("밸류에이션", "Forward PER 5년 평균 대비 20% 이상 할인", fp === null || hp === null ? "데이터 없음" : `${fp.toFixed(1)}배 vs 5년 ${hp.toFixed(1)}배`, "20% 이상 할인 5점", fp === null || hp === null ? "NO_DATA" : fp <= hp * 0.8 ? "PASS" : "FAIL", fp !== null && hp !== null && fp <= hp * 0.8 ? 5 : 0, 5);
  const pbr = facts.pbr;
  add("밸류에이션", "PBR 1.0~3.0", pbr === null ? "데이터 없음" : `${pbr.toFixed(2)}배`, "구간 내 5점 (1배 미만 자동 가점 없음)", pbr === null ? "NO_DATA" : pbr >= 1 && pbr <= 3 ? "PASS" : "FAIL", pbr !== null && pbr >= 1 && pbr <= 3 ? 5 : 0, 5);
  const ev = facts.evEbitda;
  const iev = facts.industryAverageEvEbitda;
  add("밸류에이션", "EV/EBITDA ≤ 업종 평균", ev === null || iev === null ? "데이터 없음" : `${ev.toFixed(1)} vs ${iev.toFixed(1)}`, "이하 5점", ev === null || iev === null ? "NO_DATA" : ev <= iev ? "PASS" : "FAIL", ev !== null && iev !== null && ev <= iev ? 5 : 0, 5);
  const dy = facts.dividendYield;
  add("밸류에이션", "배당수익률 2% 이상", dy === null ? "데이터 없음" : fmtPct(dy * 100, 2), "2% 이상 3점", dy === null ? "NO_DATA" : dy >= 0.02 ? "PASS" : "FAIL", dy !== null && dy >= 0.02 ? 3 : 0, 3);
  const points = rows.reduce((sum, row) => sum + row.points, 0);
  const availableMaxPoints = rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0);
  return { points, maxPoints: 100, availableMaxPoints, rows };
}

export function etfHealthScore(inst: Instrument, etf: EtfFacts | undefined): ScoreBlock {
  const rows: RuleRow[] = [];
  if (!etf) return { points: 0, maxPoints: 100, availableMaxPoints: 0, rows };
  const aum = etf.assetsUnderManagement;
  let aumPts = 0;
  if (aum >= 50_000_000_000) aumPts += 20;
  if (aum >= 100_000_000_000) aumPts += 10;
  rows.push({ group: "유동성", rule: "순자산 규모", actual: `${(aum / 100_000_000).toFixed(0)}억 원`, threshold: "500억 20점 / 1,000억 추가 10점", status: aumPts > 0 ? "PASS" : "FAIL", points: aumPts, maxPoints: 30 });
  const tvPts = etf.averageTradingValue20d >= 1_000_000_000 ? 20 : 0;
  rows.push({ group: "유동성", rule: "20일 평균 거래대금 10억 원 이상", actual: `${(etf.averageTradingValue20d / 100_000_000).toFixed(1)}억 원`, threshold: "충족 시 20점", status: tvPts > 0 ? "PASS" : "FAIL", points: tvPts, maxPoints: 20 });
  const pd = Math.abs(etf.premiumDiscountRate);
  const pdPts = pd <= 0.5 ? 20 : pd <= 1 ? 10 : 0;
  rows.push({ group: "추적 품질", rule: "괴리율 절댓값", actual: `${etf.premiumDiscountRate.toFixed(2)}%`, threshold: "0.5% 이내 20점 / 1.0% 이내 10점", status: pdPts > 0 ? "PASS" : "FAIL", points: pdPts, maxPoints: 20 });
  let ter = 0;
  if (etf.totalExpenseRatio <= 0.5) ter += 15;
  if (etf.totalExpenseRatio <= 0.3) ter += 5;
  rows.push({ group: "비용", rule: "총보수", actual: `${etf.totalExpenseRatio.toFixed(2)}%`, threshold: "0.5% 이하 15점 / 0.3% 이하 추가 5점", status: ter > 0 ? "PASS" : "FAIL", points: ter, maxPoints: 20 });
  const plain = !inst.isLeveraged && !inst.isInverse;
  rows.push({ group: "구조", rule: "레버리지·인버스 아님", actual: plain ? "일반형" : inst.isLeveraged ? "레버리지" : "인버스", threshold: "충족 시 10점", status: plain ? "PASS" : "FAIL", points: plain ? 10 : 0, maxPoints: 10 });
  const points = rows.reduce((sum, row) => sum + row.points, 0);
  return { points, maxPoints: 100, availableMaxPoints: 100, rows };
}

/** Generic normalization for ETF/priority blocks. Do not use this to create V8 stock entry signals. */
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

export const STOCK_WEIGHTS: Weights = { technical: 1, priority: 0, fundamental: 0, marketSector: 0 };
export const ETF_WEIGHTS: Weights = { technical: 0.55, priority: 0.15, fundamental: 0.15, marketSector: 0.15 };

export function totalScore(input: {
  technicalNormalized: number | null;
  priorityNormalized: number | null;
  qualityScore: number | null;
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
  for (const [value, weight] of parts) {
    if (value === null) continue;
    weighted += value * weight;
    availableWeight += weight;
  }
  return {
    total: availableWeight === 0 ? 0 : weighted / availableWeight,
    dataCompletenessRatio: availableWeight,
  };
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
  EXIT_TRIGGER: "V8 Exit 조건",
  ICHIMOKU_FAIL: "일목 조건 미충족",
};

export function collectWarnings(input: {
  snap: IndicatorSnapshot;
  gate: MarketGate;
  etf?: EtfFacts | undefined;
  inst: Instrument;
  dataCompletenessRatio: number;
  vkospi: number | null;
  exitSignal?: boolean;
}): string[] {
  const w: string[] = [];
  const { snap, inst, etf } = input;
  if (snap.bollinger.headFakeWarning === true) w.push("HEAD_FAKE");
  if (snap.bollinger.bbBreakout === true && (snap.volumeRatio20 ?? 0) < 130) w.push("LOW_VOLUME_BREAKOUT");
  const ich = snap.ichimoku;
  if (ich.cloudTop !== null && ich.cloudBottom !== null) {
    if (snap.close < ich.cloudBottom) w.push("PRICE_BELOW_CLOUD");
    else if (snap.close <= ich.cloudTop) w.push("PRICE_INSIDE_CLOUD");
    if (snap.close <= ich.cloudTop) w.push("ICHIMOKU_FAIL");
  }
  if (snap.ma20Slope !== null && snap.ma20Slope < 0) w.push("MA20_TURNING_DOWN");
  if (input.vkospi !== null && input.vkospi >= 30) w.push("VKOSPI_HIGH");
  if (snap.foreignNet20d !== null && snap.foreignNet20d < 0) w.push("FOREIGN_FLOW_NEGATIVE");
  if (snap.distanceFrom52wHigh !== null && snap.distanceFrom52wHigh >= -3) w.push("NEAR_52W_HIGH");
  if ((snap.extensionFromMa20 !== null && snap.extensionFromMa20 >= 15) || (snap.atrExtension !== null && snap.atrExtension >= 3))
    w.push("OVEREXTENDED_FROM_MA20");
  if (input.dataCompletenessRatio < 1) w.push("DATA_INCOMPLETE");
  if (etf && Math.abs(etf.premiumDiscountRate) > 1) w.push("ETF_PREMIUM_DISCOUNT_HIGH");
  if (inst.isLeveraged || inst.isInverse) w.push("LEVERAGED_ETF");
  if (input.exitSignal) w.push("EXIT_TRIGGER");
  return [...new Set(w)];
}

export interface PositionSizingInput {
  totalCapital: number;
  riskPercent: number;
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
  const riskBasedQuantity = riskPerShare > 0 && riskBudget > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const weightCappedQuantity = input.entryPrice > 0 ? Math.floor((input.totalCapital * (input.maxWeightPercent / 100)) / input.entryPrice) : 0;
  const finalQuantity = Math.max(0, Math.min(riskBasedQuantity, weightCappedQuantity));
  const investment = finalQuantity * input.entryPrice;
  const maxLoss = finalQuantity * riskPerShare;
  const openRiskAfter = input.currentOpenRiskPercent + (input.totalCapital > 0 ? (maxLoss / input.totalCapital) * 100 : 0);
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

export interface ScoringConfig {
  configVersion: number;
  weights: { stock: Weights; etf: Weights };
  technical: {
    cloudAboveMax: number;
    maAlignedMax: number;
    momentumMax: number;
    breakoutMax: number;
    volumeMax: number;
    volumeStrongRatio: number;
    clvThreshold: number;
  };
  priority: {
    indexPoints: number;
    foreignPoints: number;
    nearHighPoints: number;
    sizePoints: number;
    relativePoints: number;
    nearHighThresholdPercent: number;
    minMarketCap: number;
    excessReturnThresholdPp: number;
  };
  grade: { aMin: number; bMin: number };
  universe: UniverseParams;
  rotation: RotationWeights;
}

export const SCORING_CONFIG_VERSION = VF_MODEL_VERSION;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  configVersion: SCORING_CONFIG_VERSION,
  weights: { stock: { ...STOCK_WEIGHTS }, etf: { ...ETF_WEIGHTS } },
  technical: {
    cloudAboveMax: VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD,
    maAlignedMax: VF_FEATURE_WEIGHTS.MA_ALIGNED,
    momentumMax: VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN,
    breakoutMax: VF_FEATURE_WEIGHTS.BB_BREAKOUT,
    volumeMax: VF_FEATURE_WEIGHTS.VOLUME_SURGE,
    volumeStrongRatio: 150,
    clvThreshold: 0.7,
  },
  priority: {
    indexPoints: 2,
    foreignPoints: VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,
    nearHighPoints: VF_FEATURE_WEIGHTS.NEAR_52W_HIGH,
    sizePoints: 1,
    relativePoints: 1,
    nearHighThresholdPercent: -10,
    minMarketCap: 300_000_000_000,
    excessReturnThresholdPp: 2,
  },
  grade: { aMin: 4, bMin: 3 },
  universe: { ...DEFAULT_UNIVERSE },
  rotation: { ...DEFAULT_ROTATION_WEIGHTS },
};

const clampNum = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function mergeScoringConfig(input: unknown): ScoringConfig {
  const d = DEFAULT_SCORING_CONFIG;
  const at = (object: unknown, key: string): unknown =>
    object && typeof object === "object" ? (object as Record<string, unknown>)[key] : undefined;
  const raw = input ?? {};
  const rawVersion = Number(at(raw, "configVersion"));
  if (!Number.isFinite(rawVersion) || rawVersion < SCORING_CONFIG_VERSION)
    return JSON.parse(JSON.stringify(d)) as ScoringConfig;
  const w = at(raw, "weights");
  const weightBlock = (source: unknown, defaults: Weights): Weights => ({
    technical: clampNum(at(source, "technical"), defaults.technical, 0, 1),
    priority: clampNum(at(source, "priority"), defaults.priority, 0, 1),
    fundamental: clampNum(at(source, "fundamental"), defaults.fundamental, 0, 1),
    marketSector: clampNum(at(source, "marketSector"), defaults.marketSector, 0, 1),
  });
  const t = at(raw, "technical");
  const p = at(raw, "priority");
  const g = at(raw, "grade");
  const u = at(raw, "universe");
  const rot = at(raw, "rotation");
  return {
    configVersion: SCORING_CONFIG_VERSION,
    weights: { stock: weightBlock(at(w, "stock"), d.weights.stock), etf: weightBlock(at(w, "etf"), d.weights.etf) },
    technical: {
      cloudAboveMax: clampNum(at(t, "cloudAboveMax"), d.technical.cloudAboveMax, 0, 20),
      maAlignedMax: clampNum(at(t, "maAlignedMax"), d.technical.maAlignedMax, 0, 20),
      momentumMax: clampNum(at(t, "momentumMax"), d.technical.momentumMax, 0, 20),
      breakoutMax: clampNum(at(t, "breakoutMax"), d.technical.breakoutMax, 0, 20),
      volumeMax: clampNum(at(t, "volumeMax"), d.technical.volumeMax, 0, 20),
      volumeStrongRatio: clampNum(at(t, "volumeStrongRatio"), d.technical.volumeStrongRatio, 100, 2000),
      clvThreshold: clampNum(at(t, "clvThreshold"), d.technical.clvThreshold, 0, 1),
    },
    priority: {
      indexPoints: clampNum(at(p, "indexPoints"), d.priority.indexPoints, 0, 20),
      foreignPoints: clampNum(at(p, "foreignPoints"), d.priority.foreignPoints, 0, 20),
      nearHighPoints: clampNum(at(p, "nearHighPoints"), d.priority.nearHighPoints, 0, 20),
      sizePoints: clampNum(at(p, "sizePoints"), d.priority.sizePoints, 0, 20),
      relativePoints: clampNum(at(p, "relativePoints"), d.priority.relativePoints, 0, 20),
      nearHighThresholdPercent: clampNum(at(p, "nearHighThresholdPercent"), d.priority.nearHighThresholdPercent, -100, 0),
      minMarketCap: clampNum(at(p, "minMarketCap"), d.priority.minMarketCap, 0, 1e15),
      excessReturnThresholdPp: clampNum(at(p, "excessReturnThresholdPp"), d.priority.excessReturnThresholdPp, -20, 20),
    },
    grade: {
      aMin: clampNum(at(g, "aMin"), d.grade.aMin, 0, 100),
      bMin: clampNum(at(g, "bMin"), d.grade.bMin, 0, 100),
    },
    universe: {
      minPrice: clampNum(at(u, "minPrice"), d.universe.minPrice, 0, 1e7),
      maxPrice: clampNum(at(u, "maxPrice"), d.universe.maxPrice, 1000, 1e9),
      minMarketCap: clampNum(at(u, "minMarketCap"), d.universe.minMarketCap, 0, 1e15),
      minTradingValue: clampNum(at(u, "minTradingValue"), d.universe.minTradingValue, 0, 1e15),
      etfMinAum: clampNum(at(u, "etfMinAum"), d.universe.etfMinAum, 0, 1e15),
      etfMinTradingValue20d: clampNum(at(u, "etfMinTradingValue20d"), d.universe.etfMinTradingValue20d, 0, 1e15),
      etfMaxPremiumDiscount: clampNum(at(u, "etfMaxPremiumDiscount"), d.universe.etfMaxPremiumDiscount, 0, 50),
      excludeLeveragedInverse:
        typeof at(u, "excludeLeveragedInverse") === "boolean"
          ? (at(u, "excludeLeveragedInverse") as boolean)
          : d.universe.excludeLeveragedInverse,
    },
    rotation: {
      priceLeadership: clampNum(at(rot, "priceLeadership"), d.rotation.priceLeadership, 0, 1),
      moneyFlow: clampNum(at(rot, "moneyFlow"), d.rotation.moneyFlow, 0, 1),
      rotationMomentum: clampNum(at(rot, "rotationMomentum"), d.rotation.rotationMomentum, 0, 1),
    },
  };
}

export function technicalMaxPoints(cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): number {
  const t = cfg.technical;
  return Math.round((t.cloudAboveMax + t.maAlignedMax + t.momentumMax + t.breakoutMax + t.volumeMax) * 100) / 100;
}

export function priorityMaxPoints(cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): number {
  const p = cfg.priority;
  return p.indexPoints + p.foreignPoints + p.nearHighPoints + p.sizePoints + p.relativePoints;
}
