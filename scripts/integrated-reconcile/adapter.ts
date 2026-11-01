import type { HistoricalLineageProof } from "./core";
import {
  validateHistoricalKrLineage,
  type HistoricalIntegratedRow,
  type HistoricalLineageInput,
} from "./historical-lineage";
import type { IntegratedKrEvidence } from "../../src/lib/integratedAllocationReplayAdapter";
import { replayReadBridge } from "./replay-read-bridge";
import { checkpointScope, type CheckpointScope } from "./checkpoint-scope";
import { generationCachedLoader, type GenerationProbe } from "./generation-cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadFreshObject } from "../../src/lib/freshStorage";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  RESTART_SERIES_VERSION,
  type AdoptedSeriesKind,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import { octoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import {
  assertStoredOctoberRun,
  type OctoberRun,
} from "../../src/lib/ledger/octoberShadowPipeline";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularOpenAt,
  regularCloseAt,
} from "../../src/lib/ledger/octoberShadowCalendar";
import {
  readIntegratedAllocationBook,
  integratedAllocationCodeHash,
  integratedAllocationRuntimeAdmission,
} from "../../src/lib/integratedAllocationStore.server";
import { replayIntegratedAllocationAvailable } from "../../src/lib/integratedAllocationReplay.server";
import { recordIntegratedRuntimeAttempt } from "../../src/lib/integratedAllocationRuntimeAudit.server";
import {
  INTEGRATED_ALLOCATION_OUTBOX_VERSION,
  type IntegratedAllocationOutboxPayload,
} from "../../src/lib/integratedAllocationRecovery.server";
import { INTEGRATED_ALLOCATION_VERSION } from "../../src/lib/integratedAllocationShadow";
import { US_PROSPECTIVE_RULE_VERSION } from "../../src/lib/engine/usProspective";

type Market = "KR" | "US";
const KINDS: Record<Market, AdoptedSeriesKind[]> = {
  KR: ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"],
  US: ["US_A0", "US_A2", "US_B3"],
};
const HASH = /^sha256:[a-f0-9]{64}$/;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const finiteOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Integrated reconciliation: ${message}`);
}
export interface ReconcileSnapshot {
  heads: { O1: string | null; S07: string | null };
  models: Record<string, { complete: boolean; sourceHash: string | null }>;
  evidence: Record<
    string,
    {
      status: "STORED" | "OUTBOX" | "MISSING";
      hash: string | null;
      sourceHash: string | null;
      decisionAt: string | null;
      historicalLineage?: HistoricalLineageProof;
    }
  >;
  fingerprint: string;
}

/** Read-only inspection; mutations are confined to explicitly called restore/replay methods. */
export async function buildReconcilePort(
  client: SupabaseClient,
  uid: string,
  now: string,
  throughDate: string,
  options: {
    freshGeneration?: (path: string) => Promise<GenerationProbe>;
    useVerifiedCheckpoint?: boolean;
  } = {},
) {
  demand(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid), "verified owner required");
  demand(timestamp(now), "explicit current time required");
  const calendars = {
    KR: await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
    US: await octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
  };
  // Validates the caller's horizon without deriving it from current/raw market data.
  await octoberModelCalendar("KR", throughDate);
  demand(throughDate >= "2026-10-12", "pre-start horizon");
  const dates = [...new Set([...calendars.KR.regularSessions, ...calendars.US.regularSessions])]
    .filter((date) => date >= "2026-10-12" && date <= throughDate)
    .sort();
  const due = (date: string): Market[] => {
    demand(dates.includes(date), "date outside inspected horizon");
    return (["KR", "US"] as const).filter((market) =>
      calendars[market].regularSessions.includes(date),
    );
  };
  const path = (market: Market, date: string) => {
    demand(due(date).includes(market), "non-session evidence identity");
    return `${uid}/staging/integrated-allocation-inputs/v1/${market}/${date}.json`;
  };
  let scope: CheckpointScope | null = null;
  let initialBooks: {
    O1: Awaited<ReturnType<typeof readIntegratedAllocationBook>>;
    S07: Awaited<ReturnType<typeof readIntegratedAllocationBook>>;
  } | null = null;
  const initialGenerations: Record<string, GenerationProbe> = {};
  const isStrong = (g: GenerationProbe) =>
    g?.kind === "strong" &&
    [g.objectId, g.version, g.etag].every((v) => typeof v === "string" && v.trim().length > 0) &&
    Number.isSafeInteger(g.size) &&
    g.size > 0;
  if (options.useVerifiedCheckpoint) {
    demand(options.freshGeneration, "checkpoint requires fresh generation transport");
    initialBooks = {
      O1: await readIntegratedAllocationBook(client, uid, "O1"),
      S07: await readIntegratedAllocationBook(client, uid, "S07"),
    };
    const candidate = checkpointScope({
      books: initialBooks,
      calendars: { KR: calendars.KR.regularSessions, US: calendars.US.regularSessions },
      throughDate,
    });
    if (candidate) {
      let complete = true;
      const store = octoberShadowStore(client, uid, "service");
      for (const market of ["KR", "US"] as const)
        for (const kind of KINDS[market]) {
          const bookId = `${RESTART_SERIES_VERSION}:${kind}`,
            series = await store.readSeries(bookId);
          demand(
            series &&
              series.bookId === bookId &&
              series.policy.kind === kind &&
              series.policy.market === market,
            "checkpoint registry mismatch",
          );
          const expected = dates.filter((d) => due(d).includes(market));
          let index = 0;
          for (let offset = 0; ; offset += 100) {
            const { data, error } = await client
              .from("ledger_model_sessions")
              .select("series_id,session_date,previous_session_date,state_hash")
              .eq("user_id", uid)
              .eq("series_id", bookId)
              .gte("session_date", "2026-10-12")
              .lte("session_date", throughDate)
              .order("session_date", { ascending: true })
              .range(offset, offset + 99);
            demand(!error && Array.isArray(data), "checkpoint metadata query failed");
            for (const row of data) {
              if (
                row.series_id !== bookId ||
                row.session_date !== expected[index] ||
                row.previous_session_date !== (expected[index - 1] ?? null) ||
                !HASH.test(row.state_hash)
              )
                complete = false;
              index++;
            }
            if (data.length < 100) break;
          }
          if (index !== expected.length) complete = false;
        }
      if (complete) {
        for (const date of dates)
          for (const market of due(date)) {
            const key = `${market}:${date}`,
              g = await options.freshGeneration!(path(market, date));
            if (!isStrong(g)) complete = false;
            initialGenerations[key] = g;
          }
        if (complete) scope = candidate;
      }
    }
  }
  const portDates = scope ? [...scope.pendingDates] : dates;
  async function validatePayload(
    value: unknown,
    market: Market,
    date: string,
  ): Promise<IntegratedAllocationOutboxPayload> {
    demand(object(value), "evidence object required");
    const payload = value as unknown as IntegratedAllocationOutboxPayload;
    const clock = payload.clock;
    demand(
      object(clock) &&
        clock.codeHash === integratedAllocationCodeHash &&
        HASH.test(clock.sourceHash),
      "evidence clock provenance",
    );
    demand(
      timestamp(clock.availableAt) &&
        timestamp(clock.decisionAt) &&
        Date.parse(clock.availableAt) <= Date.parse(clock.decisionAt),
      "evidence time ordering",
    );
    demand(
      clock.openAt === regularOpenAt(market, date) &&
        clock.closeAt === regularCloseAt(market, date),
      "exchange hours differ",
    );
    demand(
      object(clock.calendar) &&
        clock.calendar.sourceHash === calendars[market].sourceHash &&
        canonicalSeriesJson(clock.calendar.sessions) ===
          canonicalSeriesJson(calendars[market].regularSessions),
      "evidence calendar differs",
    );
    if (market === "KR") {
      demand(
        payload.version === "integrated-kr-daily-evidence-v1" && payload.date === date,
        "KR evidence identity",
      );
      demand(
        Array.isArray(payload.instruments) &&
          Array.isArray(payload.rows) &&
          object(payload.bars) &&
          object(payload.snapshot) &&
          payload.snapshot.asOfDate === date &&
          Array.isArray(payload.snapshot.entries) &&
          typeof payload.etfBatchPending === "boolean" &&
          (payload.priorGate === null || object(payload.priorGate)),
        "KR evidence structure",
      );
      const symbols = new Set<string>();
      for (const instrument of payload.instruments) {
        demand(
          object(instrument) &&
            typeof instrument.symbol === "string" &&
            instrument.symbol.length > 0 &&
            typeof instrument.market === "string" &&
            typeof instrument.instrumentType === "string" &&
            !symbols.has(instrument.symbol),
          "invalid/duplicate KR instrument",
        );
        symbols.add(instrument.symbol);
      }
      const rows = new Set<string>();
      for (const row of payload.rows) {
        demand(
          object(row) &&
            object(row.instrument) &&
            typeof row.instrument.symbol === "string" &&
            symbols.has(row.instrument.symbol) &&
            !rows.has(row.instrument.symbol) &&
            finiteOrNull(row.operatingScore10) &&
            object(row.priority) &&
            typeof row.priority.points === "number" &&
            Number.isFinite(row.priority.points),
          "invalid KR analysis row",
        );
        rows.add(row.instrument.symbol);
      }
      for (const [symbol, bar] of Object.entries(payload.bars)) {
        demand(
          symbol.length > 0 &&
            object(bar) &&
            bar.tradeDate === date &&
            finiteOrNull(bar.open) &&
            finiteOrNull(bar.close) &&
            finiteOrNull(bar.volume) &&
            typeof bar.openObserved === "boolean" &&
            typeof bar.volumeObserved === "boolean",
          "invalid KR daily bar",
        );
      }
    } else {
      demand(
        payload.version === "integrated-us-daily-evidence-v1" &&
          object(payload.analysis) &&
          payload.analysis.date === date &&
          payload.analysis.ruleVersion === US_PROSPECTIVE_RULE_VERSION &&
          Array.isArray(payload.analysis.rows) &&
          object(payload.analysis.state) &&
          object(payload.analysis.summary),
        "US evidence structure",
      );
      const symbols = new Set<string>();
      for (const row of payload.analysis.rows) {
        demand(
          object(row) &&
            row.date === date &&
            typeof row.symbol === "string" &&
            row.symbol.length > 0 &&
            !symbols.has(row.symbol) &&
            finiteOrNull(row.open) &&
            finiteOrNull(row.close) &&
            finiteOrNull(row.volume),
          "invalid/duplicate US row",
        );
        symbols.add(row.symbol);
      }
    }
    // Canonicalization rejects NaN, undefined, exotic objects and non-JSON values recursively.
    await hashSeriesValue(payload);
    return payload;
  }
  async function storedFresh(market: Market, date: string) {
    const { data, error } = await downloadFreshObject(
      client,
      "cloudtrend-data",
      path(market, date),
    );
    if (error) {
      if (String(error.statusCode) === "404" || /not found/i.test(error.message)) return null;
      throw new Error("Integrated reconciliation storage read failed");
    }
    if (!data) return null;
    const envelope: unknown = JSON.parse(await data.text());
    demand(
      object(envelope) && typeof envelope.hash === "string" && HASH.test(envelope.hash),
      "invalid stored envelope",
    );
    const payload = await validatePayload(envelope.payload, market, date);
    demand((await hashSeriesValue(payload)) === envelope.hash, "stored evidence hash mismatch");
    return { payload, hash: envelope.hash as SeriesHash };
  }
  // Cache lifetime is this port only. Each hit requires a new uncached generation probe.
  // Without an explicitly supplied freshness-guaranteed transport, keep full fresh reads.
  const validatedInputs = new Map<string, () => ReturnType<typeof storedFresh>>();
  async function stored(market: Market, date: string) {
    if (!options.freshGeneration) return storedFresh(market, date);
    const objectPath = path(market, date);
    let read = validatedInputs.get(objectPath);
    if (!read) {
      read = generationCachedLoader({
        probe: () => options.freshGeneration!(objectPath),
        loadValidated: () => storedFresh(market, date),
      });
      validatedInputs.set(objectPath, read);
    }
    return read();
  }
  async function outbox(market: Market, date: string) {
    let selected: { payload: IntegratedAllocationOutboxPayload; hash: SeriesHash } | null = null;
    // Explicit pagination: the existing single-query convenience reader does not prove completeness.
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await client
        .from("shadow_replay_audit")
        .select("id,details")
        .eq("user_id", uid)
        .eq("market", market)
        .eq("signal_date", date)
        .eq("strategy_version", INTEGRATED_ALLOCATION_VERSION)
        .contains("details", {
          integratedAllocationOutbox: { version: INTEGRATED_ALLOCATION_OUTBOX_VERSION },
        })
        .order("id", { ascending: true })
        .range(offset, offset + 99);
      demand(!error && Array.isArray(data), "outbox query failed");
      for (const row of data) {
        const box = row.details?.integratedAllocationOutbox;
        demand(
          object(box) &&
            box.version === INTEGRATED_ALLOCATION_OUTBOX_VERSION &&
            box.market === market &&
            box.date === date &&
            typeof box.hash === "string" &&
            HASH.test(box.hash),
          "invalid outbox identity",
        );
        const payload = await validatePayload(box.payload, market, date);
        demand((await hashSeriesValue(payload)) === box.hash, "outbox hash mismatch");
        demand(!selected || selected.hash === box.hash, "conflicting outbox versions");
        selected = { payload, hash: box.hash as SeriesHash };
      }
      if (data.length < 100) break;
    }
    return selected;
  }
  let historicalChains: HistoricalLineageInput["chains"] | null = null;
  const historicalProofCache = new Map<
    string,
    Awaited<ReturnType<typeof validateHistoricalKrLineage>>
  >();
  async function historicalProof(
    date: string,
    selected: { hash: SeriesHash; payload: IntegratedAllocationOutboxPayload },
    models: HistoricalLineageInput["models"],
    history: IntegratedKrEvidence[],
  ) {
    demand(
      options.freshGeneration &&
        initialBooks?.O1.head &&
        initialBooks.S07.head &&
        date <= initialBooks.O1.head.receipt.date &&
        date <= initialBooks.S07.head.receipt.date &&
        selected.payload.version === "integrated-kr-daily-evidence-v1",
      "evidence/market source mismatch outside verified historical checkpoint",
    );
    const checkpoints = initialBooks as {
      O1: NonNullable<typeof initialBooks>["O1"];
      S07: NonNullable<typeof initialBooks>["S07"];
    };
    for (const kind of ["O1", "S07"] as const) {
      const head = checkpoints[kind].head!;
      const { data, error } = await client
        .from("ledger_model_sessions")
        .select("state_hash")
        .eq("user_id", uid)
        .eq("series_id", head.bookId)
        .eq("session_date", head.receipt.date)
        .maybeSingle();
      demand(!error && data?.state_hash === head.stateHash, "historical checkpoint changed");
    }
    const generation = await options.freshGeneration(path("KR", date));
    demand(isStrong(generation), "historical lineage requires fresh strong staging generation");
    const audits: HistoricalLineageInput["audits"] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await client
        .from("shadow_replay_audit")
        .select("id,user_id,market,signal_date,details")
        .eq("user_id", uid)
        .eq("market", "KR")
        .eq("signal_date", date)
        .eq("strategy_version", INTEGRATED_ALLOCATION_VERSION)
        .contains("details", { integratedRuntimeAttempt: { kind: "EVIDENCE_PREPARED" } })
        .order("id", { ascending: true })
        .range(offset, offset + 99);
      demand(!error && Array.isArray(data), "historical prepared audit query failed");
      audits.push(...data);
      if (data.length < 100) break;
    }
    if (!historicalChains) {
      const chains = {} as HistoricalLineageInput["chains"];
      for (const kind of ["O1", "S07"] as const) {
        const head = checkpoints[kind].head!,
          rows: HistoricalIntegratedRow[] = [];
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await client
            .from("ledger_model_sessions")
            .select("series_id,session_date,previous_session_date,state_hash,payload")
            .eq("user_id", uid)
            .eq("series_id", head.bookId)
            .gte("session_date", "2026-10-12")
            .lte("session_date", head.receipt.date)
            .order("session_date", { ascending: true })
            .range(offset, offset + 99);
          demand(!error && Array.isArray(data), "historical integrated chain query failed");
          rows.push(...(data as HistoricalIntegratedRow[]));
          if (data.length < 100) break;
        }
        chains[kind] = { checkpointHash: head.stateHash, rows };
      }
      historicalChains = chains;
    }
    const cacheKey = await hashSeriesValue({
      date,
      stageHash: selected.hash,
      history,
      models: models.map(({ series, run }) => ({
        bookId: series.bookId,
        contractHash: series.contractHash,
        stateHash: run.stateHash,
      })),
      checkpointHashes: [checkpoints.O1.head!.stateHash, checkpoints.S07.head!.stateHash],
      generation,
      audits,
    });
    let proof = historicalProofCache.get(cacheKey);
    if (!proof) {
      proof = await validateHistoricalKrLineage({
        uid,
        date,
        stage: { hash: selected.hash, payload: selected.payload },
        history: [...history],
        models,
        chains: historicalChains,
        audits,
      });
      historicalProofCache.set(cacheKey, proof);
    }
    return proof;
  }
  let approvedReadHashes = new Map<string, string>();
  async function inspect(): Promise<ReconcileSnapshot> {
    approvedReadHashes = new Map();
    const inspectedReadHashes = new Map<string, string>();
    const store = octoberShadowStore(client, uid, "service");
    const books = {
      O1: await readIntegratedAllocationBook(client, uid, "O1"),
      S07: await readIntegratedAllocationBook(client, uid, "S07"),
    };
    demand(books.O1.registry && books.S07.registry, "integrated registries missing");
    const checkpointGenerations: Record<string, GenerationProbe> = {};
    if (scope) {
      for (const kind of ["O1", "S07"] as const) {
        const original = initialBooks![kind].head!;
        const { data, error } = await client
          .from("ledger_model_sessions")
          .select("state_hash")
          .eq("user_id", uid)
          .eq("series_id", original.bookId)
          .eq("session_date", original.receipt.date)
          .maybeSingle();
        demand(
          !error && data?.state_hash === scope.checkpointHashes[kind],
          "checkpoint scope invalidated: original checkpoint changed; full inspection required next run",
        );
      }
      for (const date of dates)
        for (const market of due(date)) {
          const key = `${market}:${date}`,
            g = await options.freshGeneration!(path(market, date));
          demand(
            isStrong(g) && canonicalSeriesJson(g) === canonicalSeriesJson(initialGenerations[key]),
            "checkpoint scope invalidated: storage generation changed; full inspection required next run",
          );
          checkpointGenerations[key] = g;
        }
    }

    const models: ReconcileSnapshot["models"] = {},
      evidence: ReconcileSnapshot["evidence"] = {};
    const modelProof: Array<{
      bookId: string;
      contractHash: string;
      runs: Array<[string, string]>;
    }> = [];
    const perDay = new Map<
      string,
      Array<{
        hash: string;
        sourceHash: string;
        series: NonNullable<
          Awaited<ReturnType<ReturnType<typeof octoberShadowStore>["readSeries"]>>
        >;
        run: OctoberRun;
      }>
    >();
    const krHistory: IntegratedKrEvidence[] = [];
    const historicalLineageProofs: Array<Awaited<ReturnType<typeof validateHistoricalKrLineage>>> =
      [];
    for (const market of ["KR", "US"] as const) {
      for (const kind of KINDS[market]) {
        const bookId = `${RESTART_SERIES_VERSION}:${kind}`;
        const series = await store.readSeries(bookId);
        demand(
          series &&
            series.bookId === bookId &&
            series.policy.kind === kind &&
            series.policy.market === market,
          "market registry missing/mismatched",
        );
        const proof = {
          bookId,
          contractHash: series.contractHash as string,
          runs: [] as Array<[string, string]>,
        };
        let previous: OctoberRun | null = null;
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await client
            .from("ledger_model_sessions")
            .select("series_id,session_date,previous_session_date,state_hash,payload")
            .eq("user_id", uid)
            .eq("series_id", bookId)
            .gte("session_date", "2026-10-12")
            .lte("session_date", throughDate)
            .order("session_date", { ascending: true })
            .range(offset, offset + 99);
          demand(!error && Array.isArray(data), "market session query failed");
          for (const row of data) {
            const run = row.payload as OctoberRun;
            await assertStoredOctoberRun(series, run);
            demand(
              row.series_id === bookId &&
                row.session_date === run.receipt.date &&
                row.state_hash === run.stateHash &&
                dates.includes(row.session_date) &&
                due(row.session_date).includes(market) &&
                run.calendar.market === market &&
                run.calendar.regularSessions.includes(row.session_date),
              "market row identity mismatch",
            );
            const predecessor =
              calendars[market].regularSessions
                .filter((d) => d >= "2026-10-12" && d < row.session_date)
                .at(-1) ?? null;
            demand(
              row.previous_session_date === predecessor &&
                (previous?.receipt.date ?? null) === predecessor &&
                run.previousStateHash === (previous?.stateHash ?? null),
              "market sequence broken",
            );
            demand(
              run.publication?.version === "october-manual-publication-v1" &&
                HASH.test(run.publication.sourceHash) &&
                HASH.test(run.publication.inputHash) &&
                timestamp(run.publication.availableAt) &&
                timestamp(run.publication.decisionAt) &&
                Date.parse(run.publication.availableAt) <= Date.parse(run.publication.decisionAt) &&
                Date.parse(run.publication.decisionAt) <= Date.parse(now),
              "invalid market publication proof",
            );
            const key = `${market}:${row.session_date}`;
            const runs = perDay.get(key) ?? [];
            runs.push({ hash: run.stateHash, sourceHash: run.publication.sourceHash, series, run });
            perDay.set(key, runs);
            proof.runs.push([row.session_date, run.stateHash]);
            previous = run;
          }
          if (data.length < 100) break;
        }
        modelProof.push(proof);
      }
    }
    for (const date of dates)
      for (const market of due(date)) {
        const key = `${market}:${date}`,
          runs = perDay.get(key) ?? [];
        const hashes = [...new Set(runs.map((run) => run.sourceHash))];
        demand(hashes.length <= 1, "market publications have conflicting source provenance");
        models[key] = {
          complete: runs.length === KINDS[market].length,
          sourceHash: hashes[0] ?? null,
        };
        if (scope) {
          demand(
            models[key].complete,
            "checkpoint scope invalidated: historical model grid incomplete; full inspection required next run",
          );
          if (market === "US" && scope.metadataOnlyUsDates.includes(date)) continue;
        }
        const saved = await stored(market, date),
          retry = await outbox(market, date);
        demand(!saved || !retry || saved.hash === retry.hash, "stored/outbox conflict");
        if (scope)
          demand(
            saved,
            "checkpoint scope invalidated: required staging missing; full inspection required next run",
          );
        if (saved) inspectedReadHashes.set(key, saved.hash);
        const selected = saved ?? retry;
        if (scope && selected)
          demand(
            Date.parse(selected.payload.clock.decisionAt) <= Date.parse(now),
            "checkpoint dependency decision is not yet final",
          );
        let historicalLineage: HistoricalLineageProof | undefined;
        if (
          selected &&
          models[key].complete &&
          selected.payload.clock.sourceHash !== models[key].sourceHash
        ) {
          demand(market === "KR" && saved, "evidence/market source mismatch");
          const proof = await historicalProof(
            date,
            selected,
            runs.map(({ series, run }) => ({ series, run })),
            krHistory,
          );
          historicalLineageProofs.push(proof);
          historicalLineage = {
            proofHash: proof.proofHash,
            date,
            checkpointThrough: [
              initialBooks!.O1.head!.receipt.date,
              initialBooks!.S07.head!.receipt.date,
            ].sort()[0],
            stageHash: proof.stageHash,
            stageSourceHash: proof.sourceHash,
            modelSourceHash: models[key].sourceHash!,
          };
        }
        if (selected?.payload.version === "integrated-kr-daily-evidence-v1")
          krHistory.push(selected.payload);
        evidence[key] = {
          status: saved ? "STORED" : retry ? "OUTBOX" : "MISSING",
          hash: selected?.hash ?? null,
          sourceHash: selected?.payload.clock.sourceHash ?? null,
          decisionAt: selected?.payload.clock.decisionAt ?? null,
          ...(historicalLineage ? { historicalLineage } : {}),
        };
      }
    const heads = {
      O1: books.O1.head?.receipt.date ?? null,
      S07: books.S07.head?.receipt.date ?? null,
    };
    demand(
      Object.values(heads).every((date) => date === null || date <= throughDate),
      "horizon behind integrated head",
    );
    const fingerprint = await hashSeriesValue({
      heads,
      modelProof,
      evidence,
      integrated: [books.O1.head?.stateHash ?? null, books.S07.head?.stateHash ?? null],
      historicalLineageProofs,
      checkpoint: scope
        ? { hashes: scope.checkpointHashes, generations: checkpointGenerations }
        : null,
    });
    const pendingEvidence = scope
      ? Object.fromEntries(
          Object.entries(evidence).filter(([key]) => portDates.includes(key.slice(3))),
        )
      : evidence;
    approvedReadHashes = inspectedReadHashes;
    return { heads, models, evidence: pendingEvidence, fingerprint };
  }
  async function restore(market: Market, date: string, expectedHash: string) {
    demand(HASH.test(expectedHash), "restore hash required");
    const retry = await outbox(market, date);
    demand(retry && retry.hash === expectedHash, "exact outbox unavailable");
    const saved = await stored(market, date);
    if (saved) {
      demand(saved.hash === expectedHash, "restore existing conflict");
      return;
    }
    demand(
      Date.parse(retry.payload.clock.decisionAt) <= Date.parse(now),
      "future outbox restoration",
    );
    await recordIntegratedRuntimeAttempt(client, uid, {
      admission: integratedAllocationRuntimeAdmission,
      kind: "EVIDENCE_RESTORED",
      market,
      date,
      subjectHash: retry.hash,
      sourceHash: retry.payload.clock.sourceHash,
    });
    const bytes = JSON.stringify({ hash: retry.hash, payload: retry.payload });
    const { error } = await client.storage
      .from("cloudtrend-data")
      .upload(path(market, date), new Blob([bytes]), {
        upsert: false,
        contentType: "application/json",
        cacheControl: "0",
      });
    // A failed response can have committed. Read back once; never blindly retry an upload.
    const checked = await stored(market, date);
    demand(
      checked?.hash === expectedHash,
      error ? "uncertain restore not verified" : "restore readback mismatch",
    );
  }
  return {
    verificationScope: {
      mode: scope ? "VERIFIED_CHECKPOINT_DEPENDENCIES" : "FULL_DATED_PAYLOADS",
      olderUsPresenceOnlyDates: scope?.metadataOnlyUsDates ?? [],
      allHistoricalModelPublicationChainsVerified: true,
      archivedUsPayloadAndOutboxConflictsRevalidated: !scope,
    },
    dates: portDates,
    due,
    inspect,
    restore,
    replay: (date: string) => {
      demand(dates.includes(date), "replay outside inspected horizon");
      const phaseApprovedReadHashes = new Map(approvedReadHashes);
      const replayClient = options.freshGeneration
        ? replayReadBridge(client, uid, async (market, day) => {
            const expected = phaseApprovedReadHashes.get(`${market}:${day}`);
            demand(expected, "unplanned replay input; complete inspection required");
            const checked = await stored(market, day);
            demand(checked && checked.hash === expected, "replay input changed after inspection");
            return new Blob([JSON.stringify({ hash: checked.hash, payload: checked.payload })]);
          })
        : client;
      return replayIntegratedAllocationAvailable(replayClient, uid, date, now, "service");
    },
  };
}
