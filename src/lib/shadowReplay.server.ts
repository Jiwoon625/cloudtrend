import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import type { ScoringConfig } from "./engine/scoring";
import { buildSnapshot, type ScreeningSnapshot } from "./screeningSnapshot";
import {
  ADOPTED_SERIES_VERSION,
  MODEL_ACCOUNTING_START,
  hashSeriesValue,
  type AdoptedSeriesKind,
  type SeriesHash,
} from "./ledger/modelSeries";
import {
  OCTOBER_CALENDAR_EVIDENCE,
  octoberModelCalendar,
  regularCloseAt,
  regularOpenAt,
} from "./ledger/octoberShadowCalendar";
import { nextKrRegularSession } from "./ledger/krShadowDecision";
import {
  recordOctoberPublication,
  type OctoberRecordResult,
  type OctoberRun,
} from "./ledger/octoberShadowPipeline";
import { octoberShadowStore } from "./ledger/octoberShadowRepository.server";
import manifest from "./ledger/octoberShadowEngineManifest.generated.json";
import {
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveAnalysis,
  type UsProspectiveInputRow,
  type UsProspectivePreviousState,
} from "./engine/usProspective";

const ANALYSIS_BUCKET = "cloudtrend-data";

export type ShadowReplayMode = "CONTEMPORANEOUS" | "RETROSPECTIVE";
export type ShadowReplayStatus = "RECORDED" | "REUSED" | "WAITING_INPUT" | "FAILED";

export interface ShadowReplayClock {
  market: "KR" | "US";
  signalDate: string;
  modelAvailableAt: string;
  modelDecisionAt: string;
  executionAt: string | null;
  calculatedAt: string;
  replayMode: ShadowReplayMode;
}

export interface ShadowReplayAuditInput {
  market: "KR" | "US";
  signalDate: string;
  calculatedAt: string;
  sourceCapturedAt: string | null;
  modelAvailableAt: string | null;
  modelDecisionAt: string | null;
  executionAt: string | null;
  replayMode: ShadowReplayMode;
  status: ShadowReplayStatus;
  sourceHash: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

export interface ShadowReplayBatchResult {
  market: "KR" | "US";
  calculatedAt: string;
  processed: Array<{
    date: string;
    status: "RECORDED" | "REUSED";
    replayMode: ShadowReplayMode;
    records: OctoberRecordResult["records"];
  }>;
  deferred: { date: string; reason: string } | null;
  latestRecordedDate: string | null;
  throughDate: string;
}

const US_KINDS: AdoptedSeriesKind[] = ["US_A0", "US_A2", "US_B3"];
const KR_KINDS: AdoptedSeriesKind[] = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "ETF_V02",
  "KR_KOSPI_CONFIRM1_BEAR",
];

function plusMs(value: string, ms: number) {
  return new Date(Date.parse(value) + ms).toISOString().replace(".000Z", "Z");
}

function nextRegularSession(market: "KR" | "US", afterDate: string): string | null {
  if (market === "KR") return nextKrRegularSession(afterDate);
  const holidays: readonly string[] = OCTOBER_CALENDAR_EVIDENCE.US.holidays;
  for (
    let at = Date.parse(`${afterDate}T00:00:00Z`) + 86400000;
    at <= Date.parse(`${OCTOBER_CALENDAR_EVIDENCE.coverageEnd}T00:00:00Z`);
    at += 86400000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    const day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.includes(date)) return date;
  }
  return null;
}

/**
 * Model event time is deterministic and independent from upload/runtime time.
 * - KR: T data is modeled as complete on the next reviewed KRX-session morning.
 * - US: T data is modeled as complete immediately after the verified regular close.
 * The actual runtime is retained only in shadow_replay_audit.
 */
export function shadowReplayClock(
  market: "KR" | "US",
  signalDate: string,
  calculatedAt = new Date().toISOString(),
): ShadowReplayClock {
  if (!Number.isFinite(Date.parse(calculatedAt))) throw new Error("Invalid replay calculation time");
  const next = nextRegularSession(market, signalDate);
  const executionAt = next ? regularOpenAt(market, next) : null;
  if (market === "KR") {
    if (!next) throw new Error("Reviewed KR calendar has no next execution session");
    const modelAvailableAt = `${next}T08:00:00+09:00`;
    const modelDecisionAt = `${next}T08:10:00+09:00`;
    return {
      market,
      signalDate,
      modelAvailableAt,
      modelDecisionAt,
      executionAt,
      calculatedAt,
      replayMode:
        executionAt && Date.parse(calculatedAt) <= Date.parse(executionAt)
          ? "CONTEMPORANEOUS"
          : "RETROSPECTIVE",
    };
  }
  const close = regularCloseAt("US", signalDate);
  const modelAvailableAt = plusMs(close, 60_000);
  const modelDecisionAt = plusMs(close, 120_000);
  return {
    market,
    signalDate,
    modelAvailableAt,
    modelDecisionAt,
    executionAt,
    calculatedAt,
    replayMode:
      executionAt && Date.parse(calculatedAt) <= Date.parse(executionAt)
        ? "CONTEMPORANEOUS"
        : "RETROSPECTIVE",
  };
}

export function sliceKrDatasetForReplay(raw: MarketDataset, date: string): MarketDataset {
  const copy = structuredClone(raw);
  const current = new Set(
    raw.instruments
      .filter((instrument) =>
        (raw.bars[instrument.symbol] ?? []).some((bar) => bar.tradeDate === date),
      )
      .map((instrument) => instrument.symbol),
  );
  copy.instruments = raw.instruments
    .filter((instrument) => current.has(instrument.symbol))
    .map((instrument) => structuredClone(instrument));
  copy.bars = Object.fromEntries(
    copy.instruments.map((instrument) => [
      instrument.symbol,
      (raw.bars[instrument.symbol] ?? [])
        .filter((bar) => bar.tradeDate <= date)
        .map((bar) => structuredClone(bar)),
    ]),
  );
  copy.indexSeries = raw.indexSeries.map((series) => ({
    ...structuredClone(series),
    bars: series.bars.filter((bar) => bar.tradeDate <= date).map((bar) => structuredClone(bar)),
  }));
  copy.tradeDates = raw.tradeDates.filter((day) => day <= date);
  copy.kospiGateDates = raw.kospiGateDates.filter((day) => day <= date);
  if (copy.vkospiObservations)
    copy.vkospiObservations = copy.vkospiObservations.filter((point) => point.date <= date);
  if (copy.kospiPriceInputIssues)
    copy.kospiPriceInputIssues = Object.fromEntries(
      Object.entries(copy.kospiPriceInputIssues).filter(([day]) => day <= date),
    );
  copy.asOfDate = date;
  copy.version = `${raw.version}@shadow-${date}`;
  return copy;
}

function currentDateEvidence(dataset: MarketDataset, snapshot: ScreeningSnapshot) {
  const date = snapshot.asOfDate;
  return {
    version: "shadow-dated-input-v1",
    date,
    universe: dataset.instruments.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market,
      instrumentType: instrument.instrumentType,
      sectorCode: instrument.sectorCode,
    })),
    bars: Object.fromEntries(
      dataset.instruments.map((instrument) => [
        instrument.symbol,
        (dataset.bars[instrument.symbol] ?? []).filter((bar) => bar.tradeDate === date),
      ]),
    ),
    indexes: dataset.indexSeries.map((series) => ({
      indexCode: series.indexCode,
      bars: series.bars.filter((bar) => bar.tradeDate === date),
    })),
    marketGate: snapshot.kospiMarketGate ?? null,
    snapshotEntries: snapshot.entries,
  };
}

async function insertReplayAudit(client: SupabaseClient, userId: string, row: ShadowReplayAuditInput) {
  const { error } = await client.from("shadow_replay_audit").insert({
    user_id: userId,
    market: row.market,
    signal_date: row.signalDate,
    calculated_at: row.calculatedAt,
    source_captured_at: row.sourceCapturedAt,
    model_available_at: row.modelAvailableAt,
    model_decision_at: row.modelDecisionAt,
    execution_at: row.executionAt,
    replay_mode: row.replayMode,
    status: row.status,
    source_hash: row.sourceHash,
    strategy_version: ADOPTED_SERIES_VERSION,
    reason: row.reason ?? null,
    details: row.details ?? {},
  });
  if (error) throw new Error(`Shadow replay audit 저장 실패: ${error.message}`);
}

async function alignedLatestDate(
  store: ReturnType<typeof octoberShadowStore>,
  kinds: AdoptedSeriesKind[],
): Promise<string | null> {
  const latest = await Promise.all(
    kinds.map(async (kind) => {
      const run = await store.readLatest<OctoberRun>(`${ADOPTED_SERIES_VERSION}:${kind}`);
      return run?.receipt.date ?? null;
    }),
  );
  const nonNull = latest.filter((value): value is string => value !== null);
  if (!nonNull.length) return null;
  if (new Set(latest).size !== 1)
    throw new Error("Shadow books are not aligned on one latest session; repair required before replay");
  return nonNull[0]!;
}

async function priorSnapshot(
  rawDataset: MarketDataset,
  config: ScoringConfig,
  beforeDate: string,
): Promise<ScreeningSnapshot | null> {
  const prior = rawDataset.tradeDates.filter((date) => date < beforeDate).sort().at(-1);
  if (!prior) return null;
  const sliced = sliceKrDatasetForReplay(rawDataset, prior);
  if (!sliced.instruments.length) return null;
  try {
    const { analysis } = runFullMarketAnalysis(sliced, config);
    const clock = shadowReplayClock("KR", prior, new Date().toISOString());
    return { ...buildSnapshot(analysis), savedAt: clock.modelAvailableAt };
  } catch {
    return null;
  }
}

function sourceCaptureForDate(
  sources: Array<{
    min_date?: string | null;
    max_date?: string | null;
    activated_at?: string | null;
    created_at?: string;
    savedAt?: string;
  }>,
  date: string,
) {
  return sources
    .filter((source) => {
      const min = source.min_date ?? null;
      const max = source.max_date ?? null;
      return !min || !max || (min <= date && max >= date);
    })
    .map((source) => source.activated_at ?? source.savedAt ?? source.created_at ?? "")
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export async function replayKrShadow(input: {
  client: SupabaseClient;
  userId: string;
  dataset: MarketDataset;
  config: ScoringConfig;
  sources: Array<{
    min_date?: string | null;
    max_date?: string | null;
    activated_at?: string | null;
    created_at?: string;
    savedAt?: string;
  }>;
  mode?: "service" | "authenticated-owner";
  calculatedAt?: string;
}): Promise<ShadowReplayBatchResult> {
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  const throughDate = input.dataset.asOfDate;
  const store = octoberShadowStore(input.client, input.userId, input.mode ?? "service");
  const latestRecordedDate = await alignedLatestDate(store, KR_KINDS);
  const calendar = await octoberModelCalendar("KR", throughDate);
  const start = latestRecordedDate
    ? calendar.regularSessions.find((date) => date > latestRecordedDate)
    : calendar.regularSessions.find((date) => date >= MODEL_ACCOUNTING_START);
  if (!start)
    return { market: "KR", calculatedAt, processed: [], deferred: null, latestRecordedDate, throughDate };

  const dates = calendar.regularSessions.filter((date) => date >= start && date <= throughDate);
  let previousSnapshot = await priorSnapshot(input.dataset, input.config, start);
  const processed: ShadowReplayBatchResult["processed"] = [];
  let lastRecorded = latestRecordedDate;

  for (const date of dates) {
    const clock = shadowReplayClock("KR", date, calculatedAt);
    if (Date.parse(calculatedAt) < Date.parse(regularCloseAt("KR", date))) {
      const reason = "정규장 종료 전 자료는 Shadow 일일 입력으로 확정하지 않습니다.";
      await insertReplayAudit(input.client, input.userId, {
        market: "KR",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: sourceCaptureForDate(input.sources, date),
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status: "WAITING_INPUT",
        sourceHash: null,
        reason,
      });
      return { market: "KR", calculatedAt, processed, deferred: { date, reason }, latestRecordedDate: lastRecorded, throughDate };
    }
    const sliced = sliceKrDatasetForReplay(input.dataset, date);
    const hasKospi = sliced.indexSeries
      .find((series) => series.indexCode === "KOSPI")
      ?.bars.some((bar) => bar.tradeDate === date);
    if (!hasKospi || !sliced.kospiGateDates.includes(date) || sliced.instruments.length === 0) {
      const reason = !hasKospi
        ? "KOSPI 기준일 시세가 없습니다."
        : !sliced.kospiGateDates.includes(date)
          ? "KRX 정규장 기준일 증거가 없습니다."
          : "해당 거래일 종목 행이 없습니다.";
      await insertReplayAudit(input.client, input.userId, {
        market: "KR",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: sourceCaptureForDate(input.sources, date),
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status: "WAITING_INPUT",
        sourceHash: null,
        reason,
      });
      return { market: "KR", calculatedAt, processed, deferred: { date, reason }, latestRecordedDate: lastRecorded, throughDate };
    }

    try {
      const { analysis, dataset } = runFullMarketAnalysis(sliced, input.config);
      if (analysis.asOfDate !== date) throw new Error("날짜별 분석 기준일이 replay 대상일과 다릅니다.");
      const snapshot: ScreeningSnapshot = {
        ...buildSnapshot(analysis, sourceCaptureForDate(input.sources, date) ?? undefined),
        savedAt: clock.modelAvailableAt,
      };
      const sourceHash = (await hashSeriesValue(
        currentDateEvidence(dataset, snapshot),
      )) as SeriesHash;
      const currentSymbols = new Set(snapshot.entries.map((entry) => entry.symbol));
      const priorSymbols =
        previousSnapshot?.entries.map((entry) => entry.symbol).filter((symbol) => currentSymbols.has(symbol)) ??
        [...currentSymbols];
      const priorDate =
        previousSnapshot?.asOfDate ??
        input.dataset.tradeDates.filter((day) => day < date).sort().at(-1) ??
        date;
      const frozen = await store.readSeries(`${ADOPTED_SERIES_VERSION}:KR_MIXED`);
      if (!frozen) throw new Error("KR Shadow registry is not initialized");
      const octoberShadow = await recordOctoberPublication(store, {
        market: "KR",
        dataset,
        analysis,
        snapshot,
        config: input.config,
        codeHash: frozen.codeHash,
        runtimeCodeHash: manifest.codeHash as SeriesHash,
        sourceHash,
        availableAt: clock.modelAvailableAt,
        decisionAt: clock.modelDecisionAt,
        confirmedRegularClose: true,
        failedSymbols: 0,
        universeEvidence: {
          asOfDate: priorDate < date ? priorDate : input.dataset.tradeDates.filter((day) => day < date).sort().at(-1) ?? MODEL_ACCOUNTING_START,
          sourceHash: previousSnapshot ? await hashSeriesValue(previousSnapshot) : sourceHash,
          symbols: priorSymbols.length ? [...new Set(priorSymbols)].sort() : [...currentSymbols].sort(),
        },
        sourceEvidence: [
          {
            sourceHash,
            asOfDate: date,
            registeredAt: clock.modelAvailableAt,
          },
        ],
      });
      const status = octoberShadow.records.every((record) => record.reused) ? "REUSED" : "RECORDED";
      await insertReplayAudit(input.client, input.userId, {
        market: "KR",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: sourceCaptureForDate(input.sources, date),
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status,
        sourceHash,
        details: {
          books: octoberShadow.records.length,
          universeCount: snapshot.entries.length,
          inputArchive: "KR_DAILY_INPUT",
        },
      });
      processed.push({
        date,
        status,
        replayMode: clock.replayMode,
        records: octoberShadow.records,
      });
      previousSnapshot = snapshot;
      lastRecorded = date;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Shadow replay 실패";
      await insertReplayAudit(input.client, input.userId, {
        market: "KR",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: sourceCaptureForDate(input.sources, date),
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status: "WAITING_INPUT",
        sourceHash: null,
        reason,
      });
      return { market: "KR", calculatedAt, processed, deferred: { date, reason }, latestRecordedDate: lastRecorded, throughDate };
    }
  }

  return {
    market: "KR",
    calculatedAt,
    processed,
    deferred: null,
    latestRecordedDate: lastRecorded,
    throughDate,
  };
}

export async function recordUsReplayAudit(
  client: SupabaseClient,
  userId: string,
  input: Omit<ShadowReplayAuditInput, "market">,
) {
  return insertReplayAudit(client, userId, { market: "US", ...input });
}


async function maybeStorageJson<T>(
  client: SupabaseClient,
  path: string,
): Promise<T | null> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) {
    if (/not.?found|404|Object not found/i.test(error.message)) return null;
    throw new Error(`Shadow replay artifact 조회 실패 (${path}): ${error.message}`);
  }
  return JSON.parse(await data.text()) as T;
}

async function putImmutableStorageJson(
  client: SupabaseClient,
  path: string,
  value: unknown,
) {
  const text = JSON.stringify(value);
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(path, text, {
    contentType: "application/json",
    upsert: false,
  });
  if (!error) return;
  const existing = await maybeStorageJson<unknown>(client, path);
  if (existing === null || JSON.stringify(existing) !== text)
    throw new Error(`Shadow replay 날짜 입력은 immutable입니다: ${path}`);
}

async function previousUsRankState(
  client: SupabaseClient,
  userId: string,
  date: string | null,
): Promise<UsProspectivePreviousState> {
  if (!date) return {};
  const shadow = await maybeStorageJson<{
    analysis?: { state?: UsProspectivePreviousState };
  }>(client, `${userId}/results/shadow-replay/US/${date}.json`);
  if (shadow?.analysis?.state) return shadow.analysis.state;
  const legacy = await maybeStorageJson<{
    analysis?: { state?: UsProspectivePreviousState };
  }>(client, `${userId}/results/us-screening/${date}.json`);
  return legacy?.analysis?.state ?? {};
}

export interface UsShadowReplayBatchResult extends ShadowReplayBatchResult {
  latestAnalysis: UsProspectiveAnalysis | null;
}

/**
 * Replays every missing US Shadow session from dated rows.
 * The source may contain one day or many days; upload/collection time never gates the model.
 */
export async function replayUsShadow(input: {
  client: SupabaseClient;
  userId: string;
  rows: UsProspectiveInputRow[];
  sourceCapturedAt: string | null;
  calculatedAt?: string;
  mode?: "service" | "authenticated-owner";
}): Promise<UsShadowReplayBatchResult> {
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  const datesInSource = [...new Set(input.rows.map((row) => row.date))].sort();
  const throughDate = datesInSource.at(-1) ?? MODEL_ACCOUNTING_START;
  if (!datesInSource.length)
    return {
      market: "US",
      calculatedAt,
      processed: [],
      deferred: { date: throughDate, reason: "US Shadow 입력 행이 없습니다." },
      latestRecordedDate: null,
      throughDate,
      latestAnalysis: null,
    };

  const store = octoberShadowStore(input.client, input.userId, input.mode ?? "service");
  const latestRecordedDate = await alignedLatestDate(store, US_KINDS);
  const calendar = await octoberModelCalendar("US", throughDate);
  const start = latestRecordedDate
    ? calendar.regularSessions.find((date) => date > latestRecordedDate)
    : calendar.regularSessions.find((date) => date >= MODEL_ACCOUNTING_START);
  if (!start)
    return {
      market: "US",
      calculatedAt,
      processed: [],
      deferred: null,
      latestRecordedDate,
      throughDate,
      latestAnalysis: null,
    };

  const byDate = new Map<string, UsProspectiveInputRow[]>();
  for (const row of input.rows) {
    const rows = byDate.get(row.date) ?? [];
    rows.push(row);
    byDate.set(row.date, rows);
  }
  const expected = calendar.regularSessions.filter((date) => date >= start && date <= throughDate);
  let rankState = await previousUsRankState(input.client, input.userId, latestRecordedDate);
  let latestAnalysis: UsProspectiveAnalysis | null = null;
  let lastRecorded = latestRecordedDate;
  const processed: ShadowReplayBatchResult["processed"] = [];

  for (const date of expected) {
    const clock = shadowReplayClock("US", date, calculatedAt);
    if (Date.parse(calculatedAt) < Date.parse(regularCloseAt("US", date))) {
      const reason = "미국 정규장 종료 전 자료는 Shadow 일일 입력으로 확정하지 않습니다.";
      await insertReplayAudit(input.client, input.userId, {
        market: "US",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: input.sourceCapturedAt,
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status: "WAITING_INPUT",
        sourceHash: null,
        reason,
      });
      return {
        market: "US",
        calculatedAt,
        processed,
        deferred: { date, reason },
        latestRecordedDate: lastRecorded,
        throughDate,
        latestAnalysis,
      };
    }
    const rows = byDate.get(date);
    if (!rows?.length) {
      const reason = "해당 미국 정규장 날짜의 입력 행이 없습니다.";
      await insertReplayAudit(input.client, input.userId, {
        market: "US",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: input.sourceCapturedAt,
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status: "WAITING_INPUT",
        sourceHash: null,
        reason,
      });
      return {
        market: "US",
        calculatedAt,
        processed,
        deferred: { date, reason },
        latestRecordedDate: lastRecorded,
        throughDate,
        latestAnalysis,
      };
    }

    try {
      const analysis = runUsProspectiveAnalysis(rows, rankState);
      const sourceHash = (await hashSeriesValue({
        version: "us-shadow-dated-input-v1",
        date,
        rows: [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol)),
      })) as SeriesHash;
      const frozen = await store.readSeries(`${ADOPTED_SERIES_VERSION}:US_A0`);
      if (!frozen) throw new Error("US Shadow registry is not initialized");
      const previousSessionDate =
        calendar.regularSessions.filter((session) => session < date).at(-1) ?? "2026-10-02";
      const result = await recordOctoberPublication(store, {
        market: "US",
        analysis,
        codeHash: frozen.codeHash,
        runtimeCodeHash: manifest.codeHash as SeriesHash,
        sourceHash,
        availableAt: clock.modelAvailableAt,
        decisionAt: clock.modelDecisionAt,
        confirmedRegularClose: true,
        failedSymbols: 0,
        previousSessionDate,
        marketCalendarOk: true,
      });
      const status = result.records.every((record) => record.reused) ? "REUSED" : "RECORDED";
      const artifact = {
        version: "us-shadow-replay-input-v1",
        date,
        sourceHash,
        ruleVersion: US_PROSPECTIVE_RULE_VERSION,
        sourceCapturedAt: input.sourceCapturedAt,
        calculatedAt,
        replayMode: clock.replayMode,
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        analysis: {
          date: analysis.date,
          ruleVersion: analysis.ruleVersion,
          summary: analysis.summary,
          state: analysis.state,
        },
      };
      await putImmutableStorageJson(
        input.client,
        `${input.userId}/results/shadow-replay/US/${date}.json`,
        artifact,
      );
      await insertReplayAudit(input.client, input.userId, {
        market: "US",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: input.sourceCapturedAt,
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status,
        sourceHash,
        details: {
          books: result.records.length,
          inputRows: analysis.summary.inputRows,
          ruleVersion: analysis.ruleVersion,
        },
      });
      rankState = analysis.state;
      latestAnalysis = analysis;
      lastRecorded = date;
      processed.push({
        date,
        status,
        replayMode: clock.replayMode,
        records: result.records,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "US Shadow replay 실패";
      await insertReplayAudit(input.client, input.userId, {
        market: "US",
        signalDate: date,
        calculatedAt,
        sourceCapturedAt: input.sourceCapturedAt,
        modelAvailableAt: clock.modelAvailableAt,
        modelDecisionAt: clock.modelDecisionAt,
        executionAt: clock.executionAt,
        replayMode: clock.replayMode,
        status: "WAITING_INPUT",
        sourceHash: null,
        reason,
      });
      return {
        market: "US",
        calculatedAt,
        processed,
        deferred: { date, reason },
        latestRecordedDate: lastRecorded,
        throughDate,
        latestAnalysis,
      };
    }
  }

  return {
    market: "US",
    calculatedAt,
    processed,
    deferred: null,
    latestRecordedDate: lastRecorded,
    throughDate,
    latestAnalysis,
  };
}
