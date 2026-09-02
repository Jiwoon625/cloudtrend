// 시세 데이터 조회 서버 함수.
// 토스증권 Open API 키(TOSS_CLIENT_ID / TOSS_CLIENT_SECRET)가 설정되어 있으면 실데이터를,
// 없거나 조회 실패 시 합성(mock) 데이터로 폴백하고 그 사실을 응답에 담아 화면에 노출한다.
import { createServerFn } from "@tanstack/react-start";

import type { MarketDataset } from "@/lib/engine/dataset";
import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  runBacktest,
  type BacktestParams,
  type BacktestResult,
} from "@/lib/engine/backtest";
import { mergeScoringConfig, type ScoringConfig } from "@/lib/engine/scoring";
import {
  chartSeries,
  runAnalysis,
  scoreHistory,
  type AnalysisResult,
  type ScreeningRow,
} from "@/lib/engine/pipeline";

export interface DataSourceStatus {
  /** 실데이터 사용 여부 */
  live: boolean;
  /** 토스 API 키 설정 여부 */
  credentialsConfigured: boolean;
  /** 실데이터 조회 실패 시 원인 (mock 폴백 사유) */
  fallbackReason: string | null;
}

async function loadDataset(): Promise<{ dataset: MarketDataset; status: DataSourceStatus }> {
  const { buildTossDataset, hasTossCredentials } = await import("@/lib/engine/toss.server");
  if (!hasTossCredentials()) {
    throw new Error(
      "토스증권 Open API 키(TOSS_CLIENT_ID / TOSS_CLIENT_SECRET)가 등록되지 않았습니다. 실데이터만 사용하도록 설정되어 있어 화면을 그릴 수 없습니다.",
    );
  }
  const dataset = await buildTossDataset();
  return {
    dataset,
    status: { live: true, credentialsConfigured: true, fallbackReason: null },
  };
}


export interface AnalysisPayload {
  analysis: AnalysisResult;
  source: DataSourceStatus;
}

export const getMarketAnalysis = createServerFn({ method: "GET" })
  .inputValidator((input: { config?: unknown } | undefined) => ({
    config: mergeScoringConfig(input?.config),
  }))
  .handler(async ({ data }): Promise<AnalysisPayload> => {
    const { dataset, status } = await loadDataset();
    return { analysis: runAnalysis(dataset, data.config), source: status };
  });

/** Toss 허용 IP를 갱신한 뒤 재시도할 때 서버의 이전 인증 상태를 비운다. */
export const resetTossConnection = createServerFn({ method: "POST" }).handler(async () => {
  const { resetTossConnectionState } = await import("@/lib/engine/toss.server");
  resetTossConnectionState();
  return { resetAt: new Date().toISOString() };
});

export interface BacktestPayload {
  result: BacktestResult;
  universe: Array<{ symbol: string; name: string; bars: number }>;
  extended: boolean;
  asOfDate: string;
  notes: string[];
}

/**
 * 선택한 종목(미지정 시 거래대금 상위 주식)에 대해 피처 영향도 백테스트를 실행한다.
 * extendHistory=true면 종목당 2회 요청으로 최근 1년(약 250봉)까지 확장 시도한다.
 */
export const runFeatureBacktest = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { symbols?: string[]; params?: unknown; extendHistory?: boolean; limit?: number }) => {
      const num = (v: unknown, d: number, min: number, max: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
      };
      const raw = (input.params ?? {}) as Record<string, unknown>;
      const featureIds = BACKTEST_FEATURES.map((f) => f.id);
      const rawFeatures = Array.isArray(raw["features"]) ? (raw["features"] as unknown[]) : null;
      const rawWeights = (raw["weights"] ?? {}) as Record<string, unknown>;
      const params: BacktestParams = {
        horizonDays: num(raw["horizonDays"], DEFAULT_BACKTEST_PARAMS.horizonDays, 1, 120),
        sampleEvery: num(raw["sampleEvery"], DEFAULT_BACKTEST_PARAMS.sampleEvery, 1, 20),
        volumeSurgeRatio: num(
          raw["volumeSurgeRatio"],
          DEFAULT_BACKTEST_PARAMS.volumeSurgeRatio,
          100,
          2000,
        ),
        extensionLimit: num(raw["extensionLimit"], DEFAULT_BACKTEST_PARAMS.extensionLimit, 1, 100),
        entryScore: num(raw["entryScore"], DEFAULT_BACKTEST_PARAMS.entryScore, 0, 100),
        features: rawFeatures
          ? featureIds.filter((id) => rawFeatures.map(String).includes(id))
          : DEFAULT_BACKTEST_PARAMS.features,
        weights: Object.fromEntries(
          BACKTEST_FEATURES.map((f) => [
            f.id,
            num(rawWeights[f.id], f.defaultWeight, 0, 10),
          ]),
        ),
      };
      return {
        symbols: (input.symbols ?? [])
          .map((x) => String(x).trim().toUpperCase())
          .filter((x) => /^[0-9A-Z]{6}$/.test(x))
          .slice(0, 60),
        params,
        extendHistory: input.extendHistory === true,
        limit: num(input.limit, 30, 1, 60),
      };
    },
  )
  .handler(async ({ data }): Promise<BacktestPayload> => {
    const { dataset } = await loadDataset();
    const { fetchLongHistory } = await import("@/lib/engine/toss.server");

    const pool = data.symbols.length
      ? dataset.instruments.filter((i) => data.symbols.includes(i.symbol))
      : [...dataset.instruments]
          .filter((i) => i.instrumentType === "STOCK")
          .sort((a, b) => {
            const av = dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0;
            const bv = dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0;
            return bv - av;
          })
          .slice(0, data.limit);

    const series = [] as Array<{ symbol: string; name: string; bars: typeof dataset.bars[string] }>;
    let extended = false;
    for (const inst of pool) {
      let bars = dataset.bars[inst.symbol] ?? [];
      if (data.extendHistory) {
        try {
          const long = await fetchLongHistory(inst.symbol, 250);
          if (long.length > bars.length) {
            bars = long;
            extended = true;
          }
        } catch {
          // 확장 실패 시 캐시된 일봉(최대 200봉)으로 진행
        }
      }
      if (bars.length > 0) series.push({ symbol: inst.symbol, name: inst.name, bars });
    }

    const result = runBacktest(series, data.params);
    return {
      result,
      universe: series.map((s) => ({ symbol: s.symbol, name: s.name, bars: s.bars.length })),
      extended,
      asOfDate: dataset.asOfDate,
      notes: [
        data.extendHistory
          ? extended
            ? "최근 1년(최대 250봉)까지 일봉을 확장해 백테스트했습니다."
            : "토스 Open API가 200봉 이전 구간 조회를 지원하지 않아 최대 200봉(약 9.5개월)으로 백테스트했습니다."
          : "캐시된 일봉(종목당 최대 200봉, 약 9.5개월)으로 백테스트했습니다.",
        "지표 계산에 120봉이 필요하므로 관측 구간은 121번째 봉부터 시작합니다. 표본이 겹치는 중첩 관측이므로 t값은 참고용입니다.",
        "수수료·세금·슬리피지는 반영되지 않았습니다.",
      ],
    };
  });

export interface InstrumentDetailPayload {
  source: DataSourceStatus;
  asOfDate: string;
  dataProvider: string;
  dataVersion: string;
  strategyVersion: string;
  notes: string[];
  isLive: boolean;
  marketGateStatus: string;
  row: ScreeningRow | null;
  chart: ReturnType<typeof chartSeries>;
  history: ReturnType<typeof scoreHistory>;
}

const IPV4_RE = /(\d{1,3}\.){3}\d{1,3}/;
const IPV6_RE = /\b(?=[0-9a-f:]*:)[0-9a-f:]{6,}\b/i;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).trim();
}

/**
 * 서버 출구 IP 조회.
 * 토스증권 허용 IP 등록용이므로 IPv4를 우선하고, IPv4를 못 얻으면 IPv6라도 반환한다.
 * 여러 조회처를 순차 시도하며 모든 실패 시 원인을 문자열에 담아 사용자에게 노출한다.
 */
export const getServerEgressIp = createServerFn({ method: "GET" }).handler(async (): Promise<string> => {
  // IPv4 전용 조회처를 먼저, 그다음 일반 조회처(IPv6 가능)를 시도한다.
  const endpoints = [
    "https://api4.ipify.org",
    "https://ipv4.icanhazip.com",
    "https://checkip.amazonaws.com",
    "https://api.ipify.org?format=json",
    "https://ipinfo.io/ip",
    "https://api.myip.com",
    "https://www.cloudflare.com/cdn-cgi/trace",
    "https://icanhazip.com",
  ];
  const errors: string[] = [];
  let ipv6: string | null = null;

  for (const url of endpoints) {
    try {
      const text = await fetchText(url);
      const v4 = text.match(IPV4_RE);
      if (v4) return v4[0];
      const v6 = text.match(IPV6_RE);
      if (v6 && !ipv6) ipv6 = v6[0];
      errors.push(`${new URL(url).hostname}: IPv4 없음`);
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : "실패"}`);
    }
  }

  if (ipv6) return ipv6;
  console.error("egress IP lookup failed", errors);
  return `조회 실패 (${errors.slice(0, 3).join(" / ")})`;
});


export const getInstrumentDetail = createServerFn({ method: "GET" })
  .inputValidator((input: { symbol: string; config?: unknown }) => ({
    symbol: String(input.symbol).slice(0, 20),
    config: mergeScoringConfig(input.config),
  }))
  .handler(async ({ data }): Promise<InstrumentDetailPayload> => {
    const { dataset, status } = await loadDataset();
    const analysis = runAnalysis(dataset, data.config as ScoringConfig);
    const row = analysis.rows.find((r) => r.instrument.symbol === data.symbol) ?? null;
    return {
      source: status,
      asOfDate: analysis.asOfDate,
      dataProvider: analysis.dataProvider,
      dataVersion: analysis.dataVersion,
      strategyVersion: analysis.strategyVersion,
      notes: analysis.notes,
      isLive: analysis.isLive,
      marketGateStatus: analysis.marketGate.status,
      row,
      chart: row ? chartSeries(dataset, data.symbol) : [],
      history: row ? scoreHistory(dataset, data.symbol, 60, data.config) : [],
    };
  });

export interface DataStatusPayload {
  source: DataSourceStatus;
  asOfDate: string;
  dataProvider: string;
  dataVersion: string;
  strategyVersion: string;
  isLive: boolean;
  notes: string[];
  capabilities: AnalysisResult["capabilities"];
  coverage: Array<{ provider: string; kind: string; count: number; entities: number; ok: boolean }>;
  checks: {
    ohlcErrors: number;
    negativeVolume: number;
    duplicates: number;
    futureDates: number;
    insufficient: number;
    abnormalMoves: number;
  };
  barCoverage: Array<{ symbol: string; name: string; bars: number; first: string; last: string }>;
}

export const getDataStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<DataStatusPayload> => {
    const { dataset, status } = await loadDataset();
    const today = dataset.asOfDate;
    let ohlcErrors = 0;
    let negativeVolume = 0;
    let duplicates = 0;
    let futureDates = 0;
    let insufficient = 0;
    let abnormalMoves = 0;
    let priceRecords = 0;

    const barCoverage: DataStatusPayload["barCoverage"] = [];
    for (const inst of dataset.instruments) {
      const bars = dataset.bars[inst.symbol] ?? [];
      priceRecords += bars.length;
      if (bars.length < 120) insufficient++;
      const seen = new Set<string>();
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        if (
          b.high < b.low ||
          b.high < b.open ||
          b.high < b.close ||
          b.low > b.open ||
          b.low > b.close
        )
          ohlcErrors++;
        if (b.volume < 0) negativeVolume++;
        if (seen.has(b.tradeDate)) duplicates++;
        seen.add(b.tradeDate);
        if (b.tradeDate > today) futureDates++;
        if (i > 0) {
          const chg = b.close / bars[i - 1]!.close - 1;
          if (Math.abs(chg) > 0.29) abnormalMoves++;
        }
      }
      barCoverage.push({
        symbol: inst.symbol,
        name: inst.name,
        bars: bars.length,
        first: bars[0]?.tradeDate ?? "-",
        last: bars[bars.length - 1]?.tradeDate ?? "-",
      });
    }

    const stockCount = dataset.instruments.filter((i) => i.instrumentType === "STOCK").length;
    const etfCount = dataset.instruments.filter((i) => i.instrumentType === "ETF").length;
    const indexRecords = dataset.indexSeries.reduce((a, s) => a + s.bars.length, 0);

    return {
      source: status,
      asOfDate: dataset.asOfDate,
      dataProvider: dataset.provider,
      dataVersion: dataset.version,
      strategyVersion: runAnalysis(dataset).strategyVersion,
      isLive: dataset.isLive,
      notes: dataset.notes,
      capabilities: dataset.capabilities,
      coverage: [
        {
          provider: dataset.provider,
          kind: "종목 일봉",
          count: priceRecords,
          entities: dataset.instruments.length,
          ok: priceRecords > 0,
        },
        {
          provider: dataset.provider,
          kind: "지수 일봉",
          count: indexRecords,
          entities: dataset.indexSeries.length,
          ok: indexRecords > 0,
        },
        {
          provider: dataset.provider,
          kind: "재무 스냅샷",
          count: Object.keys(dataset.financials).length,
          entities: stockCount,
          ok: dataset.capabilities.fundamentals,
        },
        {
          provider: dataset.provider,
          kind: "ETF 상품 메타데이터",
          count: Object.keys(dataset.etfFacts).length,
          entities: etfCount,
          ok: dataset.capabilities.etfFacts,
        },
        {
          provider: dataset.provider,
          kind: "시가총액",
          count: dataset.capabilities.marketCap ? dataset.instruments.length : 0,
          entities: dataset.instruments.length,
          ok: dataset.capabilities.marketCap,
        },
        {
          provider: dataset.provider,
          kind: "투자자별 순매수",
          count: dataset.capabilities.investorFlow ? indexRecords : 0,
          entities: dataset.indexSeries.length,
          ok: dataset.capabilities.investorFlow,
        },
      ],
      checks: {
        ohlcErrors,
        negativeVolume,
        duplicates,
        futureDates,
        insufficient,
        abnormalMoves,
      },
      barCoverage,
    };
  },
);

export interface UniverseUploadPayload {
  count: number;
  symbols: string[];
  /** 사용자가 직접 지정했는지 여부 (false면 내장 코스피200 스냅샷) */
  custom: boolean;
  uploadedAt: string | null;
}

/** 홈 화면에서 입력한 종목코드로 스크리닝 유니버스를 교체한다. 빈 목록이면 내장 코스피200으로 복귀. */
export const setUniverse = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[] }) => ({
    symbols: (input.symbols ?? [])
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => /^[0-9A-Z]{6}$/.test(s))
      .slice(0, 500),
  }))
  .handler(async ({ data }): Promise<UniverseUploadPayload> => {
    const { setUniverseOverride, getUniverseOverride, getDefaultUniverseSymbols } = await import(
      "@/lib/engine/toss.server"
    );
    setUniverseOverride(data.symbols);
    const cur = getUniverseOverride();
    if (!cur) {
      const def = getDefaultUniverseSymbols();
      return { count: def.length, symbols: def, custom: false, uploadedAt: null };
    }
    return { count: cur.count, symbols: cur.symbols, custom: true, uploadedAt: cur.uploadedAt };
  });

export const getUniverse = createServerFn({ method: "GET" }).handler(
  async (): Promise<UniverseUploadPayload> => {
    const { getUniverseOverride, getDefaultUniverseSymbols } = await import(
      "@/lib/engine/toss.server"
    );
    const cur = getUniverseOverride();
    if (!cur) {
      const def = getDefaultUniverseSymbols();
      return { count: def.length, symbols: def, custom: false, uploadedAt: null };
    }
    return { count: cur.count, symbols: cur.symbols, custom: true, uploadedAt: cur.uploadedAt };
  },
);

export interface CollectionProgressPayload {
  done: number;
  total: number;
  running: boolean;
  cached: number;
}

/** 일봉 수집 진행률 조회 (대시보드 진행률 표시용) */
export const getCollectionProgress = createServerFn({ method: "GET" }).handler(
  async (): Promise<CollectionProgressPayload> => {
    const { getCollectionStatus } = await import("@/lib/engine/toss.server");
    return getCollectionStatus();
  },
);

export interface EtfUniversePayload {
  symbols: string[];
  updatedAt: string | null;
}

/** 스크리닝할 ETF 종목코드를 직접 지정한다. 빈 목록이면 거래대금 상위 ETF 자동 선정으로 되돌아간다. */
export const setEtfUniverse = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[] }) => ({
    symbols: (input.symbols ?? [])
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => /^[0-9A-Z]{6}$/.test(s))
      .slice(0, 100),
  }))
  .handler(async ({ data }): Promise<EtfUniversePayload> => {
    const { setEtfUniverseOverride, getEtfUniverseOverride } = await import(
      "@/lib/engine/toss.server"
    );
    setEtfUniverseOverride(data.symbols);
    const cur = getEtfUniverseOverride();
    return { symbols: cur?.symbols ?? [], updatedAt: cur?.updatedAt ?? null };
  });

export const getEtfUniverse = createServerFn({ method: "GET" }).handler(
  async (): Promise<EtfUniversePayload> => {
    const { getEtfUniverseOverride } = await import("@/lib/engine/toss.server");
    const cur = getEtfUniverseOverride();
    return { symbols: cur?.symbols ?? [], updatedAt: cur?.updatedAt ?? null };
  },
);

