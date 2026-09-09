// 2026-09-09 섹터 탭에서 최종 검토 613종목 마스터 밖에 남아 있던 14개 종목의 수동 확정 매핑.
//
// 기준: 회사의 주력 사업/경제적 노출을 CloudTrend 15개 섹터 체계에 맞춰 분류한다.
// 이 파일은 613종목 엑셀 원본 마스터와 분리해, 이후 신규 편입 종목을 안전하게 추가 관리한다.

import { SYMBOL_SECTOR } from "./sectors";
import { normalizeReviewedStockSymbol } from "./stockSectorMaster";

export const ADDITIONAL_STOCK_SECTOR_BY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({
  // 비철금속·특수화학
  "000670": "CHEM_STEEL", // 영풍 — 아연 제련/비철금속
  "002840": "CHEM_STEEL", // 미원상사 — 계면활성제·특수화학
  "069260": "CHEM_STEEL", // TKG휴켐스 — 정밀화학/질산계 제품

  // 지주회사
  "002030": "FINANCE", // 아세아 — 지주회사(시멘트·제지 등 자회사)

  // 소비재·유통·식음료
  "005300": "CONSUMER", // 롯데칠성 — 음료·주류
  "009240": "CONSUMER", // 한샘 — 가구·인테리어·생활소비재
  "026960": "CONSUMER", // 동서 — 식품 유통·제조
  "036620": "CONSUMER", // 감성코퍼레이션 — 패션/의류

  // 인터넷·소프트웨어
  "032190": "SOFTWARE", // 다우데이타 — SW·PG·VAN·IT 서비스
  "042000": "SOFTWARE", // 카페24 — 이커머스 플랫폼/SaaS

  // 화장품·의료기기
  "060280": "HEALTH_SVC", // 큐렉소 — 수술로봇·의료기기

  // 통신·미디어·엔터
  "069080": "TELCO_MEDIA", // 웹젠 — 게임
  "194480": "TELCO_MEDIA", // 데브시스터즈 — 게임

  // 제약·바이오
  "394800": "BIO", // 쓰리빌리언 — AI 기반 희귀질환 유전체 진단
});

export const ADDITIONAL_STOCK_SECTOR_COUNT = Object.keys(
  ADDITIONAL_STOCK_SECTOR_BY_SYMBOL,
).length;

export function resolveAdditionalStockSectorCode(symbol: string): string | undefined {
  return ADDITIONAL_STOCK_SECTOR_BY_SYMBOL[normalizeReviewedStockSymbol(symbol)];
}

// 전역 종목코드 해석에서도 종목명 휴리스틱보다 이 수동 확정값을 우선한다.
Object.assign(SYMBOL_SECTOR, ADDITIONAL_STOCK_SECTOR_BY_SYMBOL);
