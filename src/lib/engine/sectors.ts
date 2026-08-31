// 테마 중심 업종(섹터) 분류 테이블.
// 토스증권 Open API는 업종 분류를 제공하지 않으므로, KRX 업종을 실제 순환매 흐름에 맞춘
// 13개 테마 섹터로 재편해 프로젝트 안에 정적 매핑으로 내장한다.
// - 개별 주식: 종목코드 → 섹터 (SYMBOL_SECTOR)
// - ETF/ETN: 상품명 키워드 → 섹터 (ETF_KEYWORD_RULES)
// - 매핑에 없으면 "ETC"(기타)로 분류한다.

export interface SectorDef {
  code: string;
  name: string;
}

export const THEME_SECTORS: SectorDef[] = [
  { code: "SEMI", name: "반도체" },
  { code: "BATTERY", name: "2차전지·소재" },
  { code: "AUTO", name: "자동차·부품" },
  { code: "BIO", name: "제약·바이오" },
  { code: "IT_HW", name: "IT·전자부품" },
  { code: "SOFTWARE", name: "인터넷·소프트웨어" },
  { code: "FINANCE", name: "금융·지주" },
  { code: "SHIP_DEF", name: "조선·방산·기계" },
  { code: "CHEM_STEEL", name: "화학·철강·소재" },
  { code: "ENERGY", name: "에너지·유틸리티" },
  { code: "CONSUMER", name: "소비재·유통·식음료" },
  { code: "HEALTH_SVC", name: "화장품·의료기기" },
  { code: "TELCO_MEDIA", name: "통신·미디어·엔터" },
  { code: "CONSTRUCT", name: "건설·운송" },
  { code: "MARKET_IDX", name: "시장지수·파생" },
  { code: "ETC", name: "기타" },
];

export const SECTOR_NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  THEME_SECTORS.map((s) => [s.code, s.name]),
);

/** 종목코드 → 테마 섹터 (시가총액·거래대금 상위 종목 중심) */
export const SYMBOL_SECTOR: Record<string, string> = {
  // 반도체
  "005930": "SEMI", // 삼성전자
  "005935": "SEMI",
  "000660": "SEMI", // SK하이닉스
  "042700": "SEMI", // 한미반도체
  "058470": "SEMI", // 리노공업
  "240810": "SEMI", // 원익IPS
  "357780": "SEMI", // 솔브레인
  "403870": "SEMI", // HPSP
  "095340": "SEMI", // ISC
  "222800": "SEMI", // 심텍
  "036930": "SEMI", // 주성엔지니어링
  "108320": "SEMI", // LX세미콘
  "005290": "SEMI", // 동진쎄미켐
  "039030": "SEMI", // 이오테크닉스
  "089030": "SEMI", // 테크윙
  "084370": "SEMI", // 유진테크
  "140860": "SEMI", // 파크시스템스
  "348370": "SEMI", // 엔켐 (배터리 전해질이나 소재)
  "000990": "SEMI", // DB하이텍
  "064760": "SEMI", // 티씨케이
  "166090": "SEMI", // 하나머티리얼즈
  "196170": "BIO", // 알테오젠 (아래 BIO 중복 방지용 명시)

  // 2차전지·소재
  "373220": "BATTERY", // LG에너지솔루션
  "006400": "BATTERY", // 삼성SDI
  "096770": "ENERGY", // SK이노베이션
  "247540": "BATTERY", // 에코프로비엠
  "086520": "BATTERY", // 에코프로
  "066970": "BATTERY", // 엘앤에프
  "003670": "BATTERY", // 포스코퓨처엠
  "137400": "BATTERY", // 피엔티
  "278280": "BATTERY", // 천보
  "020150": "BATTERY", // 롯데에너지머티리얼즈
  "121600": "BATTERY", // 나노신소재
  "112610": "ENERGY", // 씨에스윈드

  // 자동차·부품
  "005380": "AUTO", // 현대차
  "005387": "AUTO",
  "000270": "AUTO", // 기아
  "012330": "AUTO", // 현대모비스
  "204320": "AUTO", // HL만도
  "018880": "AUTO", // 한온시스템
  "011210": "AUTO", // 현대위아
  "161390": "AUTO", // 한국타이어앤테크놀로지
  "298040": "AUTO", // 효성중공업(전력기기) -> 기계로 재분류
  "064960": "AUTO", // SNT모티브

  // 제약·바이오
  "207940": "BIO", // 삼성바이오로직스
  "068270": "BIO", // 셀트리온
  "128940": "BIO", // 한미약품
  "000100": "BIO", // 유한양행
  "302440": "BIO", // SK바이오사이언스
  "326030": "BIO", // SK바이오팜
  "196300": "BIO", // 애니젠
  "145020": "BIO", // 휴젤
  "085660": "BIO", // 차바이오텍
  "091990": "BIO", // 셀트리온헬스케어
  "141080": "BIO", // 리가켐바이오
  "298380": "BIO", // 에이비엘바이오
  "214450": "BIO", // 파마리서치
  "003220": "BIO", // 대원제약
  "185750": "BIO", // 종근당
  "009420": "BIO", // 한올바이오파마
  "096530": "BIO", // 씨젠
  "348210": "BIO", // 넥스틴

  // IT·전자부품
  "009150": "IT_HW", // 삼성전기
  "011070": "IT_HW", // LG이노텍
  "066570": "IT_HW", // LG전자
  "034220": "IT_HW", // LG디스플레이
  "007660": "IT_HW", // 이수페타시스
  "092190": "IT_HW", // 서우
  "178320": "IT_HW", // 서진시스템
  "137950": "IT_HW", // 제이앤티씨
  "058610": "IT_HW", // 에스피지

  // 인터넷·소프트웨어
  "035420": "SOFTWARE", // NAVER
  "035720": "SOFTWARE", // 카카오
  "377300": "SOFTWARE", // 카카오페이
  "323410": "SOFTWARE", // 카카오뱅크
  "259960": "SOFTWARE", // 크래프톤
  "036570": "SOFTWARE", // 엔씨소프트
  "251270": "SOFTWARE", // 넷마블
  "263750": "SOFTWARE", // 펄어비스
  "293490": "SOFTWARE", // 카카오게임즈
  "112040": "SOFTWARE", // 위메이드
  "053800": "SOFTWARE", // 안랩
  "018260": "SOFTWARE", // 삼성에스디에스
  "030520": "SOFTWARE", // 한글과컴퓨터
  "376300": "SOFTWARE", // 디어유
  "095660": "SOFTWARE", // 네오위즈

  // 금융·지주
  "105560": "FINANCE", // KB금융
  "055550": "FINANCE", // 신한지주
  "086790": "FINANCE", // 하나금융지주
  "316140": "FINANCE", // 우리금융지주
  "024110": "FINANCE", // 기업은행
  "138040": "FINANCE", // 메리츠금융지주
  "032830": "FINANCE", // 삼성생명
  "000810": "FINANCE", // 삼성화재
  "005830": "FINANCE", // DB손해보험
  "071050": "FINANCE", // 한국금융지주
  "006800": "FINANCE", // 미래에셋증권
  "016360": "FINANCE", // 삼성증권
  "039490": "FINANCE", // 키움증권
  "003550": "FINANCE", // LG
  "034730": "FINANCE", // SK
  "003410": "FINANCE", // 삼양홀딩스
  "029780": "FINANCE", // 삼성카드
  "088350": "FINANCE", // 한화생명
  "078930": "ENERGY", // GS

  // 조선·방산·기계
  "042660": "SHIP_DEF", // 한화오션
  "009540": "SHIP_DEF", // HD한국조선해양
  "329180": "SHIP_DEF", // HD현대중공업
  "010140": "SHIP_DEF", // 삼성중공업
  "012450": "SHIP_DEF", // 한화에어로스페이스
  "047810": "SHIP_DEF", // 한국항공우주
  "079550": "SHIP_DEF", // LIG넥스원
  "064350": "SHIP_DEF", // 현대로템
  "272210": "SHIP_DEF", // 한화시스템
  "267250": "SHIP_DEF", // HD현대
  "042670": "SHIP_DEF", // HD현대인프라코어
  "241560": "SHIP_DEF", // 두산밥캣
  "034020": "SHIP_DEF", // 두산에너빌리티
  "000150": "SHIP_DEF", // 두산
  "017800": "SHIP_DEF", // 현대엘리베이터
  "010120": "SHIP_DEF", // LS ELECTRIC
  "006260": "SHIP_DEF", // LS
  "103140": "SHIP_DEF", // 풍산

  // 화학·철강·소재
  "005490": "CHEM_STEEL", // POSCO홀딩스
  "051910": "CHEM_STEEL", // LG화학
  "011170": "CHEM_STEEL", // 롯데케미칼
  "010130": "CHEM_STEEL", // 고려아연
  "004020": "CHEM_STEEL", // 현대제철
  "001430": "CHEM_STEEL", // 세아베스틸지주
  "298050": "CHEM_STEEL", // 효성첨단소재
  "285130": "CHEM_STEEL", // SK케미칼
  "011790": "CHEM_STEEL", // SKC
  "014680": "CHEM_STEEL", // 한솔케미칼
  "120110": "CHEM_STEEL", // 코오롱인더
  "002380": "CHEM_STEEL", // KCC
  "093370": "CHEM_STEEL", // 후성
  "104830": "CHEM_STEEL", // 원익머트리얼즈

  // 에너지·유틸리티
  "015760": "ENERGY", // 한국전력
  "036460": "ENERGY", // 한국가스공사
  "010950": "ENERGY", // S-Oil
  "267260": "ENERGY", // HD현대일렉트릭
  "009830": "ENERGY", // 한화솔루션
  "051600": "ENERGY", // 한전KPS
  "052690": "ENERGY", // 한전기술
  "336260": "ENERGY", // 두산퓨얼셀

  // 소비재·유통·식음료
  "097950": "CONSUMER", // CJ제일제당
  "271560": "CONSUMER", // 오리온
  "004370": "CONSUMER", // 농심
  "033780": "CONSUMER", // KT&G
  "000080": "CONSUMER", // 하이트진로
  "007310": "CONSUMER", // 오뚜기
  "280360": "CONSUMER", // 롯데웰푸드
  "005180": "CONSUMER", // 빙그레
  "023530": "CONSUMER", // 롯데쇼핑
  "004170": "CONSUMER", // 신세계
  "139480": "CONSUMER", // 이마트
  "161890": "HEALTH_SVC", // 한국콜마
  "192820": "HEALTH_SVC", // 코스맥스
  "090430": "HEALTH_SVC", // 아모레퍼시픽
  "002790": "HEALTH_SVC", // 아모레홀딩스
  "051900": "HEALTH_SVC", // LG생활건강
  "018290": "HEALTH_SVC", // 브이티
  "237880": "HEALTH_SVC", // 클리오
  "241710": "HEALTH_SVC", // 코스메카코리아
  "085370": "HEALTH_SVC", // 루트로닉
  "048260": "HEALTH_SVC", // 오스템임플란트
  "086900": "HEALTH_SVC", // 메디톡스
  "046890": "HEALTH_SVC", // 서울반도체

  // 통신·미디어·엔터
  "017670": "TELCO_MEDIA", // SK텔레콤
  "030200": "TELCO_MEDIA", // KT
  "032640": "TELCO_MEDIA", // LG유플러스
  "352820": "TELCO_MEDIA", // 하이브
  "041510": "TELCO_MEDIA", // 에스엠
  "122870": "TELCO_MEDIA", // 와이지엔터테인먼트
  "035900": "TELCO_MEDIA", // JYP Ent.
  "079160": "TELCO_MEDIA", // CJ CGV
  "253450": "TELCO_MEDIA", // 스튜디오드래곤
  "035760": "TELCO_MEDIA", // CJ ENM

  // 건설·운송
  "000720": "CONSTRUCT", // 현대건설
  "028260": "CONSTRUCT", // 삼성물산
  "047040": "CONSTRUCT", // 대우건설
  "375500": "CONSTRUCT", // DL이앤씨
  "006360": "CONSTRUCT", // GS건설
  "003490": "CONSTRUCT", // 대한항공
  "020560": "CONSTRUCT", // 아시아나항공
  "011200": "CONSTRUCT", // HMM
  "086280": "CONSTRUCT", // 현대글로비스
  "000120": "CONSTRUCT", // CJ대한통운
  "298020": "CONSTRUCT", // 효성티앤씨
};

/** ETF/ETN 상품명 키워드 → 섹터 (앞선 규칙이 우선) */
const ETF_KEYWORD_RULES: Array<[RegExp, string]> = [
  [/반도체|메모리|HBM|시스템반도체|소부장/i, "SEMI"],
  [/2차전지|이차전지|배터리|리튬|전기차/i, "BATTERY"],
  [/자동차|모빌리티/i, "AUTO"],
  [/바이오|헬스케어|제약|의료/i, "BIO"],
  [/게임|인터넷|소프트웨어|플랫폼|AI|클라우드|메타버스/i, "SOFTWARE"],
  [/은행|증권|보험|금융|지주|배당|고배당|리츠|채권|국고채|금리|달러|원유|금현물|현금/i, "FINANCE"],
  [/조선|방산|우주항공|기계|중공업|건설기계/i, "SHIP_DEF"],
  [/화학|철강|소재|비철|구리|알루미늄/i, "CHEM_STEEL"],
  [/에너지|태양광|수소|풍력|전력|원자력|원전|유틸/i, "ENERGY"],
  [/소비재|유통|식품|음식료|필수소비/i, "CONSUMER"],
  [/화장품|미용|뷰티/i, "HEALTH_SVC"],
  [/통신|미디어|엔터|콘텐츠|K-?POP/i, "TELCO_MEDIA"],
  [/건설|운송|리테일부동산|인프라/i, "CONSTRUCT"],
  [/200|코스피|코스닥|KRX|레버리지|인버스|top\s?10|TOP10|밸류업|배당성장|종합/i, "MARKET_IDX"],
];

/** 종목의 테마 섹터 코드를 반환한다. */
export function resolveSectorCode(
  symbol: string,
  name: string,
  isEtf: boolean,
): { code: string; name: string } {
  let code = isEtf ? undefined : SYMBOL_SECTOR[symbol];
  if (!code) {
    if (isEtf) {
      code = ETF_KEYWORD_RULES.find(([re]) => re.test(name))?.[1];
    } else {
      code = SYMBOL_SECTOR[symbol];
    }
  }
  const resolved = code ?? "ETC";
  return { code: resolved, name: SECTOR_NAME_BY_CODE[resolved] ?? "기타" };
}
