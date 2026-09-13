// 직접 입력(붙여넣기 / CSV 업로드) 데이터를 엔진이 소비하는 MarketDataset으로 변환한다.
// 서버 API를 호출하지 않고 브라우저에서만 동작하는 순수 함수다.
import { NO_CAPABILITIES, type MarketDataset } from "./dataset";
import { resolveSectorCode, THEME_SECTORS } from "./sectors";
import type { DailyPrice, EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";
import { visitDelimitedRows } from "../sourceData";

/** 실현변동성(연환산 %) 시계열. VKOSPI가 없을 때 대체 지표로 쓴다. */
export function realizedVolatilitySeries(closes: number[], window = 20): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p0 = closes[i - 1]!;
    const p1 = closes[i]!;
    rets.push(p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : 0);
  }
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    // i번째 종가까지의 과거 수익률만 사용한다(미래 데이터 미사용).
    const end = i; // rets[0..i-1]
    if (end < window) {
      out.push(Number.NaN);
      continue;
    }
    const slice = rets.slice(end - window, end);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    out.push(Math.sqrt(variance * 252) * 100);
  }
  return out;
}

export interface ManualParseStats {
  stocks: number;
  etfs: number;
  indexes: string[];
  bars: number;
  firstDate: string;
  lastDate: string;
}

export interface ManualParseResult {
  dataset: MarketDataset;
  stats: ManualParseStats;
  warnings: string[];
}

/** 입력 파일에서 인식하는 컬럼 이름(별칭 포함) */
const FIELD_ALIASES: Record<string, string> = {
  symbol: "symbol",
  code: "symbol",
  종목코드: "symbol",
  단축코드: "symbol",
  name: "name",
  종목명: "name",
  market: "market",
  시장: "market",
  type: "type",
  종류: "type",
  securitytype: "type",
  date: "date",
  tradedate: "date",
  기준일: "date",
  일자: "date",
  open: "open",
  시가: "open",
  high: "high",
  고가: "high",
  low: "low",
  저가: "low",
  close: "close",
  종가: "close",
  volume: "volume",
  거래량: "volume",
  tradingvalue: "tradingValue",
  amount: "tradingValue",
  tradingamount: "tradingValue",
  거래대금: "tradingValue",
  marketcap: "marketCap",
  시가총액: "marketCap",
  foreignnetbuyvalue: "foreignNetBuyValue",
  foreignnet: "foreignNetBuyValue",
  외국인순매수: "foreignNetBuyValue",
  institutionnetbuyvalue: "institutionNetBuyValue",
  institutionnet: "institutionNetBuyValue",
  기관순매수: "institutionNetBuyValue",
  sector: "sector",
  sectorcode: "sector",
  섹터: "sector",
  업종: "sector",
};

const INDEX_SYMBOLS = new Set(["KOSPI", "KOSDAQ", "VKOSPI"]);

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/[, ₩원%]/g, "")
    .trim();
  if (s === "" || s === "-" || /^(null|none|nan|na)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 8) {
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    return `${y}-${m}-${d}`;
  }
  return null;
}

/** KRX 주식 단축코드는 6자리로 통일한다. 지수·문자형 심볼은 변경하지 않는다. */
export function normalizeKrxSymbol(v: unknown): string {
  let symbol = String(v ?? "")
    .trim()
    .toUpperCase()
    .replace(/^A(?=\d{6}$)/, "")
    .replace(/\.0$/, "");
  if (/^\d{1,6}$/.test(symbol)) symbol = symbol.padStart(6, "0");
  return symbol;
}

interface RawRecord {
  [key: string]: unknown;
}

/** CSV(쉼표/탭/세미콜론) 또는 JSON 텍스트를 레코드 배열로 만든다. */
function visitRecords(text: string, visitor: (record: RawRecord) => void): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let count = 0;
  const emit = (record: RawRecord) => {
    count++;
    visitor(record);
  };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    const flat: RawRecord[] = [];
    const pushSeries = (head: RawRecord, bars: unknown): void => {
      if (!Array.isArray(bars)) return;
      for (const b of bars) {
        if (b && typeof b === "object") flat.push({ ...head, ...(b as RawRecord) });
      }
    };
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const rec = item as RawRecord;
        if (Array.isArray(rec["bars"])) {
          const { bars, ...head } = rec;
          pushSeries(head, bars);
        } else flat.push(rec);
      }
      flat.forEach(emit);
      return count;
    }
    const obj = parsed as RawRecord;
    for (const key of ["instruments", "stocks", "etfs", "indexes", "indices", "rows", "data"]) {
      const arr = obj[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const rec = item as RawRecord;
        const isIndex = key === "indexes" || key === "indices";
        if (Array.isArray(rec["bars"])) {
          const { bars, ...head } = rec;
          pushSeries({ ...head, ...(isIndex ? { type: "INDEX" } : {}) }, bars);
        } else flat.push({ ...rec, ...(isIndex ? { type: "INDEX" } : {}) });
      }
    }
    flat.forEach(emit);
    return count;
  }

  let header: Array<string | null> | null = null;
  const needed = new Set(Object.values(FIELD_ALIASES));
  visitDelimitedRows(trimmed, (cells, rowIndex) => {
    if (rowIndex === 0) {
      header = cells.map((h) => {
        const key = h.replace(/\s|_/g, "").toLowerCase();
        const canonical = FIELD_ALIASES[key] ?? FIELD_ALIASES[h.trim()];
        return canonical && needed.has(canonical) ? canonical : null;
      });
      return;
    }
    const rec: RawRecord = {};
    header!.forEach((key, idx) => {
      if (key) rec[key] = cells[idx];
    });
    emit(rec);
  });
  return count;
}

function pick(rec: RawRecord, key: string): unknown {
  if (rec[key] !== undefined) return rec[key];
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (canonical !== key) continue;
    if (rec[alias] !== undefined) return rec[alias];
  }
  return undefined;
}

interface Series {
  symbol: string;
  name: string;
  kind: "STOCK" | "ETF" | "INDEX";
  market: "KOSPI" | "KOSDAQ" | "ETF";
  sector?: string;
  bars: DailyPrice[];
  dates: Set<string>;
}

/**
 * 붙여넣기/업로드한 텍스트를 MarketDataset으로 변환한다. 형식 오류는 Error로 던진다.
 * 여러 파일을 배열로 넘기면 하나의 데이터셋으로 합쳐서 해석한다(같은 종목·같은 날짜는 1건만 사용).
 */
export function parseManualMarketData(input: string | string[]): ManualParseResult {
  const map = new Map<string, Series>();
  const warnings: string[] = [];
  let skipped = 0;
  let recordCount = 0;
  const consume = (rec: RawRecord) => {
    const symbol = normalizeKrxSymbol(pick(rec, "symbol"));
    const date = normalizeDate(pick(rec, "date"));
    const close = num(pick(rec, "close"));
    if (!symbol || !date || close === null || close <= 0) {
      skipped++;
      return;
    }
    const rawType = String(pick(rec, "type") ?? "")
      .trim()
      .toUpperCase();
    const rawMarket = String(pick(rec, "market") ?? "")
      .trim()
      .toUpperCase();
    const isIndex =
      rawType === "INDEX" ||
      rawMarket === "INDEX" ||
      rawMarket === "지수" ||
      INDEX_SYMBOLS.has(symbol);
    const isEtf = !isIndex && (rawType === "ETF" || rawMarket === "ETF");
    const kind: Series["kind"] = isIndex ? "INDEX" : isEtf ? "ETF" : "STOCK";
    const market: Series["market"] = isEtf
      ? "ETF"
      : rawMarket.includes("KOSDAQ") || rawMarket.includes("코스닥")
        ? "KOSDAQ"
        : "KOSPI";

    const open = num(pick(rec, "open")) ?? close;
    const high = num(pick(rec, "high")) ?? Math.max(open, close);
    const low = num(pick(rec, "low")) ?? Math.min(open, close);
    const volume = num(pick(rec, "volume")) ?? 0;
    const tradingValue = num(pick(rec, "tradingValue")) ?? close * volume;

    const bar: DailyPrice = {
      tradeDate: date,
      open,
      high: Math.max(high, open, close, low),
      low: Math.min(low, open, close, high),
      close,
      volume,
      tradingValue,
      marketCap: num(pick(rec, "marketCap")),
      foreignNetBuyValue: num(pick(rec, "foreignNetBuyValue")),
      institutionNetBuyValue: num(pick(rec, "institutionNetBuyValue")),
    };

    const existing = map.get(symbol);
    if (existing) {
      if (!existing.dates.has(date)) {
        existing.dates.add(date);
        existing.bars.push(bar);
      }
      return;
    }
    const sector = String(pick(rec, "sector") ?? "").trim();
    map.set(symbol, {
      symbol,
      name: String(pick(rec, "name") ?? symbol).trim() || symbol,
      kind,
      market,
      ...(sector ? { sector } : {}),
      bars: [bar],
      dates: new Set([date]),
    });
  };
  for (const text of Array.isArray(input) ? input : [input]) {
    recordCount += visitRecords(text, consume);
  }
  if (recordCount === 0) {
    throw new Error("데이터를 인식하지 못했습니다. 헤더가 포함된 CSV 또는 JSON을 붙여넣어 주세요.");
  }

  for (const s of map.values()) s.bars.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));

  const kospi = map.get("KOSPI");
  if (!kospi || kospi.bars.length < 60) {
    throw new Error(
      "코스피 지수 일봉이 필요합니다. symbol=KOSPI, market=INDEX 행을 60거래일 이상 포함해 주세요(시장 게이트 판정용).",
    );
  }

  const indexSeries: IndexSeries[] = [
    { indexCode: "KOSPI", indexName: "코스피", bars: kospi.bars },
  ];
  const kosdaq = map.get("KOSDAQ");
  if (kosdaq && kosdaq.bars.length > 0)
    indexSeries.push({ indexCode: "KOSDAQ", indexName: "코스닥", bars: kosdaq.bars });
  const vkospi = map.get("VKOSPI");

  // VKOSPI가 없으면 KOSPI(및 KOSDAQ) 종가의 20일 실현변동성(연환산 %)으로 대체한다.
  let volatilitySeries: number[] = [];
  let volatilityIsProxy = false;
  if (vkospi && vkospi.bars.length > 0) {
    volatilitySeries = vkospi.bars.map((b) => b.close);
  } else {
    const kospiVol = realizedVolatilitySeries(kospi.bars.map((b) => b.close));
    const kosdaqCloses =
      kosdaq && kosdaq.bars.length >= 21 ? kosdaq.bars.map((b) => b.close) : null;
    const kosdaqVol = kosdaqCloses ? realizedVolatilitySeries(kosdaqCloses) : null;
    const offset = kosdaqVol ? kosdaqVol.length - kospiVol.length : 0;
    volatilitySeries = kospiVol
      .map((v, i) => {
        const kq = kosdaqVol?.[i + offset];
        if (!Number.isFinite(v)) return Number.NaN;
        return kq !== undefined && Number.isFinite(kq) ? 0.7 * v + 0.3 * kq : v;
      })
      .filter((v) => Number.isFinite(v));
    volatilityIsProxy = volatilitySeries.length > 0;
  }

  const instruments: Instrument[] = [];
  const bars: Record<string, DailyPrice[]> = {};
  const usedSectors = new Set<string>();
  let marketCapCount = 0;
  let flowCount = 0;
  let exactValueCount = 0;
  let barCount = 0;

  for (const s of map.values()) {
    if (s.kind === "INDEX") continue;
    if (s.bars.length === 0) continue;
    const isEtf = s.kind === "ETF";
    const resolved = s.sector
      ? {
          code: s.sector.toUpperCase(),
          name: THEME_SECTORS.find((t) => t.code === s.sector!.toUpperCase())?.name ?? s.sector,
        }
      : resolveSectorCode(s.symbol, s.name, isEtf);
    usedSectors.add(resolved.code);
    if (s.bars.some((b) => b.marketCap !== null)) marketCapCount++;
    if (s.bars.some((b) => b.foreignNetBuyValue !== null)) flowCount++;
    if (
      s.bars.some(
        (b) => b.tradingValue > 0 && b.volume > 0 && b.tradingValue !== b.close * b.volume,
      )
    )
      exactValueCount++;
    barCount += s.bars.length;

    const name = s.name;
    instruments.push({
      id: s.symbol,
      symbol: s.symbol,
      name,
      market: isEtf ? "ETF" : s.market,
      instrumentType: isEtf ? "ETF" : "STOCK",
      sectorCode: resolved.code,
      sectorName: resolved.name,
      indexMemberships: isEtf ? [] : ["KOSPI200", "KRX300"],
      isPreferredStock: !isEtf && /우(B|\(전환\))?$/.test(name),
      isManagementIssue: false,
      isInvestmentWarning: false,
      isLeveraged: isEtf && /레버리지|2X|3X/i.test(name),
      isInverse: isEtf && /인버스|숏|SHORT/i.test(name),
      isActive: true,
    });
    bars[s.symbol] = s.bars;
  }

  if (instruments.length === 0) {
    throw new Error("분석할 종목 일봉이 없습니다. 지수 외에 개별 종목 행을 포함해 주세요.");
  }

  const tradeDates = kospi.bars.map((b) => b.tradeDate);
  const asOfDate = tradeDates[tradeDates.length - 1]!;
  const shortSeries = instruments.filter((i) => (bars[i.symbol]?.length ?? 0) < 120).length;
  if (shortSeries > 0)
    warnings.push(
      `${shortSeries}종목의 일봉이 120개 미만입니다. 일목균형표·MA120 등 일부 지표는 “데이터 없음”으로 처리됩니다.`,
    );
  if (skipped > 0) warnings.push(`종목코드·기준일·종가가 없는 ${skipped}개 행을 건너뛰었습니다.`);
  if (!kosdaq)
    warnings.push("코스닥 지수(symbol=KOSDAQ)가 없어 코스닥 벤치마크는 코스피로 대체합니다.");
  if (!vkospi)
    warnings.push(
      volatilityIsProxy
        ? "VKOSPI 행이 없어 KOSPI·KOSDAQ 종가의 20일 실현변동성(연환산 %)을 대체 지표로 사용합니다."
        : "VKOSPI 행이 없고 지수 일봉도 21개 미만이라 변동성 게이트는 “데이터 없음”으로 처리됩니다.",
    );

  const stockCount = instruments.filter((i) => i.instrumentType === "STOCK").length;

  const dataset: MarketDataset = {
    provider: "MANUAL_INPUT",
    version: `manual-${asOfDate}`,
    asOfDate,
    isLive: true,
    capabilities: {
      ...NO_CAPABILITIES,
      sectors: true,
      marketCap: marketCapCount > 0,
      investorFlow: flowCount > 0,
      volatilityIndex: volatilitySeries.length > 0,
      exactTradingValue: exactValueCount > 0,
    },
    notes: [
      `직접 입력 데이터 — 주식 ${stockCount}종목 + ETF ${instruments.length - stockCount}종목, 일봉 ${barCount}건, 기준일 ${asOfDate}.`,
      "시세는 사용자가 토스증권 Open API로 직접 조회해 붙여넣은 값입니다. 서버에서 외부 시세 API를 호출하지 않습니다.",
      marketCapCount > 0
        ? `시가총액은 입력값을 사용합니다(${marketCapCount}/${instruments.length}종목).`
        : "시가총액 열이 없어 관련 규칙·점수는 “데이터 없음”으로 처리됩니다(0점 처리 아님).",
      flowCount > 0
        ? `외국인·기관 순매수는 입력값을 사용합니다(${flowCount}/${instruments.length}종목).`
        : "외국인·기관 순매수 열이 없어 수급 항목은 “데이터 없음”으로 처리됩니다.",
      "업종(섹터)은 sector 열이 있으면 그 값을, 없으면 내장 테마 섹터 매핑(종목코드·상품명 규칙)을 사용합니다.",
      "재무제표·ETF NAV/총보수는 입력 대상이 아니므로 펀더멘털·상품건전성 점수는 가중치에서 제외됩니다.",
      ...warnings,
    ],
    sectors: THEME_SECTORS.filter((s) => usedSectors.has(s.code)),
    tradeDates,
    instruments,
    bars,
    indexSeries,
    financials: {} as Record<string, FinancialFacts>,
    etfFacts: {} as Record<string, EtfFacts>,
    vkospiSeries: volatilitySeries,
  };

  return {
    dataset,
    stats: {
      stocks: stockCount,
      etfs: instruments.length - stockCount,
      indexes: indexSeries
        .map((s) => s.indexCode)
        .concat(vkospi ? ["VKOSPI"] : volatilityIsProxy ? ["실현변동성(대체)"] : []),
      bars: barCount,
      firstDate: tradeDates[0]!,
      lastDate: asOfDate,
    },
    warnings,
  };
}
