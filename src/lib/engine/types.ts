// 공통 도메인 타입. 모든 값은 합성(mock) 데이터 기반이며 실제 시세가 아닙니다.

export type InstrumentType = "STOCK" | "ETF";
export type Market = "KOSPI" | "KOSDAQ" | "ETF";

export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  instrumentType: InstrumentType;
  market: Market;
  sectorCode: string;
  sectorName: string;
  isPreferredStock: boolean;
  isManagementIssue: boolean;
  isInvestmentWarning: boolean;
  isLeveraged: boolean;
  isInverse: boolean;
  isActive: boolean;
  indexMemberships: string[]; // KOSPI200 / KOSDAQ150 / KRX300 / KOREA_VALUEUP
  etfTag?: string | undefined;
}

export interface DailyPrice {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingValue: number;
  /** null = 공급자가 제공하지 않음 */
  marketCap: number | null;
  foreignNetBuyValue: number | null;
  institutionNetBuyValue: number | null;
}

export interface FinancialFacts {
  // null = 데이터 없음 (0점과 구분해서 표시)
  roe: number | null;
  operatingMargin: number | null;
  revenueCagr3y: number | null;
  operatingProfitCagr3y: number | null;
  debtRatio: number | null;
  currentRatio: number | null;
  interestCoverage: number | null;
  forwardPer: number | null;
  industryAveragePer: number | null;
  historicalFiveYearAveragePer: number | null;
  pbr: number | null;
  evEbitda: number | null;
  industryAverageEvEbitda: number | null;
  dividendYield: number | null;
  quarterlyOpProfitYoY: number | null;
  isFinancialSector: boolean;
  sourceDate: string;
}

export interface EtfFacts {
  nav: number;
  premiumDiscountRate: number; // %
  totalExpenseRatio: number; // %
  assetsUnderManagement: number; // 원
  averageTradingValue20d: number; // 원
  underlyingIndex: string | null;
}

export interface IndexSeries {
  indexCode: string;
  indexName: string;
  bars: DailyPrice[];
}
