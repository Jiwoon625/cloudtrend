// TrendScore US — 직접 입력(붙여넣기 / CSV / JSON) 데이터를 미국 시장 분석용 데이터셋으로 변환한다.
// 서버 API를 호출하지 않는 순수 함수이며, 제공되지 않은 항목은 0으로 위장하지 않고 null(데이터 없음)로 남긴다.
import type { DailyPrice } from "./types";

export type UsAssetType = "STOCK" | "ETF";
export type UsSecurityType = "STOCK" | "ETF" | "ETN" | "REIT" | "CEF";

export interface UsInstrument {
  symbol: string;
  name: string;
  nameKo: string | null;
  assetType: UsAssetType;
  securityType: UsSecurityType;
  /** GICS 섹터 표기(입력값). 없으면 null */
  sector: string | null;
  issuer: string | null;
  leveraged: boolean;
  inverse: boolean;
  marketCap: number | null;
  aum: number | null;
  expenseRatio: number | null;
  spreadBps: number | null;
  /** 토스증권에서 거래 가능 여부(입력값). 미제공 시 null */
  tossTradable: boolean | null;
}

export interface UsDatasetCapabilities {
  marketCap: boolean;
  sector: boolean;
  aum: boolean;
  expenseRatio: boolean;
  spread: boolean;
  /** 재무(SEC) / ETF NAV·추적오차는 이 입력 경로에서 제공되지 않는다 */
  fundamentals: false;
  navTracking: false;
}

export interface UsDataset {
  provider: string;
  version: string;
  asOfDate: string;
  capabilities: UsDatasetCapabilities;
  notes: string[];
  instruments: UsInstrument[];
  bars: Record<string, DailyPrice[]>;
  tradeDates: string[];
}

export interface UsParseStats {
  stocks: number;
  etfs: number;
  bars: number;
  firstDate: string;
  lastDate: string;
  benchmarks: string[];
  sectorEtfs: string[];
}

export interface UsParseResult {
  dataset: UsDataset;
  stats: UsParseStats;
  warnings: string[];
}

export const US_BENCHMARKS = ["SPY", "QQQ", "IWM"] as const;

/** 11개 GICS 섹터 프록시 ETF */
export const US_SECTOR_ETFS: Array<{ etf: string; sector: string; label: string }> = [
  { etf: "XLK", sector: "Information Technology", label: "정보기술" },
  { etf: "XLF", sector: "Financials", label: "금융" },
  { etf: "XLV", sector: "Health Care", label: "헬스케어" },
  { etf: "XLY", sector: "Consumer Discretionary", label: "임의소비재" },
  { etf: "XLP", sector: "Consumer Staples", label: "필수소비재" },
  { etf: "XLC", sector: "Communication Services", label: "커뮤니케이션" },
  { etf: "XLI", sector: "Industrials", label: "산업재" },
  { etf: "XLE", sector: "Energy", label: "에너지" },
  { etf: "XLU", sector: "Utilities", label: "유틸리티" },
  { etf: "XLRE", sector: "Real Estate", label: "부동산" },
  { etf: "XLB", sector: "Materials", label: "소재" },
];

const SECTOR_ALIASES: Record<string, string> = {
  technology: "Information Technology",
  informationtechnology: "Information Technology",
  it: "Information Technology",
  tech: "Information Technology",
  정보기술: "Information Technology",
  기술: "Information Technology",
  financials: "Financials",
  financial: "Financials",
  finance: "Financials",
  금융: "Financials",
  healthcare: "Health Care",
  health: "Health Care",
  헬스케어: "Health Care",
  의료: "Health Care",
  consumerdiscretionary: "Consumer Discretionary",
  consumercyclical: "Consumer Discretionary",
  임의소비재: "Consumer Discretionary",
  경기소비재: "Consumer Discretionary",
  consumerstaples: "Consumer Staples",
  consumerdefensive: "Consumer Staples",
  필수소비재: "Consumer Staples",
  communicationservices: "Communication Services",
  communication: "Communication Services",
  커뮤니케이션: "Communication Services",
  통신: "Communication Services",
  industrials: "Industrials",
  industrial: "Industrials",
  산업재: "Industrials",
  energy: "Energy",
  에너지: "Energy",
  utilities: "Utilities",
  유틸리티: "Utilities",
  realestate: "Real Estate",
  reit: "Real Estate",
  부동산: "Real Estate",
  리츠: "Real Estate",
  materials: "Materials",
  basicmaterials: "Materials",
  소재: "Materials",
};

/** 입력 섹터 문자열을 GICS 11개 섹터명으로 정규화한다. 알 수 없으면 원문 유지. */
export function normalizeUsSector(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.replace(/[\s_-]/g, "").toLowerCase();
  return SECTOR_ALIASES[key] ?? raw.trim();
}

export function sectorLabelKo(sector: string | null): string {
  if (!sector) return "미분류";
  return US_SECTOR_ETFS.find((s) => s.sector === sector)?.label ?? sector;
}

const FIELD_ALIASES: Record<string, string> = {
  symbol: "symbol",
  ticker: "symbol",
  code: "symbol",
  종목코드: "symbol",
  티커: "symbol",
  name: "name",
  englishname: "name",
  종목명: "name",
  nameko: "nameKo",
  koreanname: "nameKo",
  한글명: "nameKo",
  type: "type",
  assettype: "type",
  securitytype: "securityType",
  sector: "sector",
  gicssector: "sector",
  섹터: "sector",
  업종: "sector",
  issuer: "issuer",
  운용사: "issuer",
  date: "date",
  tradedate: "date",
  일자: "date",
  기준일: "date",
  open: "open",
  high: "high",
  low: "low",
  close: "close",
  adjclose: "close",
  adjustedclose: "close",
  adjusted: "close",
  volume: "volume",
  marketcap: "marketCap",
  시가총액: "marketCap",
  aum: "aum",
  netassets: "aum",
  순자산: "aum",
  expenseratio: "expenseRatio",
  ter: "expenseRatio",
  총보수: "expenseRatio",
  spreadbps: "spreadBps",
  medianspread30d: "spreadBps",
  spread: "spreadBps",
  tosstradable: "tossTradable",
  leveragefactor: "leverageFactor",
  inverse: "inverse",
};

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t" || ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/[$,%\s]/g, "")
    .trim();
  if (s === "" || s === "-" || /^(null|none|nan|na|n\/a)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "") return null;
  if (["true", "1", "y", "yes", "t", "가능"].includes(s)) return true;
  if (["false", "0", "n", "no", "f", "불가"].includes(s)) return false;
  return null;
}

function normalizeDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 8)
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return null;
}

type RawRecord = Record<string, unknown>;

function toRecords(text: string): RawRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    const flat: RawRecord[] = [];
    const push = (head: RawRecord, bars: unknown): void => {
      if (!Array.isArray(bars)) return;
      for (const b of bars)
        if (b && typeof b === "object") flat.push({ ...head, ...(b as RawRecord) });
    };
    const consume = (arr: unknown): void => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const rec = item as RawRecord;
        if (Array.isArray(rec["bars"])) {
          const { bars, ...head } = rec;
          push(head, bars);
        } else flat.push(rec);
      }
    };
    if (Array.isArray(parsed)) consume(parsed);
    else {
      const obj = parsed as RawRecord;
      for (const key of ["instruments", "stocks", "etfs", "rows", "data", "prices"])
        consume(obj[key]);
    }
    return flat;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = splitLine(lines[0]!).map((h) => {
    const key = h.replace(/[\s_-]/g, "").toLowerCase();
    return FIELD_ALIASES[key] ?? key;
  });
  const records: RawRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!);
    const rec: RawRecord = {};
    header.forEach((key, idx) => {
      rec[key] = cells[idx];
    });
    records.push(rec);
  }
  return records;
}

function pick(rec: RawRecord, key: string): unknown {
  if (rec[key] !== undefined) return rec[key];
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (canonical !== key) continue;
    if (rec[alias] !== undefined) return rec[alias];
  }
  return undefined;
}

const LEVERAGE_RE = /\b(2x|3x|ultra|ultrapro)\b|레버리지/i;
const INVERSE_RE = /\b(short|inverse|bear|-1x|-2x|-3x)\b|인버스/i;
const ETN_RE = /\betn\b/i;

interface Series {
  symbol: string;
  meta: Omit<UsInstrument, "symbol">;
  bars: DailyPrice[];
}

/** 붙여넣기·업로드한 미국 시장 텍스트를 UsDataset으로 변환한다. 형식 오류는 Error. */
export function parseUsMarketData(text: string): UsParseResult {
  const records = toRecords(text);
  if (records.length === 0)
    throw new Error("데이터를 인식하지 못했습니다. 헤더가 포함된 CSV 또는 JSON을 붙여넣어 주세요.");

  const map = new Map<string, Series>();
  const warnings: string[] = [];
  let skipped = 0;

  for (const rec of records) {
    const symbol = String(pick(rec, "symbol") ?? "")
      .trim()
      .toUpperCase();
    const date = normalizeDate(pick(rec, "date"));
    const close = num(pick(rec, "close"));
    if (!symbol || !date || close === null || close <= 0) {
      skipped++;
      continue;
    }

    const open = num(pick(rec, "open")) ?? close;
    const high = num(pick(rec, "high")) ?? Math.max(open, close);
    const low = num(pick(rec, "low")) ?? Math.min(open, close);
    const volume = num(pick(rec, "volume")) ?? 0;
    const bar: DailyPrice = {
      tradeDate: date,
      open,
      high: Math.max(high, open, close, low),
      low: Math.min(low, open, close, high),
      close,
      volume,
      tradingValue: close * volume,
      marketCap: num(pick(rec, "marketCap")),
      foreignNetBuyValue: null,
      institutionNetBuyValue: null,
    };

    const existing = map.get(symbol);
    if (existing) {
      if (!existing.bars.some((b) => b.tradeDate === date)) existing.bars.push(bar);
      if (existing.meta.marketCap === null && bar.marketCap !== null)
        existing.meta.marketCap = bar.marketCap;
      continue;
    }

    const name = String(pick(rec, "name") ?? symbol).trim() || symbol;
    const rawType = String(pick(rec, "type") ?? "")
      .trim()
      .toUpperCase();
    const rawSecurity = String(pick(rec, "securityType") ?? "")
      .trim()
      .toUpperCase();
    const isEtfLike =
      rawType === "ETF" ||
      rawSecurity === "ETF" ||
      rawSecurity === "ETN" ||
      rawSecurity === "CEF" ||
      (rawType === "" && rawSecurity === "" && US_SECTOR_ETFS.some((s) => s.etf === symbol)) ||
      (rawType === "" &&
        rawSecurity === "" &&
        (US_BENCHMARKS as readonly string[]).includes(symbol));
    const securityType: UsSecurityType =
      ETN_RE.test(name) || rawSecurity === "ETN"
        ? "ETN"
        : rawSecurity === "CEF"
          ? "CEF"
          : rawSecurity === "REIT" || rawType === "REIT"
            ? "REIT"
            : isEtfLike
              ? "ETF"
              : "STOCK";
    const leverageFactor = num(pick(rec, "leverageFactor"));
    const inverseFlag = bool(pick(rec, "inverse"));

    map.set(symbol, {
      symbol,
      meta: {
        name,
        nameKo: String(pick(rec, "nameKo") ?? "").trim() || null,
        assetType: securityType === "STOCK" || securityType === "REIT" ? "STOCK" : "ETF",
        securityType,
        sector: normalizeUsSector(String(pick(rec, "sector") ?? "").trim() || null),
        issuer: String(pick(rec, "issuer") ?? "").trim() || null,
        leveraged:
          LEVERAGE_RE.test(name) || (leverageFactor !== null && Math.abs(leverageFactor) > 1),
        inverse:
          INVERSE_RE.test(name) ||
          inverseFlag === true ||
          (leverageFactor !== null && leverageFactor < 0),
        marketCap: bar.marketCap,
        aum: num(pick(rec, "aum")),
        expenseRatio: num(pick(rec, "expenseRatio")),
        spreadBps: num(pick(rec, "spreadBps")),
        tossTradable: bool(pick(rec, "tossTradable")),
      },
      bars: [bar],
    });
  }

  for (const s of map.values()) s.bars.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));

  const spy = map.get("SPY");
  if (!spy || spy.bars.length < 200)
    throw new Error(
      "SPY 일봉이 200거래일 이상 필요합니다(시장 게이트·상대강도 기준). symbol=SPY 행을 포함해 주세요.",
    );

  const instruments: UsInstrument[] = [];
  const bars: Record<string, DailyPrice[]> = {};
  let barCount = 0;
  let capCount = 0;
  let sectorCount = 0;
  let aumCount = 0;
  let expenseCount = 0;
  let spreadCount = 0;

  for (const s of map.values()) {
    if (s.bars.length === 0) continue;
    instruments.push({ symbol: s.symbol, ...s.meta });
    bars[s.symbol] = s.bars;
    barCount += s.bars.length;
    if (s.meta.marketCap !== null) capCount++;
    if (s.meta.sector !== null) sectorCount++;
    if (s.meta.aum !== null) aumCount++;
    if (s.meta.expenseRatio !== null) expenseCount++;
    if (s.meta.spreadBps !== null) spreadCount++;
  }

  const tradeDates = spy.bars.map((b) => b.tradeDate);
  const asOfDate = tradeDates[tradeDates.length - 1]!;
  const stocks = instruments.filter((i) => i.assetType === "STOCK").length;
  const etfs = instruments.length - stocks;

  const missingBenchmarks = US_BENCHMARKS.filter((b) => !map.has(b));
  if (missingBenchmarks.length > 0)
    warnings.push(
      `${missingBenchmarks.join(", ")} 일봉이 없어 해당 시장 신호는 “데이터 없음”으로 처리합니다(0점 처리 아님).`,
    );
  const presentSectorEtfs = US_SECTOR_ETFS.filter((s) => map.has(s.etf)).map((s) => s.etf);
  if (presentSectorEtfs.length < US_SECTOR_ETFS.length)
    warnings.push(
      `섹터 프록시 ETF ${US_SECTOR_ETFS.length - presentSectorEtfs.length}개가 없어 해당 섹터 게이트는 판단 보류로 표시합니다.`,
    );
  const shortHistory = instruments.filter((i) => (bars[i.symbol]?.length ?? 0) < 252).length;
  if (shortHistory > 0)
    warnings.push(
      `${shortHistory}종목의 일봉이 252거래일 미만입니다. NEW_LISTING으로 분류하고 장기 지표는 “데이터 없음”으로 처리합니다(권장 320봉).`,
    );
  if (skipped > 0) warnings.push(`티커·일자·종가가 없는 ${skipped}개 행을 건너뛰었습니다.`);
  if (sectorCount === 0)
    warnings.push(
      "sector 열이 없어 섹터 게이트·섹터 상대강도 항목은 “데이터 없음”으로 처리합니다.",
    );

  const dataset: UsDataset = {
    provider: "MANUAL_INPUT_US",
    version: `us-manual-${asOfDate}`,
    asOfDate,
    capabilities: {
      marketCap: capCount > 0,
      sector: sectorCount > 0,
      aum: aumCount > 0,
      expenseRatio: expenseCount > 0,
      spread: spreadCount > 0,
      fundamentals: false,
      navTracking: false,
    },
    notes: [
      `직접 입력 데이터 — 주식 ${stocks}종목 + ETF ${etfs}종목, 일봉 ${barCount}건, 기준일 ${asOfDate}.`,
      "시세는 이용자가 로컬(주피터)에서 토스증권 Open API로 직접 조회해 붙여넣은 값입니다. 브라우저·서버에 API 키를 저장하지 않습니다.",
      capCount > 0
        ? `시가총액은 입력값을 사용합니다(${capCount}/${instruments.length}종목).`
        : "시가총액 열이 없어 규모·유니버스 관련 항목은 “데이터 없음”으로 처리합니다(0점 처리 아님).",
      "SEC CompanyFacts 기반 Fundamental 100과 NAV·추적오차 항목은 이 입력 경로의 대상이 아니므로 N/A로 표시되며 coverage에 반영됩니다.",
      ...warnings,
    ],
    instruments,
    bars,
    tradeDates,
  };

  return {
    dataset,
    stats: {
      stocks,
      etfs,
      bars: barCount,
      firstDate: tradeDates[0]!,
      lastDate: asOfDate,
      benchmarks: US_BENCHMARKS.filter((b) => map.has(b)),
      sectorEtfs: presentSectorEtfs,
    },
    warnings,
  };
}
