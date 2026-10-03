import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";
import type { ScoringConfig } from "./engine/scoring";
import type { ActiveSourceRecord } from "./screeningSources.server";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import { hashSeriesValue, MODEL_ACCOUNTING_START, type SeriesHash } from "./ledger/modelSeries";
import { recordOctoberPublication } from "./ledger/octoberShadowPipeline";
import { octoberShadowStore } from "./ledger/octoberShadowRepository.server";
import manifest from "./ledger/octoberShadowEngineManifest.generated.json";

/** Called only after the parent server function verified getUser; no service secret is used. */
export async function recordWebOctoberShadow(input: {
  client: SupabaseClient;
  userId: string;
  dataset: MarketDataset;
  analysis: AnalysisResult;
  config: ScoringConfig;
  snapshot: ScreeningSnapshot;
  sources: ActiveSourceRecord[];
  decisionAt: string;
}) {
  const date = input.analysis.asOfDate;
  if (date < MODEL_ACCOUNTING_START) return { status: "WAITING_START", date, records: [] };
  const { data, error } = await input.client
    .from("screening_history")
    .select("snapshot")
    .eq("user_id", input.userId)
    .lt("date", date)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Shadow baseline universe read failed: ${error.message}`);
  const previous = (data?.snapshot as ScreeningSnapshot | undefined) ?? null;
  const sourceEvidence = input.sources.map((source) => ({
    sourceHash: source.data_hash as SeriesHash,
    asOfDate: source.max_date ?? "",
    registeredAt: source.activated_at ?? source.created_at,
  }));
  const availableAt =
    sourceEvidence
      .map((source) => source.registeredAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1) ?? "";
  const sourceHash: SeriesHash = `sha256:${createHash("sha256")
    .update(
      input.sources
        .map((source) => source.data_hash)
        .sort()
        .join("\n"),
    )
    .digest("hex")}`;
  return recordOctoberPublication(
    octoberShadowStore(input.client, input.userId, "authenticated-owner"),
    {
      market: "KR",
      dataset: input.dataset,
      analysis: input.analysis,
      snapshot: input.snapshot,
      config: input.config,
      codeHash: manifest.codeHash as SeriesHash,
      sourceHash,
      availableAt,
      decisionAt: input.decisionAt,
      confirmedRegularClose: sourceEvidence.some((source) => source.asOfDate === date),
      failedSymbols: previous
        ? previous.entries.filter(
            (entry) => !input.analysis.rows.some((row) => row.instrument.symbol === entry.symbol),
          ).length
        : -1,
      universeEvidence: {
        asOfDate: previous?.asOfDate ?? "",
        sourceHash: await hashSeriesValue(previous),
        symbols: [...new Set(previous?.entries.map((entry) => entry.symbol) ?? [])].sort(),
      },
      sourceEvidence,
    },
  );
}
