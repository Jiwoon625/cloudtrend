// 토스증권 Open API 어댑터 (서버 전용).
// https://openapi.tossinvest.com — OAuth2 client_credentials 로 토큰 발급 후 시세 조회.
// 이 파일은 절대 클라이언트로 반입되지 않습니다(*.server.ts 는 클라이언트 번들에서 차단).
import { NO_CAPABILITIES, type MarketDataset } from "./dataset";
import { KOSPI200_SYMBOLS } from "./kospi200";
import { THEME_SECTORS, resolveSectorCode } from "./sectors";
import type { DailyPrice, EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";

const BASE = "https://openapi.tossinvest.com";
const CANDLE_COUNT = 200; // API 최대
const CONCURRENCY = 4;
/** 데이터셋 캐시 유지 시간(밀리초) — 장중 반복 호출로 레이트리밋을 소모하지 않도록. */
const CACHE_TTL_MS = 10 * 60 * 1000;

export class TossConfigError extends Error {}


function credentials() {
  const clientId = process.env["TOSS_CLIENT_ID"];
  const clientSecret = process.env["TOSS_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new TossConfigError(
      "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다. 토스증권 Open API 키를 시크릿으로 저장해야 실데이터를 조회할 수 있습니다.",
    );
  }
  return { clientId, clientSecret };
}

export function hasTossCredentials(): boolean {
  return Boolean(process.env["TOSS_CLIENT_ID"] && process.env["TOSS_CLIENT_SECRET"]);
}

// 토스 Open API는 클라이언트당 "가장 최근에 발급된 토큰 1개"만 유효하며, 사실상 호출 1건 단위로
// 무효화되는 동작을 보인다. 따라서 호출마다 새 토큰을 발급하고, 토큰 발급 자체를 직렬 큐로 묶어
// 발급 레이트리밋(429)을 피한다.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 토큰 발급 간 최소 간격(ms) */
const TOKEN_GAP_MS = 130;
let tokenGate: Promise<unknown> = Promise.resolve();

function issueToken(): Promise<string | null> {
  const run = tokenGate.then(async () => {
    const { clientId, clientSecret } = credentials();
    const res = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 403 && text.includes("IP address not allowed")) {
        throw new TossIpError(
          "토스증권 API가 이 서버 IP를 거부했습니다(403 IP address not allowed). 토스증권 개발자센터 > 앱 설정에서 허용 IP에 서버 IP를 등록해야 합니다.",
        );
      }
      if (res.status === 429) return null; // 발급 한도 → 호출측에서 재시도
      if (res.status === 401) {
        throw new TossIpError(
          "토스증권 API가 클라이언트를 식별하지 못했습니다(401 unidentified-client). 1) TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 값이 유효한지, 2) 현재 서버 출구 IP가 토스증권 개발자센터 허용 IP에 등록되어 있는지 확인해 주세요.",
        );
      }
      throw new Error(`토스증권 토큰 발급 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token: string };
    return json.access_token;
  });
  tokenGate = run.then(
    () => sleep(TOKEN_GAP_MS),
    () => sleep(TOKEN_GAP_MS * 5),
  );
  return run;
}

export class TossIpError extends Error {}

const MAX_ATTEMPTS = 8;

async function api<T>(
  path: string,
  params: Record<string, string | number | boolean> = {},
  attempt = 0,
): Promise<T> {
  const token = await issueToken();
  if (!token) {
    if (attempt >= MAX_ATTEMPTS) throw new Error("토스증권 토큰 발급 한도(429)를 초과했습니다.");
    await sleep(600 * (attempt + 1));
    return api<T>(path, params, attempt + 1);
  }
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 429) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(250 * (attempt + 1));
      return api<T>(path, params, attempt + 1);
    }
    throw new Error(
      res.status === 401
        ? "토스증권 API 인증 실패(401) — 토큰이 반복적으로 무효화되었습니다."
        : "토스증권 API 호출 한도(429) 초과 — 잠시 후 다시 시도하세요.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`토스증권 API 오류 ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  // 토스 Open API는 모든 성공 응답을 { result: ... } 로 감싸서 반환한다.
  const json = (await res.json()) as { result?: T } | T;
  if (json && typeof json === "object" && "result" in (json as Record<string, unknown>)) {
    return (json as { result: T }).result;
  }
  return json as T;
}


async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// 응답 타입
// ---------------------------------------------------------------------------
interface RankingItem {
  rank: number;
  symbol: string;
  price: { lastPrice: string; basePrice: string; changeRate: string | null };
  tradingVolume: string;
  tradingAmount: string;
}
interface Candle {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
}
interface ListedStock {
  symbol: string;
  name: string;
  securityType: string;
  isCommonShare: boolean;
  isinCode: string;
}
/** GET /api/v1/stocks 상세 — 발행주식수(sharesOutstanding) 제공 */
interface StockInfo {
  symbol: string;
  name: string;
  securityType: string;
  isCommonShare: boolean;
  status: string;
  sharesOutstanding: string | null;
  leverageFactor: string | number | null;
}
interface InvestorTradingRecord {
  date: string;
  foreigner: { buyAmount: string; sellAmount: string };
  institution: { buyAmount: string; sellAmount: string };
}

const num = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
/** ISO 타임스탬프 → KST 거래일(YYYY-MM-DD) */
function toTradeDate(ts: string): string {
  const d = new Date(ts);
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function candlesToBars(candles: Candle[]): DailyPrice[] {
  return candles
    .map((c) => {
      const close = num(c.closePrice);
      const volume = num(c.volume);
      return {
        tradeDate: toTradeDate(c.timestamp),
        open: num(c.openPrice),
        high: num(c.highPrice),
        low: num(c.lowPrice),
        close,
        volume,
        // 토스 캔들은 거래대금을 주지 않으므로 종가×거래량 근사 (capabilities.exactTradingValue = false)
        tradingValue: close * volume,
        marketCap: null,
        foreignNetBuyValue: null,
        institutionNetBuyValue: null,
      } satisfies DailyPrice;
    })
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

async function fetchCandles(symbol: string): Promise<DailyPrice[]> {
  try {
    const res = await api<{ candles: Candle[] }>("/api/v1/candles", {
      symbol,
      interval: "1d",
      count: CANDLE_COUNT,
      adjusted: true,
    });
    return candlesToBars(res.candles ?? []);
  } catch {
    return [];
  }
}

/** 종목 상세(발행주식수 포함)를 200건 단위로 조회. 시가총액 = 발행주식수 × 종가 */
async function fetchStockInfos(symbols: string[]): Promise<Map<string, StockInfo>> {
  const out = new Map<string, StockInfo>();
  for (let i = 0; i < symbols.length; i += 200) {
    const chunk = symbols.slice(i, i + 200);
    try {
      const res = await api<StockInfo[] | { stocks: StockInfo[] }>("/api/v1/stocks", {
        symbols: chunk.join(","),
      });
      const list = Array.isArray(res) ? res : (res.stocks ?? []);
      for (const s of list) out.set(s.symbol, s);
    } catch {
      // 상세 조회 실패 시 해당 청크는 시가총액 없음으로 남긴다.
    }
  }
  return out;
}



async function fetchIndex(symbol: string, name: string): Promise<IndexSeries | null> {
  try {
    const res = await api<{ candles: Candle[] }>(
      `/api/v1/market-indicators/${encodeURIComponent(symbol)}/candles`,
      { symbol, interval: "1d", count: CANDLE_COUNT },
    );
    const bars = candlesToBars(res.candles ?? []);
    if (bars.length === 0) return null;
    return { indexCode: symbol, indexName: name, bars };
  } catch {
    return null;
  }
}

/** 시장 전체 투자자별 매매대금(원)을 지수 시계열에 주입해 시장 게이트에서 사용 */
async function attachMarketInvestorFlow(series: IndexSeries, symbol: string) {
  try {
    const res = await api<{ records: InvestorTradingRecord[] }>(
      `/api/v1/market-indicators/${encodeURIComponent(symbol)}/investor-trading`,
      { symbol, interval: "1d", count: 30 },
    );
    const byDate = new Map(
      (res.records ?? []).map((r) => [
        r.date,
        {
          foreign: num(r.foreigner.buyAmount) - num(r.foreigner.sellAmount),
          inst: num(r.institution.buyAmount) - num(r.institution.sellAmount),
        },
      ]),
    );
    for (const bar of series.bars) {
      const rec = byDate.get(bar.tradeDate);
      if (rec) {
        bar.foreignNetBuyValue = rec.foreign;
        bar.institutionNetBuyValue = rec.inst;
      }
    }
    return byDate.size > 0;
  } catch {
    return false;
  }
}

/** 일봉 캐시 — 종목당 1회 수집 후 유지(장중에는 최신 봉만 갱신되므로 TTL을 길게 둔다). */
const BAR_TTL_MS = 60 * 60 * 1000;
const barStore = new Map<string, { bars: DailyPrice[]; at: number }>();
const sharesStore = new Map<string, { shares: number; leverageFactor: number | null }>();
/** 수집 대기 상한 — 이 시간 안에 모인 종목으로 먼저 화면을 그리고, 남은 종목은 계속 수집한다. */
const COLLECT_WAIT_MS = 25_000;
/** 최초 화면을 그리기 위한 최소 종목 수 */
const MIN_READY = 30;

let collecting: Promise<void> | null = null;
let collectProgress = { done: 0, total: 0 };

/** 유니버스 전체의 일봉을 백그라운드에서 순차 수집한다(중복 실행 방지). */
function startCollection(symbols: string[]): Promise<void> {
  if (collecting) return collecting;
  const stale = symbols.filter((s) => {
    const hit = barStore.get(s);
    return !hit || Date.now() - hit.at > BAR_TTL_MS;
  });
  collectProgress = { done: symbols.length - stale.length, total: symbols.length };
  collecting = mapLimited(stale, CONCURRENCY, async (symbol) => {
    const bars = await fetchCandles(symbol);
    if (bars.length > 0) barStore.set(symbol, { bars, at: Date.now() });
    collectProgress.done++;
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      collecting = null;
    });
  return collecting;
}

const ETF_TYPES = new Set(["ETF", "FOREIGN_ETF", "ETN"]);
const isLeveragedName = (n: string) => /레버리지|2X|2배|곱버스/i.test(n);
const isInverseName = (n: string) => /인버스|곱버스/i.test(n);

let cache: { dataset: MarketDataset; at: number } | null = null;
let indexCache: { kospi: IndexSeries; kosdaq: IndexSeries | null; flowOk: boolean; at: number } | null =
  null;

// 사용자가 홈 화면에서 업로드한 유니버스(코스피200 CSV). 설정되면 내장 스냅샷 대신 사용한다.
let universeOverride: { symbols: string[]; at: number } | null = null;

export function setUniverseOverride(symbols: string[]): number {
  const unique = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
  universeOverride = unique.length > 0 ? { symbols: unique, at: Date.now() } : null;
  cache = null; // 다음 요청에서 새 유니버스로 재구성
  return unique.length;
}

export function getUniverseOverride(): { count: number; uploadedAt: string } | null {
  return universeOverride
    ? { count: universeOverride.symbols.length, uploadedAt: new Date(universeOverride.at).toISOString() }
    : null;
}

// 사용자가 직접 입력한 ETF 종목코드 목록. 설정되면 거래대금 상위 ETF 대신 사용한다.
let etfOverride: { symbols: string[]; at: number } | null = null;

export function setEtfUniverseOverride(symbols: string[]): string[] {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  etfOverride = unique.length > 0 ? { symbols: unique, at: Date.now() } : null;
  cache = null;
  return unique;
}

export function getEtfUniverseOverride(): { symbols: string[]; updatedAt: string } | null {
  return etfOverride
    ? { symbols: etfOverride.symbols, updatedAt: new Date(etfOverride.at).toISOString() }
    : null;
}




export interface TossDatasetOptions {
  /** 함께 스크리닝할 ETF 수 (거래대금 상위) */
  etfCount?: number;
}

/**
 * KOSPI200 구성종목(시가총액 상위 200 스냅샷) 전체와 거래대금 상위 ETF를 유니버스로 삼아
 * 일봉 200개를 수집해 MarketDataset을 구성한다.
 * 토스 Open API가 제공하지 않는 항목(재무·ETF NAV)은 capabilities에서 false로 선언한다.
 */
export async function buildTossDataset(opts: TossDatasetOptions = {}): Promise<MarketDataset> {
  const etfCount = Math.min(60, Math.max(0, opts.etfCount ?? 20));
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.dataset;
  credentials();

  const [ranking, kospiList, kosdaqList] = await Promise.all([
    api<{ rankings: RankingItem[] }>("/api/v1/rankings", {
      type: "MARKET_TRADING_AMOUNT",
      marketCountry: "KR",
      duration: "1d",
      count: 100,
      excludeInvestmentCaution: true,
    }),
    api<{ stocks: ListedStock[] } | ListedStock[]>("/api/v1/stocks/all", {
      market: "KOSPI",
      status: "ACTIVE",
    }),
    api<{ stocks: ListedStock[] } | ListedStock[]>("/api/v1/stocks/all", {
      market: "KOSDAQ",
      status: "ACTIVE",
    }),
  ]);

  const listOf = (r: { stocks: ListedStock[] } | ListedStock[]): ListedStock[] =>
    Array.isArray(r) ? r : (r.stocks ?? []);
  const meta = new Map<string, { listed: ListedStock; market: "KOSPI" | "KOSDAQ" }>();
  for (const s of listOf(kospiList)) meta.set(s.symbol, { listed: s, market: "KOSPI" });
  for (const s of listOf(kosdaqList)) meta.set(s.symbol, { listed: s, market: "KOSDAQ" });

  const rankings = ranking.rankings ?? [];
  const amountBySymbol = new Map(rankings.map((r) => [r.symbol, num(r.tradingAmount)]));

  // 유니버스: KOSPI200 구성종목 + 거래대금 상위 ETF
  const baseSymbols = universeOverride?.symbols ?? KOSPI200_SYMBOLS;
  const kospi200 = baseSymbols.filter((s) => meta.has(s));

  const etfSymbols = etfOverride
    ? etfOverride.symbols.filter((s) => meta.has(s))
    : rankings
        .filter((r) => {
          const m = meta.get(r.symbol);
          return m ? ETF_TYPES.has(m.listed.securityType) : false;
        })
        .slice(0, etfCount)
        .map((r) => r.symbol);

  const universe = [...kospi200, ...etfSymbols];

  // 지수 시계열(캐시)
  if (!indexCache || Date.now() - indexCache.at > CACHE_TTL_MS) {
    const kospi = await fetchIndex("KOSPI", "코스피");
    if (!kospi) throw new Error("코스피 지수 일봉을 가져오지 못했습니다.");
    const kosdaq = await fetchIndex("KOSDAQ", "코스닥");
    const flowOk = await attachMarketInvestorFlow(kospi, "KOSPI");
    indexCache = { kospi, kosdaq, flowOk, at: Date.now() };
  }
  const { kospi: kospiIdx, kosdaq: kosdaqIdx, flowOk: marketFlowOk } = indexCache;

  // 발행주식수(시가총액 계산용) — 200건 단위 배치
  const missingShares = universe.filter((s) => !sharesStore.has(s));
  if (missingShares.length > 0) {
    const infos = await fetchStockInfos(missingShares);
    for (const s of missingShares) {
      const info = infos.get(s);
      sharesStore.set(s, {
        shares: info?.sharesOutstanding ? Number(info.sharesOutstanding) : 0,
        leverageFactor: info?.leverageFactor != null ? Number(info.leverageFactor) : null,
      });
    }
  }

  // 일봉 수집 — 대기 시간 안에 모인 종목으로 우선 구성하고 나머지는 백그라운드 계속 수집
  const job = startCollection(universe);
  const deadline = Date.now() + COLLECT_WAIT_MS;
  const ready = () => universe.filter((s) => barStore.has(s)).length;
  let finished = false;
  void job.then(() => {
    finished = true;
  });
  while (!finished && Date.now() < deadline) {
    if (ready() >= Math.max(MIN_READY, universe.length)) break;
    await sleep(400);
  }

  const instruments: Instrument[] = [];
  const bars: Record<string, DailyPrice[]> = {};
  const usedSectors = new Set<string>();
  let marketCapCount = 0;

  for (const symbol of universe) {
    const hit = barStore.get(symbol);
    if (!hit || hit.bars.length === 0) continue;
    const m = meta.get(symbol)!;
    const isEtf = ETF_TYPES.has(m.listed.securityType);
    const b = hit.bars.map((bar) => ({ ...bar }));

    // 최신 봉의 거래대금은 랭킹 실측값으로 교체
    const amount = amountBySymbol.get(symbol) ?? 0;
    if (amount > 0) b[b.length - 1]!.tradingValue = amount;

    // 시가총액 = 발행주식수 × 해당일 종가 (발행주식수는 최신 스냅샷이므로 과거 봉은 근사치)
    const share = sharesStore.get(symbol);
    if (share && share.shares > 0) {
      marketCapCount++;
      for (const bar of b) bar.marketCap = share.shares * bar.close;
    }

    const leverageFactor = share?.leverageFactor ?? null;
    const sector = resolveSectorCode(symbol, m.listed.name, isEtf);
    usedSectors.add(sector.code);

    instruments.push({
      id: symbol,
      symbol,
      name: m.listed.name,
      market: isEtf ? "ETF" : m.market,
      instrumentType: isEtf ? "ETF" : "STOCK",
      sectorCode: sector.code,
      sectorName: sector.name,
      indexMemberships: isEtf ? [] : ["KOSPI200", "KRX300"],
      isPreferredStock: !isEtf && !m.listed.isCommonShare,
      isManagementIssue: false,
      isInvestmentWarning: false,
      isLeveraged:
        isEtf &&
        (isLeveragedName(m.listed.name) ||
          (leverageFactor !== null && Math.abs(leverageFactor) > 1)),
      isInverse:
        isEtf && (isInverseName(m.listed.name) || (leverageFactor !== null && leverageFactor < 0)),
      isActive: true,
    });
    bars[symbol] = b;
  }

  if (instruments.length === 0) {
    throw new Error("토스증권 API에서 유효한 종목 일봉을 가져오지 못했습니다.");
  }

  const indexSeries: IndexSeries[] = [kospiIdx, ...(kosdaqIdx ? [kosdaqIdx] : [])];
  const tradeDates = kospiIdx.bars.map((b) => b.tradeDate);
  const asOfDate = tradeDates[tradeDates.length - 1]!;
  const stockCount = instruments.filter((i) => i.instrumentType === "STOCK").length;
  const pending = universe.length - instruments.length;

  const dataset: MarketDataset = {
    provider: "TOSS_OPEN_API",
    version: `toss-${asOfDate}`,
    asOfDate,
    isLive: true,
    capabilities: {
      ...NO_CAPABILITIES,
      exactTradingValue: false,
      investorFlow: marketFlowOk,
      marketCap: marketCapCount > 0,
      sectors: true,
    },
    notes: [
      `토스증권 Open API 실데이터 — 주식 ${stockCount}종목(업로드 유니버스 또는 KOSPI200 스냅샷) + ETF ${instruments.length - stockCount}종목, 일봉 최대 ${CANDLE_COUNT}개(≈9개월).`,
      pending > 0
        ? `일봉 수집이 진행 중입니다(${instruments.length}/${universe.length}종목 완료). 잠시 후 새로고침하면 남은 ${pending}종목이 추가된 결과를 볼 수 있습니다.`
        : `유니버스 ${universe.length}종목 전체의 일봉 수집이 완료되었습니다.`,
      "유니버스를 직접 업로드하지 않으면(코스피/코스닥 CSV), 토스 Open API가 지수 구성종목을 제공하지 않아, 코스피 보통주를 발행주식수×종가 시가총액으로 정렬한 상위 200종목 스냅샷을 사용합니다(실제 KRX 정기변경과 소수 종목이 다를 수 있습니다).",
      marketCapCount > 0
        ? `시가총액은 발행주식수(종목 상세) × 해당일 종가로 계산합니다(${marketCapCount}/${instruments.length}종목). 발행주식수는 최신 스냅샷이라 과거 봉의 시가총액은 근사치입니다.`
        : "발행주식수를 가져오지 못해 시가총액은 “데이터 없음”으로 처리됩니다.",
      "업종(섹터)은 토스 Open API가 제공하지 않아, 프로젝트에 내장한 테마 섹터 매핑(종목코드 기준, ETF는 상품명 규칙)으로 분류합니다. 섹터지수 시계열이 없어 섹터 상대강도는 구성종목 집계로 산출합니다.",
      "토스 Open API는 재무제표·ETF NAV/총보수를 제공하지 않습니다. 해당 규칙과 점수 항목은 “데이터 없음”으로 표시되고 가중치에서 제외됩니다(0점 처리 아님).",
      "종목별 거래대금은 거래대금 상위 100위 내 종목의 최신 거래일만 실측값이며, 그 외에는 종가×거래량 근사치입니다.",
      marketFlowOk
        ? "시장 게이트의 외국인 순매수는 코스피 전체 투자자별 매매대금 실측값을 사용합니다."
        : "투자자별 매매대금을 가져오지 못해 외국인 수급 판정은 “데이터 없음”으로 처리됩니다.",
      `데이터는 ${CACHE_TTL_MS / 60000}분간 캐시됩니다.`,
    ],
    sectors: THEME_SECTORS.filter((s) => usedSectors.has(s.code)),
    tradeDates,
    instruments,
    bars,
    indexSeries,
    financials: {} as Record<string, FinancialFacts>,
    etfFacts: {} as Record<string, EtfFacts>,
    vkospiSeries: [],
  };

  // 수집이 끝나지 않았으면 캐시를 짧게 유지해 다음 요청에서 갱신되도록 한다.
  cache = { dataset, at: pending > 0 ? Date.now() - CACHE_TTL_MS + 20_000 : Date.now() };
  return dataset;
}
