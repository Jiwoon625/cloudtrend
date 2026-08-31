// Mock data provider — 화면 테스트용 합성 데이터. 실제 시세/재무가 아닙니다.
// 시드 기반 결정론적 생성: 같은 시드 = 같은 데이터 = 같은 점수.
import { FULL_CAPABILITIES, type MarketDataset } from "./dataset";
import type {
  DailyPrice,
  EtfFacts,
  FinancialFacts,
  IndexSeries,
  Instrument,
} from "./types";

export const DATA_PROVIDER = "MOCK_SYNTHETIC_V1";
export const DATA_VERSION = "mock-2026-08-31";
export const BAR_COUNT = 300;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 영업일 기준일 목록 (주말 제외, 합성) */
export function buildTradeDates(count: number, endDate = new Date("2026-08-28T00:00:00Z")) {
  const dates: string[] = [];
  const d = new Date(endDate);
  while (dates.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.reverse();
}

export const TRADE_DATES = buildTradeDates(BAR_COUNT);
export const AS_OF_DATE = TRADE_DATES[TRADE_DATES.length - 1]!;

export type Scenario =
  | "A_STRONG"
  | "A_RISK_OFF_SENSITIVE"
  | "B_RETEST"
  | "HEAD_FAKE"
  | "LOW_VOLUME"
  | "MISSING_FUNDAMENTALS"
  | "EXIT_CHECK"
  | "BELOW_CLOUD"
  | "ETF_PREMIUM"
  | "NEUTRAL";

interface Spec {
  symbol: string;
  name: string;
  market: "KOSPI" | "KOSDAQ" | "ETF";
  sectorCode: string;
  sectorName: string;
  scenario: Scenario;
  basePrice: number;
  marketCap: number;
  memberships?: string[];
  etfTag?: string;
  isLeveraged?: boolean;
  isInverse?: boolean;
}

export const SECTORS: Array<{ code: string; name: string }> = [
  { code: "SEMI", name: "반도체" },
  { code: "AUTO", name: "자동차" },
  { code: "FIN", name: "금융" },
  { code: "BIO", name: "바이오·헬스케어" },
  { code: "CHEM", name: "화학·소재" },
  { code: "IT", name: "IT·소프트웨어" },
  { code: "SHIP", name: "조선·기계" },
];

const STOCK_SPECS: Spec[] = [
  { symbol: "005930", name: "샘플전자", market: "KOSPI", sectorCode: "SEMI", sectorName: "반도체", scenario: "A_STRONG", basePrice: 74000, marketCap: 420_000_000_000_000, memberships: ["KOSPI200", "KRX300", "KOREA_VALUEUP"] },
  { symbol: "000660", name: "샘플반도체", market: "KOSPI", sectorCode: "SEMI", sectorName: "반도체", scenario: "A_STRONG", basePrice: 182000, marketCap: 120_000_000_000_000, memberships: ["KOSPI200", "KRX300"] },
  { symbol: "005380", name: "샘플모터스", market: "KOSPI", sectorCode: "AUTO", sectorName: "자동차", scenario: "NEUTRAL", basePrice: 235000, marketCap: 48_000_000_000_000, memberships: ["KOSPI200", "KOREA_VALUEUP"] },
  { symbol: "105560", name: "샘플금융지주", market: "KOSPI", sectorCode: "FIN", sectorName: "금융", scenario: "B_RETEST", basePrice: 62000, marketCap: 24_000_000_000_000, memberships: ["KOSPI200", "KOREA_VALUEUP"] },
  { symbol: "051910", name: "샘플화학", market: "KOSPI", sectorCode: "CHEM", sectorName: "화학·소재", scenario: "BELOW_CLOUD", basePrice: 320000, marketCap: 22_000_000_000_000, memberships: ["KOSPI200"] },
  { symbol: "009150", name: "샘플전기부품", market: "KOSPI", sectorCode: "IT", sectorName: "IT·소프트웨어", scenario: "HEAD_FAKE", basePrice: 148000, marketCap: 11_000_000_000_000, memberships: ["KOSPI200", "KRX300"] },
  { symbol: "010140", name: "샘플중공업", market: "KOSPI", sectorCode: "SHIP", sectorName: "조선·기계", scenario: "A_RISK_OFF_SENSITIVE", basePrice: 13500, marketCap: 9_500_000_000_000, memberships: ["KOSPI200"] },
  { symbol: "068270", name: "샘플바이오로직", market: "KOSPI", sectorCode: "BIO", sectorName: "바이오·헬스케어", scenario: "MISSING_FUNDAMENTALS", basePrice: 780000, marketCap: 55_000_000_000_000, memberships: ["KOSPI200", "KRX300"] },
  { symbol: "011200", name: "샘플해운", market: "KOSPI", sectorCode: "SHIP", sectorName: "조선·기계", scenario: "EXIT_CHECK", basePrice: 19800, marketCap: 6_200_000_000_000 },
  { symbol: "034020", name: "샘플에너지", market: "KOSPI", sectorCode: "CHEM", sectorName: "화학·소재", scenario: "LOW_VOLUME", basePrice: 22400, marketCap: 3_400_000_000_000 },
  { symbol: "247540", name: "샘플소재텍", market: "KOSDAQ", sectorCode: "CHEM", sectorName: "화학·소재", scenario: "A_STRONG", basePrice: 156000, marketCap: 11_000_000_000_000, memberships: ["KOSDAQ150", "KRX300"] },
  { symbol: "086520", name: "샘플배터리소재", market: "KOSDAQ", sectorCode: "CHEM", sectorName: "화학·소재", scenario: "B_RETEST", basePrice: 108000, marketCap: 5_600_000_000_000, memberships: ["KOSDAQ150"] },
  { symbol: "196170", name: "샘플제약", market: "KOSDAQ", sectorCode: "BIO", sectorName: "바이오·헬스케어", scenario: "A_STRONG", basePrice: 62500, marketCap: 4_100_000_000_000, memberships: ["KOSDAQ150"] },
  { symbol: "263750", name: "샘플게임즈", market: "KOSDAQ", sectorCode: "IT", sectorName: "IT·소프트웨어", scenario: "HEAD_FAKE", basePrice: 41200, marketCap: 1_800_000_000_000, memberships: ["KOSDAQ150"] },
  { symbol: "112040", name: "샘플콘텐츠", market: "KOSDAQ", sectorCode: "IT", sectorName: "IT·소프트웨어", scenario: "NEUTRAL", basePrice: 31500, marketCap: 1_200_000_000_000 },
  { symbol: "058470", name: "샘플리노", market: "KOSDAQ", sectorCode: "SEMI", sectorName: "반도체", scenario: "A_STRONG", basePrice: 28900, marketCap: 900_000_000_000, memberships: ["KOSDAQ150"] },
  { symbol: "240810", name: "샘플장비", market: "KOSDAQ", sectorCode: "SEMI", sectorName: "반도체", scenario: "LOW_VOLUME", basePrice: 24100, marketCap: 720_000_000_000 },
  { symbol: "214150", name: "샘플로보틱스", market: "KOSDAQ", sectorCode: "SHIP", sectorName: "조선·기계", scenario: "MISSING_FUNDAMENTALS", basePrice: 33800, marketCap: 1_400_000_000_000 },
  { symbol: "095340", name: "샘플에이치엠", market: "KOSDAQ", sectorCode: "IT", sectorName: "IT·소프트웨어", scenario: "EXIT_CHECK", basePrice: 15200, marketCap: 310_000_000_000 },
  { symbol: "078600", name: "샘플바이오텍", market: "KOSDAQ", sectorCode: "BIO", sectorName: "바이오·헬스케어", scenario: "BELOW_CLOUD", basePrice: 9800, marketCap: 280_000_000_000 },
];

const ETF_SPECS: Spec[] = [
  { symbol: "069500", name: "샘플 KOSPI200 ETF", market: "ETF", sectorCode: "MKT", sectorName: "시장대표", scenario: "A_STRONG", basePrice: 41200, marketCap: 6_800_000_000_000, etfTag: "시장대표" },
  { symbol: "229200", name: "샘플 KOSDAQ150 ETF", market: "ETF", sectorCode: "MKT", sectorName: "시장대표", scenario: "NEUTRAL", basePrice: 13800, marketCap: 900_000_000_000, etfTag: "시장대표" },
  { symbol: "364980", name: "샘플 반도체 ETF", market: "ETF", sectorCode: "SEMI", sectorName: "반도체", scenario: "A_STRONG", basePrice: 22500, marketCap: 720_000_000_000, etfTag: "섹터·테마" },
  { symbol: "305720", name: "샘플 2차전지 ETF", market: "ETF", sectorCode: "CHEM", sectorName: "화학·소재", scenario: "B_RETEST", basePrice: 18700, marketCap: 480_000_000_000, etfTag: "섹터·테마" },
  { symbol: "251340", name: "샘플 밸류업 ETF", market: "ETF", sectorCode: "FIN", sectorName: "금융", scenario: "A_STRONG", basePrice: 12600, marketCap: 350_000_000_000, etfTag: "밸류업" },
  { symbol: "279530", name: "샘플 고배당 ETF", market: "ETF", sectorCode: "FIN", sectorName: "금융", scenario: "NEUTRAL", basePrice: 14300, marketCap: 260_000_000_000, etfTag: "배당" },
  { symbol: "441640", name: "샘플 커버드콜 ETF", market: "ETF", sectorCode: "MKT", sectorName: "시장대표", scenario: "ETF_PREMIUM", basePrice: 10200, marketCap: 140_000_000_000, etfTag: "커버드콜" },
  { symbol: "148070", name: "샘플 국채 ETF", market: "ETF", sectorCode: "BOND", sectorName: "채권", scenario: "LOW_VOLUME", basePrice: 108000, marketCap: 1_100_000_000_000, etfTag: "채권" },
  { symbol: "122630", name: "샘플 레버리지 ETF", market: "ETF", sectorCode: "MKT", sectorName: "시장대표", scenario: "A_STRONG", basePrice: 21500, marketCap: 1_900_000_000_000, etfTag: "레버리지", isLeveraged: true },
  { symbol: "114800", name: "샘플 인버스 ETF", market: "ETF", sectorCode: "MKT", sectorName: "시장대표", scenario: "BELOW_CLOUD", basePrice: 4100, marketCap: 1_300_000_000_000, etfTag: "인버스", isInverse: true },
];

export const ALL_SPECS = [...STOCK_SPECS, ...ETF_SPECS];

function scenarioProfile(s: Scenario) {
  switch (s) {
    case "A_STRONG":
      return { drift: 0.0016, vol: 0.016, squeeze: true, breakout: true, volSpike: 2.6, headFake: false, belowCloud: false, exit: false };
    case "A_RISK_OFF_SENSITIVE":
      return { drift: 0.0015, vol: 0.021, squeeze: true, breakout: true, volSpike: 2.3, headFake: false, belowCloud: false, exit: false };
    case "B_RETEST":
      return { drift: 0.0011, vol: 0.017, squeeze: true, breakout: false, volSpike: 1.5, headFake: false, belowCloud: false, exit: false };
    case "HEAD_FAKE":
      return { drift: 0.0006, vol: 0.019, squeeze: true, breakout: false, volSpike: 1.1, headFake: true, belowCloud: false, exit: false };
    case "LOW_VOLUME":
      return { drift: 0.0008, vol: 0.013, squeeze: true, breakout: true, volSpike: 0.9, headFake: false, belowCloud: false, exit: false };
    case "MISSING_FUNDAMENTALS":
      return { drift: 0.0013, vol: 0.02, squeeze: false, breakout: true, volSpike: 2.2, headFake: false, belowCloud: false, exit: false };
    case "EXIT_CHECK":
      return { drift: 0.0009, vol: 0.018, squeeze: false, breakout: false, volSpike: 1.2, headFake: false, belowCloud: false, exit: true };
    case "BELOW_CLOUD":
      return { drift: -0.0012, vol: 0.019, squeeze: false, breakout: false, volSpike: 1.0, headFake: false, belowCloud: true, exit: true };
    case "ETF_PREMIUM":
      return { drift: 0.0005, vol: 0.011, squeeze: false, breakout: false, volSpike: 1.1, headFake: false, belowCloud: false, exit: false };
    default:
      return { drift: 0.0004, vol: 0.015, squeeze: false, breakout: false, volSpike: 1.2, headFake: false, belowCloud: false, exit: false };
  }
}

function generateBars(spec: Spec): DailyPrice[] {
  const rnd = mulberry32(hashSeed(spec.symbol));
  const p = scenarioProfile(spec.scenario);
  const bars: DailyPrice[] = [];
  let price = spec.basePrice * 0.72;
  const n = TRADE_DATES.length;
  const baseVolume = Math.max(30_000, Math.round(spec.marketCap / spec.basePrice / 900));

  for (let i = 0; i < n; i++) {
    const fromEnd = n - 1 - i;
    let drift = p.drift;
    let vol = p.vol;

    // 최근 30봉: 스퀴즈 구간(변동성 축소)
    if (p.squeeze && fromEnd <= 30 && fromEnd > 1) {
      vol = vol * 0.28;
      drift = drift * 0.15;
    }
    // 돌파 당일
    if (p.breakout && fromEnd === 0) {
      drift = 0.055;
      vol = vol * 1.4;
    }
    // Head fake: 전일 돌파, 당일 되돌림
    if (p.headFake && fromEnd === 1) drift = 0.05;
    if (p.headFake && fromEnd === 0) drift = -0.035;
    if (p.exit && fromEnd <= 6) drift = -0.012;
    if (p.belowCloud && fromEnd <= 40) drift = -0.008;

    const shock = (rnd() - 0.5) * 2 * vol;
    const prevClose = price;
    price = Math.max(500, price * (1 + drift + shock));
    const open = prevClose * (1 + (rnd() - 0.5) * vol * 0.5);
    const close = price;
    const high = Math.max(open, close) * (1 + rnd() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rnd() * vol * 0.6);

    let volume = Math.round(baseVolume * (0.7 + rnd() * 0.6));
    if (p.squeeze && fromEnd <= 30 && fromEnd > 0) volume = Math.round(volume * 0.75);
    if (fromEnd === 0) volume = Math.round(volume * p.volSpike * 1.6);
    if (p.headFake && fromEnd === 1) volume = Math.round(volume * 1.8);

    const tradingValue = Math.round(volume * close);
    const foreignBias = p.drift > 0.001 ? 1 : -1;
    const foreignNetBuyValue = Math.round((rnd() - 0.35 + foreignBias * 0.25) * tradingValue * 0.12);
    const institutionNetBuyValue = Math.round((rnd() - 0.5) * tradingValue * 0.08);

    bars.push({
      tradeDate: TRADE_DATES[i]!,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      volume,
      tradingValue,
      marketCap: Math.round(spec.marketCap * (close / spec.basePrice)),
      foreignNetBuyValue,
      institutionNetBuyValue,
    });
  }
  return bars;
}

function generateIndexBars(code: string, base: number, drift: number, seed: string): DailyPrice[] {
  const rnd = mulberry32(hashSeed(seed));
  const bars: DailyPrice[] = [];
  let price = base * 0.85;
  for (let i = 0; i < TRADE_DATES.length; i++) {
    const prev = price;
    price = Math.max(1, price * (1 + drift + (rnd() - 0.5) * 0.014));
    const high = Math.max(prev, price) * (1 + rnd() * 0.005);
    const low = Math.min(prev, price) * (1 - rnd() * 0.005);
    const volume = Math.round(200_000_000 * (0.8 + rnd() * 0.4));
    bars.push({
      tradeDate: TRADE_DATES[i]!,
      open: Math.round(prev * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(price * 100) / 100,
      volume,
      tradingValue: volume * 1000,
      marketCap: 0,
      foreignNetBuyValue: Math.round((rnd() - 0.42) * 400_000_000_000),
      institutionNetBuyValue: Math.round((rnd() - 0.5) * 300_000_000_000),
    });
  }
  void code;
  return bars;
}

export const INDEX_SERIES: IndexSeries[] = [
  { indexCode: "KOSPI", indexName: "코스피", bars: generateIndexBars("KOSPI", 2750, 0.0009, "kospi-idx") },
  { indexCode: "KOSDAQ", indexName: "코스닥", bars: generateIndexBars("KOSDAQ", 780, 0.0006, "kosdaq-idx") },
  { indexCode: "KRX300", indexName: "KRX300", bars: generateIndexBars("KRX300", 1580, 0.0008, "krx300-idx") },
  ...SECTORS.map((s, i) => ({
    indexCode: `KRX_${s.code}`,
    indexName: `KRX ${s.name}`,
    bars: generateIndexBars(s.code, 1000 + i * 120, 0.0004 + i * 0.00035, `sector-${s.code}`),
  })),
];

export const VKOSPI_SERIES: number[] = (() => {
  const rnd = mulberry32(hashSeed("vkospi"));
  const out: number[] = [];
  let v = 18;
  for (let i = 0; i < TRADE_DATES.length; i++) {
    v = Math.min(45, Math.max(11, v + (rnd() - 0.5) * 1.8));
    out.push(Math.round(v * 100) / 100);
  }
  return out;
})();

export const INSTRUMENTS: Instrument[] = ALL_SPECS.map((s) => ({
  id: s.symbol,
  symbol: s.symbol,
  name: s.name,
  instrumentType: s.market === "ETF" ? "ETF" : "STOCK",
  market: s.market,
  sectorCode: s.sectorCode,
  sectorName: s.sectorName,
  isPreferredStock: false,
  isManagementIssue: false,
  isInvestmentWarning: false,
  isLeveraged: !!s.isLeveraged,
  isInverse: !!s.isInverse,
  isActive: true,
  indexMemberships: s.memberships ?? [],
  etfTag: s.etfTag,
}));

const BARS_CACHE = new Map<string, DailyPrice[]>();
export function getBars(symbol: string): DailyPrice[] {
  const cached = BARS_CACHE.get(symbol);
  if (cached) return cached;
  const spec = ALL_SPECS.find((s) => s.symbol === symbol);
  if (!spec) return [];
  const bars = generateBars(spec);
  BARS_CACHE.set(symbol, bars);
  return bars;
}

export function getFinancials(symbol: string): FinancialFacts | undefined {
  const spec = ALL_SPECS.find((s) => s.symbol === symbol);
  if (!spec || spec.market === "ETF") return undefined;
  const rnd = mulberry32(hashSeed(`fin-${symbol}`));
  const missing = spec.scenario === "MISSING_FUNDAMENTALS";
  const isFin = spec.sectorCode === "FIN";
  const strong = spec.scenario === "A_STRONG" || spec.scenario === "A_RISK_OFF_SENSITIVE";
  const roe = 0.04 + rnd() * (strong ? 0.16 : 0.1);
  const om = 0.03 + rnd() * (strong ? 0.16 : 0.09);
  return {
    roe: Math.round(roe * 10000) / 10000,
    operatingMargin: Math.round(om * 10000) / 10000,
    revenueCagr3y: missing ? null : Math.round((rnd() * 0.24 - 0.02) * 10000) / 10000,
    operatingProfitCagr3y: missing ? null : Math.round((rnd() * 0.34 - 0.05) * 10000) / 10000,
    debtRatio: Math.round((0.3 + rnd() * (isFin ? 4 : 1.2)) * 10000) / 10000,
    currentRatio: isFin ? null : Math.round((0.9 + rnd() * 1.4) * 10000) / 10000,
    interestCoverage: rnd() > 0.15 ? Math.round((0.5 + rnd() * 12) * 100) / 100 : null,
    forwardPer: missing ? null : Math.round((6 + rnd() * 22) * 100) / 100,
    industryAveragePer: Math.round((10 + rnd() * 14) * 100) / 100,
    historicalFiveYearAveragePer: missing ? null : Math.round((11 + rnd() * 16) * 100) / 100,
    pbr: Math.round((0.4 + rnd() * 3.2) * 100) / 100,
    evEbitda: missing ? null : Math.round((3 + rnd() * 14) * 100) / 100,
    industryAverageEvEbitda: Math.round((6 + rnd() * 8) * 100) / 100,
    dividendYield: Math.round(rnd() * 0.05 * 10000) / 10000,
    quarterlyOpProfitYoY: missing ? null : Math.round((rnd() * 1.1 - 0.25) * 10000) / 10000,
    isFinancialSector: isFin,
    sourceDate: AS_OF_DATE,
  };
}

export function getEtfFacts(symbol: string): EtfFacts | undefined {
  const spec = ALL_SPECS.find((s) => s.symbol === symbol);
  if (!spec || spec.market !== "ETF") return undefined;
  const rnd = mulberry32(hashSeed(`etf-${symbol}`));
  const bars = getBars(symbol);
  const last = bars[bars.length - 1]!;
  const premium =
    spec.scenario === "ETF_PREMIUM"
      ? Math.round((1.2 + rnd() * 0.8) * 100) / 100
      : Math.round((rnd() * 0.8 - 0.4) * 100) / 100;
  const avgValue20 =
    bars.slice(-20).reduce((a, b) => a + b.tradingValue, 0) / 20;
  return {
    nav: Math.round(last.close / (1 + premium / 100)),
    premiumDiscountRate: premium,
    totalExpenseRatio: Math.round((0.05 + rnd() * 0.7) * 100) / 100,
    assetsUnderManagement: spec.marketCap,
    averageTradingValue20d: Math.round(avgValue20),
    underlyingIndex: spec.etfTag === "시장대표" ? "KOSPI200" : null,
  };
}

export function getIndexSeries(code: string): IndexSeries | undefined {
  return INDEX_SERIES.find((s) => s.indexCode === code);
}

// ---------------------------------------------------------------------------
// MarketDataset 어댑터 (합성 데이터: 모든 항목 제공)
// ---------------------------------------------------------------------------
export function getMockDataset(): MarketDataset {
  const bars: Record<string, DailyPrice[]> = {};
  const financials: Record<string, FinancialFacts> = {};
  const etfFacts: Record<string, EtfFacts> = {};
  for (const inst of INSTRUMENTS) {
    bars[inst.symbol] = getBars(inst.symbol);
    const f = getFinancials(inst.symbol);
    if (f) financials[inst.symbol] = f;
    const e = getEtfFacts(inst.symbol);
    if (e) etfFacts[inst.symbol] = e;
  }
  return {
    provider: DATA_PROVIDER,
    version: DATA_VERSION,
    asOfDate: AS_OF_DATE,
    isLive: false,
    capabilities: FULL_CAPABILITIES,
    notes: [
      "합성(mock) 데이터입니다. 실제 시세·재무가 아니며 화면 및 계산 검증 목적으로만 사용합니다.",
    ],
    sectors: SECTORS,
    tradeDates: TRADE_DATES,
    instruments: INSTRUMENTS,
    bars,
    indexSeries: INDEX_SERIES,
    financials,
    etfFacts,
    vkospiSeries: VKOSPI_SERIES,
  };
}
