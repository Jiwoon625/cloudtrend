import { describe, expect, it } from "vitest";

import "./dataset";
import type { MarketDataset } from "./dataset";
import { buildFullUniverseSectorDataset } from "./sectorRotationFullUniverse";
import {
  REVIEWED_STOCK_SECTOR_BY_SYMBOL,
  REVIEWED_STOCK_SECTOR_COUNT,
  normalizeReviewedStockSymbol,
  resolveReviewedStockSectorCode,
} from "./stockSectorMaster";
import {
  ADDITIONAL_STOCK_SECTOR_BY_SYMBOL,
  ADDITIONAL_STOCK_SECTOR_COUNT,
  resolveAdditionalStockSectorCode,
} from "./additionalStockSectorMaster";
import { resolveSectorCode } from "./sectors";

function singleStockDataset(input: {
  symbol: string;
  name: string;
  sectorCode: string;
  sectorName: string;
}): MarketDataset {
  return {
    provider: "TEST",
    version: "test",
    asOfDate: "2026-09-09",
    isLive: true,
    capabilities: {
      marketCap: false,
      fundamentals: false,
      etfFacts: false,
      sectors: true,
      investorFlow: false,
      volatilityIndex: false,
      exactTradingValue: false,
    },
    notes: [],
    sectors: [{ code: input.sectorCode, name: input.sectorName }],
    tradeDates: [],
    instruments: [
      {
        id: input.symbol,
        symbol: input.symbol,
        name: input.name,
        market: "KOSPI",
        instrumentType: "STOCK",
        sectorCode: input.sectorCode,
        sectorName: input.sectorName,
        indexMemberships: [],
        isPreferredStock: false,
        isManagementIssue: false,
        isInvestmentWarning: false,
        isLeveraged: false,
        isInverse: false,
        isActive: true,
      },
    ],
    bars: {},
    indexSeries: [],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  };
}

describe("reviewed stock sector master", () => {
  it("contains exactly 613 unique stock symbols", () => {
    expect(REVIEWED_STOCK_SECTOR_COUNT).toBe(613);
    expect(Object.keys(REVIEWED_STOCK_SECTOR_BY_SYMBOL)).toHaveLength(613);
  });

  it("contains the 14 newly curated symbols outside the original 613 master", () => {
    expect(ADDITIONAL_STOCK_SECTOR_COUNT).toBe(14);
    expect(Object.keys(ADDITIONAL_STOCK_SECTOR_BY_SYMBOL)).toHaveLength(14);
    expect(resolveAdditionalStockSectorCode("000670")).toBe("CHEM_STEEL");
    expect(resolveAdditionalStockSectorCode("002030")).toBe("FINANCE");
    expect(resolveAdditionalStockSectorCode("005300")).toBe("CONSUMER");
    expect(resolveAdditionalStockSectorCode("032190")).toBe("SOFTWARE");
    expect(resolveAdditionalStockSectorCode("060280")).toBe("HEALTH_SVC");
    expect(resolveAdditionalStockSectorCode("069080")).toBe("TELCO_MEDIA");
    expect(resolveAdditionalStockSectorCode("194480")).toBe("TELCO_MEDIA");
    expect(resolveAdditionalStockSectorCode("394800")).toBe("BIO");
  });

  it("applies the user's final-sector overrides before legacy/name rules", () => {
    expect(resolveSectorCode("096770", "SK이노베이션", false)).toEqual({
      code: "BATTERY",
      name: "2차전지·소재",
    });
    expect(resolveSectorCode("009830", "한화솔루션", false)).toEqual({
      code: "CHEM_STEEL",
      name: "화학·철강·소재",
    });
    expect(resolveSectorCode("051900", "LG생활건강", false)).toEqual({
      code: "CONSUMER",
      name: "소비재·유통·식음료",
    });
    expect(resolveSectorCode("086900", "메디톡스", false)).toEqual({
      code: "HEALTH_SVC",
      name: "화장품·의료기기",
    });
    expect(resolveSectorCode("050890", "쏠리드", false)).toEqual({
      code: "TELCO_MEDIA",
      name: "통신·미디어·엔터",
    });
  });

  it("normalizes common CSV/Excel stock-code variants", () => {
    expect(normalizeReviewedStockSymbol("5930")).toBe("005930");
    expect(normalizeReviewedStockSymbol("005930.0")).toBe("005930");
    expect(normalizeReviewedStockSymbol("A005930")).toBe("005930");
    expect(resolveReviewedStockSectorCode("5930")).toBe("SEMI");
    expect(resolveSectorCode("5930", "삼성전자", false).code).toBe("SEMI");
  });

  it("replaces stale ETC sectors with the reviewed master before sector analysis", () => {
    const canonical = buildFullUniverseSectorDataset(
      singleStockDataset({
        symbol: "005930",
        name: "삼성전자",
        sectorCode: "ETC",
        sectorName: "기타",
      }),
    );
    expect(canonical.instruments[0]?.sectorCode).toBe("SEMI");
    expect(canonical.instruments[0]?.sectorName).toBe("반도체");
    expect(canonical.sectors.some((s) => s.code === "ETC")).toBe(false);
  });

  it("replaces Korean '기타' and ETC with the additional curated master", () => {
    for (const [sectorCode, sectorName] of [
      ["ETC", "기타"],
      ["기타", "기타"],
    ] as const) {
      const canonical = buildFullUniverseSectorDataset(
        singleStockDataset({
          symbol: "032190",
          name: "다우데이타",
          sectorCode,
          sectorName,
        }),
      );
      expect(canonical.instruments[0]?.sectorCode).toBe("SOFTWARE");
      expect(canonical.instruments[0]?.sectorName).toBe("인터넷·소프트웨어");
      expect(canonical.sectors.some((s) => s.code === "ETC" || s.code === "기타")).toBe(false);
    }
  });
});
