import type { KrDailyInputArchive } from "./octoberShadowArchive";
import type { PreparedOctoberPublication } from "./octoberShadowPipeline";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hashSeriesValue,
  type SeriesHash,
  canonicalSeriesJson,
  verifyFrozenSeries,
  type FrozenModelSeries,
} from "./modelSeries";
import { appendFrozenModelRun } from "./modelRepository.server";
import type { ModelJournalRun } from "./modelJournal";

export interface OctoberShadowStore {
  readKrInput(date: string, hash: SeriesHash): Promise<KrDailyInputArchive>;
  putKrInput(input: KrDailyInputArchive): Promise<{ date: string; hash: SeriesHash }>;
  readPrepared(market: "KR" | "US", date: string): Promise<PreparedOctoberPublication | null>;
  prepare(prepared: PreparedOctoberPublication): Promise<PreparedOctoberPublication>;
  readSeries(bookId: string): Promise<FrozenModelSeries | null>;
  insertSeries(series: FrozenModelSeries): Promise<void>;
  readLatest<T extends ModelJournalRun>(bookId: string): Promise<T | null>;
  readSession<T extends ModelJournalRun>(bookId: string, date: string): Promise<T | null>;
  append<T extends ModelJournalRun>(
    series: FrozenModelSeries,
    run: T,
    previous: T | null,
  ): Promise<{ reused: boolean; stateHash: string }>;
}

/** Uses only existing owner-filtered tables and the existing service-only append RPC. */
export function octoberShadowStore(
  client: SupabaseClient,
  userId: string,
  mode: "service" | "authenticated-owner" = "service",
): OctoberShadowStore {
  if (!/^[a-f\d-]{36}$/i.test(userId)) throw new Error("Verified model owner required");
  const inputId = (date: string, hash: SeriesHash) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^sha256:[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid KR input reference");
    return `october-input:KR:${date}:${hash.slice(7)}`;
  };
  const preparedId = (market: "KR" | "US", date: string) => {
    if (!["KR", "US"].includes(market) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error("Invalid prepared model identity");
    return `october-prepared:${market}:${date}`;
  };
  async function readArtifact(sourceId: string) {
    const { data, error } = await client
      .from("ledger_provenance_archive")
      .select("payload,source_hash")
      .eq("user_id", userId)
      .eq("source_id", sourceId)
      .eq("source_revision", "1")
      .maybeSingle();
    if (error) throw new Error(`Model artifact read failed: ${error.message}`);
    if (!data) return null;
    if ((await hashSeriesValue(data.payload)) !== data.source_hash)
      throw new Error("Model artifact content digest mismatch");
    return data.payload;
  }
  async function stageArtifact(
    kind: "KR_DAILY_INPUT" | "PREPARED_PUBLICATION",
    value: KrDailyInputArchive | PreparedOctoberPublication,
    bookId: string,
  ) {
    const series = await store.readSeries(bookId);
    if (!series) throw new Error("Model artifacts require an initialized owner registry");
    const envelope = {
      book: "MODEL",
      bookId,
      contractHash: series.contractHash,
      publicationArtifact: { kind, hash: await hashSeriesValue(value), payload: value },
    };
    const args = { p_run: envelope, p_previous_date: null, p_previous_hash: null };
    const { data, error } =
      mode === "authenticated-owner"
        ? await client.rpc("ledger_append_own_october_model_session", args)
        : await client.rpc("ledger_append_model_session", {
            p_user_id: userId,
            p_series: series,
            ...args,
          });
    if (error || !data?.artifact)
      throw new Error(
        `Model artifact staging failed: ${error?.message ?? "missing acknowledgement"}`,
      );
    return data.artifact;
  }
  const store: OctoberShadowStore = {
    async readKrInput(date, hash) {
      const value = (await readArtifact(inputId(date, hash))) as KrDailyInputArchive | null;
      if (!value || value.date !== date || (await hashSeriesValue(value)) !== hash)
        throw new Error("Immutable KR input hash mismatch or unavailable");
      return value;
    },
    async putKrInput(value) {
      const hash = await hashSeriesValue(value);
      const saved = await stageArtifact(
        "KR_DAILY_INPUT",
        value,
        "adopted-shadow-2026-10-05-v1:KR_MIXED",
      );
      if (canonicalSeriesJson(saved) !== canonicalSeriesJson(value))
        throw new Error("Immutable KR archive acknowledgement mismatch");
      const readback = await store.readKrInput(value.date, hash);
      if (canonicalSeriesJson(readback) !== canonicalSeriesJson(value))
        throw new Error("Immutable KR archive readback failed");
      return { date: value.date, hash };
    },
    async readPrepared(market, date) {
      return (await readArtifact(preparedId(market, date))) as PreparedOctoberPublication | null;
    },
    async prepare(prepared) {
      const bookId = prepared.entries[0]?.series.bookId;
      if (!bookId) throw new Error("Prepared book set missing");
      await stageArtifact("PREPARED_PUBLICATION", prepared, bookId);
      const saved = await store.readPrepared(prepared.market, prepared.date);
      if (
        !saved ||
        saved.inputHash !== prepared.inputHash ||
        saved.codeHash !== prepared.codeHash ||
        saved.sourceHash !== prepared.sourceHash
      )
        throw new Error("Prepared model conflict/readback failure");
      return saved;
    },
    async readSeries(bookId) {
      const { data, error } = await client
        .from("ledger_model_series")
        .select("payload")
        .eq("user_id", userId)
        .eq("series_id", bookId)
        .maybeSingle();
      if (error) throw new Error(`Model registry read failed: ${error.message}`);
      const series = data?.payload as FrozenModelSeries | undefined;
      if (series) await verifyFrozenSeries(series);
      return series ?? null;
    },
    async insertSeries(series) {
      if (mode !== "service") throw new Error("Registry initialization remains service-only");
      await verifyFrozenSeries(series);
      const existing = await store.readSeries(series.bookId);
      if (existing) {
        if (canonicalSeriesJson(existing) !== canonicalSeriesJson(series))
          throw new Error("Frozen model registry mismatch");
        return;
      }
      const { error } = await client.from("ledger_model_series").insert({
        user_id: userId,
        series_id: series.bookId,
        strategy_id: series.policy.kind,
        role: ["US_A2", "US_B3", "KR_KOSPI_CONFIRM1_BEAR"].includes(series.policy.kind)
          ? "ALTERNATIVE_SHADOW"
          : "ADOPTED_SHADOW",
        scheduled_start: series.accountingStartDate,
        config_hash: series.configHash,
        payload: series,
      });
      // A simultaneous initializer is safe only when the entire contract matches exactly.
      const verified = await store.readSeries(series.bookId);
      if (!verified || canonicalSeriesJson(verified) !== canonicalSeriesJson(series))
        throw new Error(`Model initialization readback failed${error ? `: ${error.message}` : ""}`);
    },
    async readLatest<T extends ModelJournalRun>(bookId: string) {
      const { data, error } = await client
        .from("ledger_model_sessions")
        .select("payload")
        .eq("user_id", userId)
        .eq("series_id", bookId)
        .order("session_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Model head read failed: ${error.message}`);
      return (data?.payload as T | undefined) ?? null;
    },
    async readSession<T extends ModelJournalRun>(bookId: string, date: string) {
      const { data, error } = await client
        .from("ledger_model_sessions")
        .select("payload")
        .eq("user_id", userId)
        .eq("series_id", bookId)
        .eq("session_date", date)
        .maybeSingle();
      if (error) throw new Error(`Model session read failed: ${error.message}`);
      return (data?.payload as T | undefined) ?? null;
    },
    async append<T extends ModelJournalRun>(series: FrozenModelSeries, run: T, previous: T | null) {
      const acknowledged = await appendFrozenModelRun(client, userId, series, run, previous, mode);
      const verified = await store.readSession(series.bookId, run.receipt.date);
      if (!verified || canonicalSeriesJson(verified) !== canonicalSeriesJson(run))
        throw new Error("Model session readback mismatch");
      return acknowledged;
    },
  };
  return store;
}
