import { describe, expect, it } from "vitest";

import "./dataset";
import {
  REVIEWED_STOCK_SECTOR_BY_SYMBOL,
  REVIEWED_STOCK_SECTOR_COUNT,
} from "./stockSectorMaster";
import { resolveSectorCode } from "./sectors";

describe("reviewed stock sector master", () => {
  it("contains exactly 613 unique stock symbols", () => {
    expect(REVIEWED_STOCK_SECTOR_COUNT).toBe(613);
    expect(Object.keys(REVIEWED_STOCK_SECTOR_BY_SYMBOL)).toHaveLength(613);
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
});
