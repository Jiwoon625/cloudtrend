import {
  krDailyInputArchive,
  resolveKrInputArchive,
  type KrDailyInputArchive,
} from "./octoberShadowArchive";
import { validDate } from "./date";
import type { MarketDataset } from "../engine/dataset";
import type { AnalysisResult } from "../engine/pipeline";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "../engine/scoring";
import type { UsProspectiveAnalysis } from "../engine/usProspective";
import type { ScreeningSnapshot } from "../screeningSnapshot";
import { buildKospiShadowSession } from "../engine/kospiShadowDataset";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  guardModelRun,
  verifyFrozenSeries,
  MODEL_ACCOUNTING_START,
  ADOPTED_SERIES_VERSION,
  type AdoptedSeriesKind,
  type FrozenModelSeries,
  type SeriesHash,
  type ModelCalendar,
  stepAdoptedUsSeries,
  type AdoptedUsRun,
} from "./modelSeries";
import { stepAdoptedKrSeries, type AdoptedKrRun } from "./krAdoptedShadow";
import { stepAdoptedEtfSeries, type AdoptedEtfRun } from "./etfAdoptedShadow";
import {
  ADOPTED_KOSPI_FIRST_SESSION,
  stepAdoptedKospiShadowSeries,
  type AdoptedKospiShadowRun,
} from "./kospiAdoptedShadow";
import type { OctoberShadowStore } from "./octoberShadowRepository.server";
import type { ModelJournalRun } from "./modelJournal";
import {
  assertKrShadowDecisionWindow,
  octoberModelCalendar,
  regularCloseAt,
  regularOpenAt,
} from "./octoberShadowCalendar";
import { fromLegacyNumber } from "./decimal";

export interface PublicationProof {
  sourceHash: SeriesHash;
  codeHash: SeriesHash;
  availableAt: string;
  decisionAt: string;
  confirmedRegularClose: boolean;
  failedSymbols: number;
}
export interface KrModelPublication extends PublicationProof {
  market: "KR";
  dataset: MarketDataset;
  analysis: AnalysisResult;
  snapshot: ScreeningSnapshot;
  config: ScoringConfig;
  universeEvidence: { asOfDate: string; sourceHash: SeriesHash; symbols: string[] };
  sourceEvidence: Array<{ sourceHash: SeriesHash; asOfDate: string; registeredAt: string }>;
}
export interface UsModelPublication extends PublicationProof {
  market: "US";
  analysis: UsProspectiveAnalysis;
  previousSessionDate: string;
  marketCalendarOk: boolean;
}
export type OctoberPublication = KrModelPublication | UsModelPublication;
export type OctoberRun = (AdoptedUsRun | AdoptedKrRun | AdoptedEtfRun | AdoptedKospiShadowRun) & {
  publication: {
    version: "october-manual-publication-v1";
    inputHash: SeriesHash;
    sourceHash: SeriesHash;
    availableAt: string;
    decisionAt: string;
  };
};
export interface OctoberRecordResult {
  status: "WAITING_START" | "RECORDED";
  date: string;
  records: Array<{ bookId: string; reused: boolean; stateHash: string }>;
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const marketDate = (market: "KR" | "US", at: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "KR" ? "Asia/Seoul" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));

function verifyPublication(input: OctoberPublication, calendar: ModelCalendar) {
  const date = input.market === "US" ? input.analysis.date : input.analysis.asOfDate;
  if (
    !input.confirmedRegularClose ||
    input.failedSymbols !== 0 ||
    !input.analysis.rows.length ||
    !Number.isFinite(Date.parse(input.availableAt)) ||
    !Number.isFinite(Date.parse(input.decisionAt)) ||
    Date.parse(input.availableAt) > Date.parse(input.decisionAt) ||
    Date.parse(input.availableAt) < Date.parse(regularCloseAt(input.market, date)) ||
    !calendar.regularSessions.includes(date)
  )
    throw new Error("Only a complete finalized regular close can enter the Shadow journal");
  if (input.market === "US") {
    if (
      marketDate("US", input.availableAt) !== date ||
      marketDate("US", input.decisionAt) !== date
    )
      throw new Error("US Shadow requires same-session finalized close evidence");
  } else {
    assertKrShadowDecisionWindow(date, input.availableAt, input.decisionAt);
  }
  const symbols =
    input.market === "US"
      ? input.analysis.rows.map((row) => row.symbol)
      : input.analysis.rows.map((row) => row.instrument.symbol);
  if (new Set(symbols).size !== symbols.length)
    throw new Error("Duplicate symbols in a completed publication");
  if (input.market === "KR") {
    const expected = input.universeEvidence;
    const currentSymbols = new Set(input.analysis.rows.map((row) => row.instrument.symbol));
    const currentSources = input.sourceEvidence.filter((source) => source.asOfDate === date);
    if (
      !expected ||
      !expected.symbols.length ||
      !validDate(expected.asOfDate) ||
      expected.asOfDate >= date ||
      !/^sha256:[a-f0-9]{64}$/.test(expected.sourceHash) ||
      new Set(expected.symbols).size !== expected.symbols.length ||
      expected.symbols.some((symbol) => !currentSymbols.has(symbol)) ||
      !currentSources.length ||
      currentSources.some(
        (source) =>
          !/^sha256:[a-f0-9]{64}$/.test(source.sourceHash) ||
          Date.parse(source.registeredAt) < Date.parse(regularCloseAt("KR", date)),
      ) ||
      input.sourceEvidence.some(
        (source) =>
          !Number.isFinite(Date.parse(source.registeredAt)) ||
          source.asOfDate > date ||
          Date.parse(source.registeredAt) > Date.parse(input.availableAt),
      ) ||
      input.availableAt !==
        [...input.sourceEvidence]
          .map((source) => source.registeredAt)
          .sort((a, b) => Date.parse(a) - Date.parse(b))
          .at(-1)
    )
      throw new Error(
        "KR complete-session evidence does not cover the previous screened universe and every source availability",
      );
  }
  if (input.market === "US") {
    const prior = calendar.regularSessions.filter((d) => d < date).at(-1) ?? "2026-10-02";
    if (
      !input.marketCalendarOk ||
      input.previousSessionDate !== prior ||
      input.analysis.rows.some((row) => row.date !== date)
    )
      throw new Error("US source calendar or row dates do not match the verified session sequence");
  } else if (
    canonicalSeriesJson(json(input.config)) !== canonicalSeriesJson(json(DEFAULT_SCORING_CONFIG)) ||
    !input.dataset.isLive ||
    input.dataset.asOfDate !== date ||
    input.snapshot.asOfDate !== date ||
    input.snapshot.date !== date ||
    input.analysis.rows.some((row) => row.snapshot.tradeDate !== date)
  ) {
    throw new Error("KR dataset/snapshot is synthetic, stale or incomplete");
  }
}
function publicationValue(input: OctoberPublication) {
  // A rerun's wall-clock calculation time is not a market input. Source registration is immutable.
  if (input.market === "US") return json({ ...input, decisionAt: null, codeHash: null });
  return json({
    market: input.market,
    sourceHash: input.sourceHash,
    availableAt: input.availableAt,
    confirmedRegularClose: input.confirmedRegularClose,
    failedSymbols: input.failedSymbols,
    config: input.config,
    universeEvidence: input.universeEvidence,
    sourceEvidence: input.sourceEvidence,
    dataset: {
      provider: input.dataset.provider,
      version: input.dataset.version,
      asOfDate: input.dataset.asOfDate,
      isLive: input.dataset.isLive,
      currentBars: Object.fromEntries(
        Object.entries(input.dataset.bars).map(([symbol, rows]) => [
          symbol,
          rows.filter((row) => row.tradeDate === input.analysis.asOfDate),
        ]),
      ),
    },
    analysis: { ...input.analysis, calculatedAt: null },
    snapshot: { ...input.snapshot, savedAt: null },
  });
}
export async function assertStoredOctoberRun(series: FrozenModelSeries, run: OctoberRun) {
  await verifyFrozenSeries(series);
  await guardModelRun(series, run.receipt, run.receipt);
  const { stateHash, ...body } = run;
  if (
    run.book !== "MODEL" ||
    run.bookId !== series.bookId ||
    run.contractHash !== series.contractHash ||
    run.receipt.configHash !== series.configHash ||
    run.receipt.codeHash !== series.codeHash ||
    (await hashSeriesValue(body)) !== stateHash
  )
    throw new Error("Stored October session integrity mismatch");
}

export interface PreparedOctoberPublication {
  version: "october-prepared-publication-v1";
  market: "KR" | "US";
  date: string;
  sourceHash: SeriesHash;
  codeHash: SeriesHash;
  inputHash: SeriesHash;
  preparedAt: string;
  entries: Array<{
    series: FrozenModelSeries;
    run: OctoberRun;
    previousDate: string | null;
    previousHash: SeriesHash | null;
  }>;
  preparedHash: SeriesHash;
}
async function persistPreparedOctober(
  store: OctoberShadowStore,
  prepared: PreparedOctoberPublication,
): Promise<OctoberRecordResult> {
  const { preparedHash, ...body } = prepared;
  if ((await hashSeriesValue(body)) !== preparedHash)
    throw new Error("Prepared October publication integrity mismatch");
  const expectedKinds =
    prepared.market === "US"
      ? ["US_A0", "US_A2", "US_B3"]
      : ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
  if (
    canonicalSeriesJson(prepared.entries.map((item) => item.series.policy.kind)) !==
    canonicalSeriesJson(expectedKinds)
  )
    throw new Error("Incomplete prepared October book set");
  const records: OctoberRecordResult["records"] = [];
  for (const item of prepared.entries) {
    const registered = await store.readSeries(item.series.bookId);
    if (!registered || canonicalSeriesJson(registered) !== canonicalSeriesJson(item.series))
      throw new Error("Prepared October contract changed");
    await assertStoredOctoberRun(registered, item.run);
    if (
      item.run.receipt.date !== prepared.date ||
      item.run.publication.inputHash !== prepared.inputHash ||
      item.run.publication.sourceHash !== prepared.sourceHash ||
      item.run.receipt.codeHash !== prepared.codeHash
    )
      throw new Error("Prepared October input identity mismatch");
    const exists = await store.readSession<OctoberRun>(registered.bookId, prepared.date);
    if (exists) {
      if (canonicalSeriesJson(exists) !== canonicalSeriesJson(item.run))
        throw new Error("Prepared October day conflicts with immutable history");
      records.push({ bookId: registered.bookId, reused: true, stateHash: exists.stateHash });
      continue;
    }
    const previous = item.previousDate
      ? await store.readSession<OctoberRun>(registered.bookId, item.previousDate)
      : null;
    if ((previous?.stateHash ?? null) !== item.previousHash)
      throw new Error("Prepared October predecessor is unavailable");
    const saved = await store.append(registered, item.run, previous);
    records.push({ bookId: registered.bookId, ...saved });
  }
  return { status: "RECORDED", date: prepared.date, records };
}

/** No timers or data collection. Called only by an explicitly run completed upload/screening path. */
export async function recordOctoberPublication(
  store: OctoberShadowStore,
  input: OctoberPublication,
): Promise<OctoberRecordResult> {
  const date = input.market === "US" ? input.analysis.date : input.analysis.asOfDate;
  if (date < MODEL_ACCOUNTING_START) return { status: "WAITING_START", date, records: [] };
  const inputHash = await hashSeriesValue(publicationValue(input));
  const durable = await store.readPrepared(input.market, date);
  if (durable) {
    if (
      durable.sourceHash !== input.sourceHash ||
      durable.inputHash !== inputHash ||
      durable.codeHash !== input.codeHash
    )
      throw new Error("Prepared October input is immutable");
    return persistPreparedOctober(store, durable);
  }
  const calendar = await octoberModelCalendar(input.market, date);
  verifyPublication(input, calendar);
  const kinds: AdoptedSeriesKind[] =
    input.market === "US"
      ? ["US_A0", "US_A2", "US_B3"]
      : ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
  const archiveCache = new Map<string, Promise<KrDailyInputArchive>>();
  const readArchive = (day: string, hash: SeriesHash) => {
    const key = `${day}:${hash}`;
    if (!archiveCache.has(key)) archiveCache.set(key, store.readKrInput(day, hash));
    return archiveCache.get(key)!;
  };
  let currentArchiveRef: { date: string; hash: SeriesHash } | null = null;
  const currentArchive =
    input.market === "KR"
      ? krDailyInputArchive(input.dataset, input.snapshot, input.decisionAt)
      : null;
  const prepared: Array<{
    series: FrozenModelSeries;
    run: OctoberRun;
    previous: OctoberRun | null;
    reused: boolean;
  }> = [];
  for (const kind of kinds) {
    const series = await store.readSeries(`${ADOPTED_SERIES_VERSION}:${kind}`);
    if (!series) throw new Error(`October model registry is not initialized: ${kind}`);
    await verifyFrozenSeries(series);
    if (series.codeHash !== input.codeHash)
      throw new Error(`Frozen engine manifest changed: ${kind}`);
    const saved = await store.readSession<OctoberRun>(series.bookId, date);
    if (saved) {
      await assertStoredOctoberRun(series, saved);
      if (
        saved.publication?.inputHash !== inputHash ||
        saved.publication.sourceHash !== input.sourceHash
      )
        throw new Error(`Completed October date is immutable: ${kind} ${date}`);
      prepared.push({ series, run: saved, previous: null, reused: true });
      continue;
    }
    const previous = await store.readLatest<OctoberRun>(series.bookId);
    if (previous) await assertStoredOctoberRun(series, previous);
    if (previous) {
      const held =
        input.market === "US"
          ? Object.keys((previous as AdoptedUsRun).result.state.positions)
          : kind === "ETF_V02"
            ? (previous as AdoptedEtfRun).result.state.positions.map((p) => p.symbol)
            : kind === "KR_KOSPI_CONFIRM1_BEAR"
              ? Object.keys((previous as AdoptedKospiShadowRun).result.state.positions)
              : (previous as AdoptedKrRun).result.trades
                  .filter((t) => t.status === "OPEN")
                  .map((t) => t.symbol);
      for (const symbol of held) {
        const row =
          input.market === "US"
            ? input.analysis.rows.find((r) => r.symbol === symbol)
            : input.dataset.bars[symbol]?.find((b) => b.tradeDate === date);
        if (
          !row ||
          !Number.isFinite(row.open) ||
          !Number.isFinite(row.close) ||
          Number(row.open) <= 0 ||
          Number(row.close) <= 0
        )
          throw new Error(`Held security is missing complete current OHLC: ${symbol}`);
      }
    }
    let stepped: ModelJournalRun;
    if (input.market === "US") {
      stepped = (
        await stepAdoptedUsSeries(
          series,
          { ...input, calendar, configHash: series.configHash },
          previous as (AdoptedUsRun & OctoberRun) | null,
        )
      ).run;
    } else if (kind === "KR_KOSPI_CONFIRM1_BEAR") {
      const session = buildKospiShadowSession(
        input.dataset,
        input.config,
        {
          sourceHash: input.sourceHash,
          configHash: series.configHash,
          codeVersion: input.codeHash,
          sourceCollectedAt: input.availableAt,
          now: input.decisionAt,
        },
        date,
        input.analysis,
      );
      session.previousSessionDate = calendar.regularSessions.filter((d) => d < date).at(-1) ?? null;
      if (!previous && date === ADOPTED_KOSPI_FIRST_SESSION) {
        // Read-only warmup uses only the exact preceding reviewed KR session.
        // It can establish the first v2 onset; it never imports old model orders or holdings.
        const analysisRows = new Map(
          input.analysis.rows.map((row) => [row.instrument.symbol, row]),
        );
        const warmupDate = session.previousSessionDate;
        session.warmupRows = warmupDate
          ? session.rows.flatMap((row) => {
              const observed = analysisRows.get(row.symbol);
              const bar = input.dataset.bars[row.symbol]?.find((b) => b.tradeDate === warmupDate);
              if (
                !bar ||
                observed?.previousOperatingScoreDate !== warmupDate ||
                observed.previousOperatingScore10 == null
              )
                return [];
              return [
                {
                  ...row,
                  date: warmupDate,
              open: bar.open,
              close: bar.close,
              volume: bar.volume,
              score: observed.previousOperatingScore10,
              priority: null,
              rsAccel: null,
              commonHistory: false,
              onsetEligible: false,
                },
              ];
            })
          : [];
      }
      stepped = (
        await stepAdoptedKospiShadowSeries(
          series,
          {
            session,
            calendar,
            codeHash: input.codeHash,
            configHash: series.configHash,
            decisionAt: input.decisionAt,
          },
          previous as (AdoptedKospiShadowRun & OctoberRun) | null,
        )
      ).run;
    } else if (kind === "ETF_V02") {
      const rows = input.analysis.rows.filter((r) => r.instrument.instrumentType === "ETF");
      if (
        !rows.length ||
        rows.some((r) => !r.etfStrategy || r.etfStrategy.dataStatus === "krx_batch_pending")
      )
        throw new Error("ETF completed close/strategy data is still pending");
      const openAt = regularOpenAt("KR", date);
      stepped = (
        await stepAdoptedEtfSeries(
          series,
          {
            sessionDate: date,
            previousSessionDate: previous?.receipt.date ?? null,
            openAt,
            closeAt: regularCloseAt("KR", date),
            decisionAt: input.decisionAt,
            calendar,
            codeHash: input.codeHash,
            configHash: series.configHash,
            sourceHash: input.sourceHash,
            prices: rows.map((row) => {
              const bar = input.dataset.bars[row.instrument.symbol]?.find(
                (b) => b.tradeDate === date,
              );
              if (
                !bar ||
                !Number.isFinite(bar.open) ||
                !Number.isFinite(bar.close) ||
                bar.open <= 0 ||
                bar.close <= 0
              )
                throw new Error(`ETF current OHLC missing: ${row.instrument.symbol}`);
              // OHLC reference-time is the market event time; collection time is retained on publication.
              return {
                symbol: row.instrument.symbol,
                open: {
                  asOfDate: date,
                  availableAt: openAt,
                  sourceHash: input.sourceHash,
                  price: fromLegacyNumber(bar.open),
                },
                close: {
                  asOfDate: date,
                  availableAt: input.availableAt,
                  sourceHash: input.sourceHash,
                  price: fromLegacyNumber(bar.close),
                },
              };
            }),
            closeSignals: rows.map((row) => ({
              symbol: row.instrument.symbol,
              availableAt: input.availableAt,
              sourceHash: input.sourceHash,
              strategy: row.etfStrategy!,
            })),
          },
          previous as (AdoptedEtfRun & OctoberRun) | null,
        )
      ).run;
    } else {
      const prior = previous as (AdoptedKrRun & OctoberRun) | null;
      const priorInputs = prior ? await resolveKrInputArchive(prior, readArchive) : null;
      const daily = currentArchive!.inputs;
      const bars = Object.fromEntries(
        Object.entries(daily.bars).map(([symbol, rows]) => [symbol, [...rows]]),
      );
      for (const [symbol, rows] of Object.entries(priorInputs?.bars ?? {})) {
        for (const old of rows) {
          const overlap = input.dataset.bars[symbol]?.find(
            (row) => row.tradeDate === old.tradeDate,
          );
          if (overlap && canonicalSeriesJson(overlap) !== canonicalSeriesJson(old))
            throw new Error("KR source revises archived historical OHLC");
        }
        bars[symbol] = [...rows, ...(bars[symbol] ?? [])];
      }
      const result = (
        await stepAdoptedKrSeries(
          series,
          {
            date,
            codeHash: input.codeHash,
            configHash: series.configHash,
            sourceHash: input.sourceHash,
            availableAt: input.availableAt,
            decisionAt: input.decisionAt,
            confirmedClose: true,
            snapshots: [...(priorInputs?.snapshots ?? []), ...daily.snapshots],
            bars,
            markets: { ...(priorInputs?.markets ?? {}), ...daily.markets },
            marketGates: { ...(priorInputs?.marketGates ?? {}), ...daily.marketGates },
            calendar,
          },
          prior,
          priorInputs ?? undefined,
        )
      ).run;
      if (!currentArchiveRef) currentArchiveRef = await store.putKrInput(currentArchive!);
      const archive = {
        version: "kr-daily-inputs-v1" as const,
        days: [...(prior?.frozenInputArchive?.days ?? []), currentArchiveRef],
        prefixHash: await hashSeriesValue(result.frozenInputs),
      };
      if (prior && !prior.frozenInputArchive)
        throw new Error("KR compact publication requires archived predecessor inputs");
      stepped = {
        ...result,
        frozenInputs: { snapshots: [], bars: {}, markets: {}, marketGates: {} },
        frozenInputArchive: archive,
      } as AdoptedKrRun;
    }
    const { stateHash: ignored, ...body } = stepped;
    void ignored;
    const runBody = {
      ...body,
      publication: {
        version: "october-manual-publication-v1" as const,
        inputHash,
        sourceHash: input.sourceHash,
        availableAt: input.availableAt,
        decisionAt: input.decisionAt,
      },
    };
    const run = { ...runBody, stateHash: await hashSeriesValue(runBody) } as OctoberRun;
    prepared.push({ series, run, previous, reused: false });
  }
  // An immutable prepared decision is durable BEFORE the first database append. A next-day
  // retry completes this exact already-decided publication rather than backdating new intent.
  const body = {
    version: "october-prepared-publication-v1" as const,
    market: input.market,
    date,
    sourceHash: input.sourceHash,
    codeHash: input.codeHash,
    inputHash,
    preparedAt: input.decisionAt,
    entries: prepared.map((item) => ({
      series: item.series,
      run: item.run,
      previousDate: item.previous?.receipt.date ?? null,
      previousHash: item.previous?.stateHash ?? null,
    })),
  };
  const durablePrepared = await store.prepare({
    ...body,
    preparedHash: await hashSeriesValue(body),
  });
  return persistPreparedOctober(store, durablePrepared);
}
