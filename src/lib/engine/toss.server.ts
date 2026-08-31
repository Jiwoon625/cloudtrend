// 토스증권 Open API 어댑터 (서버 전용).
// https://openapi.tossinvest.com — OAuth2 client_credentials 로 토큰 발급 후 시세 조회.
// 이 파일은 절대 클라이언트로 반입되지 않습니다(*.server.ts 는 클라이언트 번들에서 차단).
import { NO_CAPABILITIES, type MarketDataset } from "./dataset";
import type { DailyPrice, EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";

const BASE = "https://openapi.tossinvest.com";
const CANDLE_COUNT = 200; // API 최대
const CONCURRENCY = 4;
/** 데이터셋 캐시 유지 시간(밀리초) — 장중 반복 호출로 레이트리밋을 소모하지 않도록. */
const CACHE_TTL_MS = 10 * 60 * 1000;

export class TossConfigError extends Error {}

interface TokenState {
  token: string;
  expiresAt: number;
}
let tokenState: TokenState | null = null;

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

// 토큰 발급을 단일화(single-flight)한다. 동시에 여러 번 발급하면 이전 토큰이 무효화되어 401이 발생한다.
let tokenInflight: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenState && tokenState.expiresAt > now + 60_000) return tokenState.token;
  if (tokenInflight) return tokenInflight;
  tokenInflight = issueToken().finally(() => {
    tokenInflight = null;
  });
  return tokenInflight;
}

async function issueToken(): Promise<string> {
  const now = Date.now();
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
      throw new Error(
        "토스증권 API가 이 서버 IP를 거부했습니다(403 IP address not allowed). 토스증권 개발자센터 > 앱 설정에서 허용 IP에 서버 IP를 등록해야 합니다.",
      );
    }
    throw new Error(`토스증권 토큰 발급 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  tokenState = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return tokenState.token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 요청 간 최소 간격(ms) — 토스 Open API 레이트리밋(429) 회피용 직렬 스로틀. */
const MIN_REQUEST_GAP_MS = 350;
let gate: Promise<void> = Promise.resolve();
/** 모든 요청을 최소 간격을 두고 직렬화한다. */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn);
  gate = run.then(
    () => sleep(MIN_REQUEST_GAP_MS),
    () => sleep(MIN_REQUEST_GAP_MS),
  );
  return run;
}

async function api<T>(
  path: string,
  params: Record<string, string | number | boolean> = {},
  attempt = 0,
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await throttle(() =>
    fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }),
  );
  if (res.status === 401) {
    tokenState = null;
    if (attempt < 2) {
      await sleep(500 * (attempt + 1));
      return api<T>(path, params, attempt + 1);
    }
    throw new Error(`토스증권 API 인증 실패 (401): 클라이언트 ID/시크릿을 확인하세요.`);
  }
  if (res.status === 429) {
    if (attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      return api<T>(path, params, attempt + 1);
    }
    throw new Error("토스증권 API 호출 한도(429) 초과 — 잠시 후 다시 시도하세요.");
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

const ETF_TYPES = new Set(["ETF", "FOREIGN_ETF", "ETN"]);
const isLeveragedName = (n: string) => /레버리지|2X|2배|곱버스/i.test(n);
const isInverseName = (n: string) => /인버스|곱버스/i.test(n);

let cache: { dataset: MarketDataset; at: number } | null = null;

export interface TossDatasetOptions {
  /** 유니버스 크기 (거래대금 상위 N종목, 최대 100) */
  universeSize?: number;
}

/**
 * 거래대금 상위 종목을 유니버스로 삼아 일봉 200개를 받아 MarketDataset을 구성한다.
 * 토스 Open API가 제공하지 않는 항목(시가총액·재무·ETF NAV·섹터 분류)은 capabilities에서 false로 선언한다.
 */
export async function buildTossDataset(opts: TossDatasetOptions = {}): Promise<MarketDataset> {
  const universeSize = Math.min(100, Math.max(10, opts.universeSize ?? 60));
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.dataset;
  credentials();

  const [ranking, kospiList, kosdaqList] = await Promise.all([
    api<{ rankings: RankingItem[] }>("/api/v1/rankings", {
      type: "MARKET_TRADING_AMOUNT",
      marketCountry: "KR",
      duration: "1d",
      count: universeSize,
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

  const ranked = (ranking.rankings ?? []).filter((r) => meta.has(r.symbol));

  const [kospiIdx, kosdaqIdx] = await Promise.all([
    fetchIndex("KOSPI", "코스피"),
    fetchIndex("KOSDAQ", "코스닥"),
  ]);
  if (!kospiIdx) throw new Error("코스피 지수 일봉을 가져오지 못했습니다.");
  const marketFlowOk = await attachMarketInvestorFlow(kospiIdx, "KOSPI");

  const barsList = await mapLimited(ranked, CONCURRENCY, (r) => fetchCandles(r.symbol));

  const instruments: Instrument[] = [];
  const bars: Record<string, DailyPrice[]> = {};
  const sectors = [{ code: "UNCLASSIFIED", name: "미분류" }];

  ranked.forEach((r, i) => {
    const b = barsList[i] ?? [];
    if (b.length === 0) return;
    const m = meta.get(r.symbol)!;
    const isEtf = ETF_TYPES.has(m.listed.securityType);
    // 최신 봉의 거래대금은 랭킹 실측값으로 교체
    const lastBar = b[b.length - 1]!;
    const amount = num(r.tradingAmount);
    if (amount > 0) lastBar.tradingValue = amount;

    instruments.push({
      id: r.symbol,
      symbol: r.symbol,
      name: m.listed.name,
      market: isEtf ? "ETF" : m.market,
      instrumentType: isEtf ? "ETF" : "STOCK",
      sectorCode: "UNCLASSIFIED",
      sectorName: "미분류",
      indexMemberships: [],
      isPreferredStock: !isEtf && !m.listed.isCommonShare,
      isManagementIssue: false,
      isInvestmentWarning: false,
      isLeveraged: isEtf && isLeveragedName(m.listed.name),
      isInverse: isEtf && isInverseName(m.listed.name),
      isActive: true,
    });
    bars[r.symbol] = b;
  });

  if (instruments.length === 0) {
    throw new Error("토스증권 API에서 유효한 종목 일봉을 가져오지 못했습니다.");
  }

  const indexSeries: IndexSeries[] = [kospiIdx, ...(kosdaqIdx ? [kosdaqIdx] : [])];
  const tradeDates = kospiIdx.bars.map((b) => b.tradeDate);
  const asOfDate = tradeDates[tradeDates.length - 1]!;

  const dataset: MarketDataset = {
    provider: "TOSS_OPEN_API",
    version: `toss-${asOfDate}`,
    asOfDate,
    isLive: true,
    capabilities: {
      ...NO_CAPABILITIES,
      exactTradingValue: false,
      investorFlow: marketFlowOk,
    },
    notes: [
      `토스증권 Open API 실데이터 — 거래대금 상위 ${instruments.length}종목, 일봉 최대 ${CANDLE_COUNT}개(≈9개월).`,
      "토스 Open API는 시가총액·재무제표·ETF NAV/총보수·업종 분류를 제공하지 않습니다. 해당 규칙과 점수 항목은 “데이터 없음”으로 표시되고 가중치에서 제외됩니다(0점 처리 아님).",
      "종목별 거래대금은 최신 거래일만 실측값이며, 과거 봉은 종가×거래량 근사치입니다.",
      marketFlowOk
        ? "시장 게이트의 외국인 순매수는 코스피 전체 투자자별 매매대금 실측값을 사용합니다."
        : "투자자별 매매대금을 가져오지 못해 외국인 수급 판정은 “데이터 없음”으로 처리됩니다.",
      `데이터는 ${CACHE_TTL_MS / 60000}분간 캐시됩니다.`,
    ],
    sectors,
    tradeDates,
    instruments,
    bars,
    indexSeries,
    financials: {} as Record<string, FinancialFacts>,
    etfFacts: {} as Record<string, EtfFacts>,
    vkospiSeries: [],
  };

  cache = { dataset, at: Date.now() };
  return dataset;
}
