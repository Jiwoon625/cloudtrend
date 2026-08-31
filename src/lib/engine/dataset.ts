// 엔진이 소비하는 데이터셋 계약.
// mock provider와 실제 시세 provider(토스증권 Open API)가 같은 형태를 만들어 주고,
// provider가 제공하지 못하는 항목은 capabilities에서 false로 선언한다(0으로 위장하지 않는다).
import type { DailyPrice, EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";

export interface DatasetCapabilities {
  /** 시가총액 제공 여부 */
  marketCap: boolean;
  /** 재무(펀더멘털) 스냅샷 제공 여부 */
  fundamentals: boolean;
  /** ETF NAV·총보수·순자산 등 상품 메타데이터 제공 여부 */
  etfFacts: boolean;
  /** 섹터(산업) 분류 및 섹터지수 제공 여부 */
  sectors: boolean;
  /** 외국인·기관 순매수 제공 여부 */
  investorFlow: boolean;
  /** 변동성지수(VKOSPI) 제공 여부 */
  volatilityIndex: boolean;
  /** 거래대금이 실측값인지(false면 종가×거래량 근사) */
  exactTradingValue: boolean;
}

export interface MarketDataset {
  provider: string;
  version: string;
  asOfDate: string;
  /** 실제 시장 데이터 여부 (false = 합성 mock) */
  isLive: boolean;
  capabilities: DatasetCapabilities;
  /** 화면에 그대로 노출할 데이터 한계 설명 */
  notes: string[];
  sectors: Array<{ code: string; name: string }>;
  tradeDates: string[];
  instruments: Instrument[];
  bars: Record<string, DailyPrice[]>;
  indexSeries: IndexSeries[];
  financials: Record<string, FinancialFacts>;
  etfFacts: Record<string, EtfFacts>;
  vkospiSeries: number[];
}

export const NO_CAPABILITIES: DatasetCapabilities = {
  marketCap: false,
  fundamentals: false,
  etfFacts: false,
  sectors: false,
  investorFlow: false,
  volatilityIndex: false,
  exactTradingValue: false,
};

export const FULL_CAPABILITIES: DatasetCapabilities = {
  marketCap: true,
  fundamentals: true,
  etfFacts: true,
  sectors: true,
  investorFlow: true,
  volatilityIndex: true,
  exactTradingValue: true,
};
