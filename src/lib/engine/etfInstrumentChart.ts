import { createEtfScoreEvaluator } from "./etfHistoricalScore";
import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import type { InstrumentChartRange } from "./instrumentChart";
import { ETF_MAPPING, ETF_POLICY, isEtfStrategyAssetClass } from "./etfStrategy";
import { validDate } from "../ledger/date";
import {
  OPERATIONAL_INDEX_START,
  type OperationalIndexProvider,
  type OperationalIndexPoint,
} from "../operationalUnderlyingIndex";

export interface EtfInstrumentChartBundle {
  symbol: string;
  asOfDate: string;
  version: string;
  chart: Array<{
    tradeDate: string;
    close: number | null;
    volume: number | null;
    m0Score: number | null;
  }>;
  underlying: Array<{
    tradeDate: string;
    close: number | null;
    ma60: number | null;
    name: string | null;
    /** First point of a changed index is a deliberate chart discontinuity. */
    identityBreak: boolean;
  }>;
  underlyingName: string | null;
  underlyingSource: string | null;
  underlyingFirstDate: string | null;
  underlyingAsOfDate: string | null;
  /** Pinned evidence shared with the current strategy; never applied to historical M0. */
  underlyingIndexVersion?: string;
  underlyingIndexArtifactSha256?: string;
  underlyingIndexAvailableFrom?: string;
  underlyingIndexAsOfDate?: string;
  previousM0: { date: string; score: number } | null;
  previousTradingDate: string | null;
  issues: string[];
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const score = (value: unknown): value is number => finite(value) && value >= 0 && value <= 100;
const named = (name: string | null | undefined): string | null =>
  name?.trim() && !/^(null|none|nan|na|-|--)$/i.test(name.trim()) ? name.trim() : null;
const normalizeName = (name: string) => name.toUpperCase().replace(/\s/g, "");
const krxUnderlying = (bar: DailyPrice | undefined): number | null =>
  bar &&
  (bar.etfUnderlyingIndexSource === undefined
    ? bar.marketCapSource === "KRX_ETF" || bar.tradingValueSource === "KRX_ETF"
    : bar.etfUnderlyingIndexSource === "KRX_ETF") &&
  positive(bar.etfUnderlyingIndexClose)
    ? bar.etfUnderlyingIndexClose
    : null;

// Source datasets are immutable. Weak keys release historical observations when
// the dataset is replaced; no raw data or chart evidence is written externally.
const evaluators = new WeakMap<MarketDataset, ReturnType<typeof createEtfScoreEvaluator>>();
function evaluatorFor(dataset: MarketDataset) {
  let evaluator = evaluators.get(dataset);
  if (!evaluator) {
    evaluator = createEtfScoreEvaluator(dataset, ETF_MAPPING);
    evaluators.set(dataset, evaluator);
  }
  return evaluator;
}

/** Ambiguous duplicate dates fail closed instead of silently choosing a revision. */
function observationsByDate(bars: readonly DailyPrice[], asOfDate: string) {
  const result = new Map<string, DailyPrice | undefined>();
  for (const bar of bars) {
    if (!validDate(bar.tradeDate) || bar.tradeDate > asOfDate) continue;
    result.set(bar.tradeDate, result.has(bar.tradeDate) ? undefined : bar);
  }
  return result;
}

/** Price-first projection must use the same real observations and gaps as M0.
 * It deliberately does not initialize or call a score evaluator. */
export function etfObservedPriceChart(
  dataset: MarketDataset,
  symbol: string,
  range: InstrumentChartRange = "120",
) {
  if (dataset.instruments.find((item) => item.symbol === symbol)?.instrumentType !== "ETF")
    throw new Error("ETF 차트 대상이 아닙니다.");
  if (!validDate(dataset.asOfDate)) throw new Error("ETF 차트 기준일이 올바르지 않습니다.");
  const analytical = observationsByDate(dataset.bars[symbol] ?? [], dataset.asOfDate);
  const observed = observationsByDate(
    dataset.observedBars?.[symbol] ?? dataset.bars[symbol] ?? [],
    dataset.asOfDate,
  );
  const first = [...observed.keys(), ...analytical.keys()].sort()[0];
  const dates = first
    ? [
        ...new Set([
          ...dataset.tradeDates.filter(
            (date) => validDate(date) && date >= first && date <= dataset.asOfDate,
          ),
          ...observed.keys(),
          ...analytical.keys(),
          dataset.asOfDate,
        ]),
      ].sort()
    : [];
  return {
    chart: (range === "120" ? dates.slice(-120) : dates).map((tradeDate) => {
      const bar = observed.get(tradeDate);
      return {
        tradeDate,
        close: positive(bar?.close) ? bar.close : null,
        volume:
          bar && bar.volumeObserved !== false && finite(bar.volume) && bar.volume >= 0
            ? bar.volume
            : null,
      };
    }),
    history: [],
  };
}

function chartBuilder(
  dataset: MarketDataset,
  symbol: string,
  range: InstrumentChartRange,
  operationalIndex?: OperationalIndexProvider,
) {
  const instrument = dataset.instruments.find((item) => item.symbol === symbol);
  if (instrument?.instrumentType !== "ETF") throw new Error("ETF 차트 대상이 아닙니다.");
  if (!validDate(dataset.asOfDate)) throw new Error("ETF 차트 기준일이 올바르지 않습니다.");
  const provider = dataset.asOfDate >= OPERATIONAL_INDEX_START ? operationalIndex : undefined;
  if (provider && provider.asOfDate !== dataset.asOfDate)
    throw new Error("ETF 차트와 운영 기초지수 기준일이 다릅니다.");
  const operationalRow = provider?.rows[symbol];
  const operationalPoints = new Map<string, OperationalIndexPoint | undefined>();
  for (const point of operationalRow?.observations ?? []) {
    if (!validDate(point.date) || point.date > dataset.asOfDate) continue;
    operationalPoints.set(point.date, operationalPoints.has(point.date) ? undefined : point);
  }
  const evaluator = evaluatorFor(dataset);
  const mapping = ETF_MAPPING[symbol];
  const calendar = evaluator.calendar.filter(validDate);
  const positions = new Map(calendar.map((date, index) => [date, index]));
  const analytical = observationsByDate(dataset.bars[symbol] ?? [], dataset.asOfDate);
  const observed = observationsByDate(
    dataset.observedBars?.[symbol] ?? dataset.bars[symbol] ?? [],
    dataset.asOfDate,
  );
  const first = [...observed.keys(), ...analytical.keys()].sort()[0];
  const dates = first
    ? [
        ...new Set([
          ...calendar.filter((date) => date >= first),
          ...observed.keys(),
          ...analytical.keys(),
          dataset.asOfDate,
        ]),
      ].sort()
    : [];
  const currentPosition = positions.get(dataset.asOfDate);
  const previousTradingDate =
    currentPosition !== undefined && currentPosition > 0 ? calendar[currentPosition - 1]! : null;
  const result: EtfInstrumentChartBundle = {
    symbol,
    asOfDate: dataset.asOfDate,
    version: ETF_POLICY.version,
    chart: [],
    underlying: [],
    underlyingName: null,
    underlyingSource: null,
    underlyingFirstDate: null,
    underlyingAsOfDate: null,
    ...(provider
      ? {
          underlyingIndexVersion: provider.version,
          underlyingIndexArtifactSha256: provider.artifactSha256,
          underlyingIndexAvailableFrom: provider.availableFrom,
          underlyingIndexAsOfDate: provider.asOfDate,
        }
      : {}),
    previousM0: null,
    previousTradingDate,
    issues: [],
  };
  const target =
    isEtfStrategyAssetClass(mapping) && !instrument.isLeveraged && !instrument.isInverse;
  if (!mapping) result.issues.push("검증된 ETF 분류 없음 · M0 미관측");
  else if (!target)
    result.issues.push("주식형·커버드콜 ETF 전략 대상 아님 · 표시 점수는 진입 근거가 아님");
  if (provider) result.issues.push(...(operationalRow?.issues ?? ["운영 기초지수 대응 없음"]));
  // These are dated reconstructed observations, not operational signals. The
  // operational 2026-10-12 start date deliberately does not trim chart history.
  const start = range === "all" ? 0 : Math.max(0, dates.length - 120);
  const m0At = (date: string): number | null => {
    const position = positions.get(date),
      bar = analytical.get(date);
    if (!mapping || position === undefined || position === 0 || !bar || !positive(bar.close))
      return null;
    const previousDate = calendar[position - 1]!;
    const previous = analytical.get(previousDate);
    if (!previous || !positive(previous.close)) return null;
    const evaluation = evaluator.at(symbol, date);
    if (
      !evaluation ||
      ![evaluation.technical, evaluation.priority, evaluation.health, evaluation.environment].every(
        score,
      ) ||
      !score(evaluation.score)
    )
      return null;
    if (
      evaluation.issues.some((issue) =>
        [
          "기준일 ETF 가격 없음",
          "수정주가 출처·120일 이력 확인 필요",
          "기술점수 이력 부족",
          "벤치마크 수익률 없음",
          "KRX 시총·20일 거래대금 필요",
          "환경점수 데이터 없음",
        ].includes(issue),
      )
    )
      return null;
    return evaluation.score;
  };
  if (previousTradingDate) {
    const previousScore = m0At(previousTradingDate);
    if (previousScore !== null)
      result.previousM0 = { date: previousTradingDate, score: previousScore };
  }
  let latestNamed: string | null = null;
  let latestIdentity: string | null = null;
  let hadUnderlyingObservation = false;
  let nameChanged = false;
  let unlabelled = false;
  const underlyingValues = new Map<
    string,
    {
      close: number | null;
      identity: string | null;
      name: string | null;
      identityBreak: boolean;
      operational: boolean;
      operationalMa60: number | null;
    }
  >();
  // Compute all underlying inputs before range slicing. A 120-session display
  // retains the same 60-session warmup as the full-history view.
  for (const date of dates) {
    const bar = observed.get(date);
    const operational = !!provider && date >= OPERATIONAL_INDEX_START;
    const point = operationalPoints.get(date);
    const usable = operationalRow?.status !== "quarantined";
    const close = operational
      ? usable && positive(point?.close)
        ? point.close
        : null
      : krxUnderlying(bar);
    const name = named(operational ? operationalRow?.indexName : bar?.etfUnderlyingIndexName);
    const identity = name ? normalizeName(name) : null;
    const identityBreak = close !== null && hadUnderlyingObservation && identity !== latestIdentity;
    underlyingValues.set(date, {
      close,
      identity,
      name,
      identityBreak,
      operational,
      operationalMa60:
        operational && usable && close !== null && positive(point?.ma60) ? point.ma60 : null,
    });
    if (close === null) continue;
    if (latestIdentity !== null && identity !== null && identity !== latestIdentity)
      nameChanged = true;
    latestIdentity = identity;
    hadUnderlyingObservation = true;
    latestNamed = name;
    unlabelled ||= name === null;
    result.underlyingFirstDate ??= date;
    result.underlyingAsOfDate = date;
  }
  result.underlyingName = latestNamed;
  result.underlyingSource = result.underlyingAsOfDate
    ? provider && result.underlyingAsOfDate >= OPERATIONAL_INDEX_START
      ? "KRX_ETF_APPROVED_BASE"
      : "KRX_ETF"
    : null;
  if (unlabelled)
    result.issues.push(
      "일부 기초지수 관측의 당시 지수명 미보존 · 현재 지수명으로 과거를 대체하지 않음",
    );
  if (nameChanged) result.issues.push("기초지수명 변경 구간은 MA60을 연결하지 않음");
  if (!result.underlyingAsOfDate)
    result.issues.push("KRX 기초지수 실제 관측 없음 · 가격·NAV·KOSPI 대체 없음");
  const append = (index: number) => {
    const date = dates[index]!,
      bar = observed.get(date);
    result.chart.push({
      tradeDate: date,
      close: positive(bar?.close) ? bar.close : null,
      volume:
        bar && bar.volumeObserved !== false && finite(bar.volume) && bar.volume >= 0
          ? bar.volume
          : null,
      m0Score: m0At(date),
    });
    const value = underlyingValues.get(date)!;
    const position = positions.get(date);
    const window =
      position !== undefined && position >= 59
        ? calendar
            .slice(position - 59, position + 1)
            .map((session) => underlyingValues.get(session))
        : [];
    const ma60 =
      window.length === 60 &&
      window.every(
        (point) =>
          point &&
          point.close !== null &&
          value.identity !== null &&
          point.identity === value.identity,
      )
        ? window.reduce((total, point) => total + point!.close!, 0) / 60
        : null;
    result.underlying.push({
      tradeDate: date,
      close: value.close,
      // Operational MA60 has its own approved 60-session warmup. Do not recompute
      // it from the preserved pre-activation display or substitute into M0 inputs.
      ma60: value.operational ? value.operationalMa60 : ma60,
      name: value.name,
      identityBreak: value.identityBreak,
    });
  };
  return { result, start, length: dates.length, append };
}

/** Synchronous pure build for server warmup and deterministic evidence tests. */
export function etfInstrumentChartSeries(
  dataset: MarketDataset,
  symbol: string,
  range: InstrumentChartRange = "120",
  operationalIndex?: OperationalIndexProvider,
): EtfInstrumentChartBundle {
  const builder = chartBuilder(dataset, symbol, range, operationalIndex);
  for (let index = builder.start; index < builder.length; index++) builder.append(index);
  return builder.result;
}

/** Only the selected ETF is scored, with yielding for full-history requests. */
export async function buildEtfInstrumentChart(
  dataset: MarketDataset,
  symbol: string,
  range: InstrumentChartRange = "120",
  operationalIndex?: OperationalIndexProvider,
): Promise<EtfInstrumentChartBundle> {
  const builder = chartBuilder(dataset, symbol, range, operationalIndex);
  for (let index = builder.start; index < builder.length;) {
    const end = Math.min(index + 20, builder.length);
    for (; index < end; index++) builder.append(index);
    if (index < builder.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return builder.result;
}
