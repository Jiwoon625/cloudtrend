import { validDate } from "../src/lib/ledger/date";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shadowEngineManifest } from "./october-shadow-code-manifest";
import { octoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import {
  recordOctoberPublication,
  assertStoredOctoberRun,
  type OctoberPublication,
  type KrModelPublication,
  type UsModelPublication,
} from "../src/lib/ledger/octoberShadowPipeline";
import {
  ADOPTED_SERIES_VERSION,
  MODEL_ACCOUNTING_START,
  type SeriesHash,
} from "../src/lib/ledger/modelSeries";

export async function publishOctoberShadow(
  client: SupabaseClient,
  userId: string,
  input: Omit<KrModelPublication, "codeHash"> | Omit<UsModelPublication, "codeHash">,
) {
  const date = input.market === "US" ? input.analysis.date : input.analysis.asOfDate;
  if (date < MODEL_ACCOUNTING_START) return { status: "WAITING_START", date, records: [] };
  const { codeHash } = await shadowEngineManifest();
  return recordOctoberPublication(octoberShadowStore(client, userId), {
    ...input,
    codeHash,
  } as OctoberPublication);
}

/** Early reuse needs all new books, not just the old screening completion marker. */
export async function octoberShadowAlreadyRecorded(
  client: SupabaseClient,
  userId: string,
  market: "KR" | "US",
  date: string,
  sourceHash: string,
) {
  if (!validDate(date)) return false;
  if (date < MODEL_ACCOUNTING_START) return true;
  const store = octoberShadowStore(client, userId),
    { codeHash } = await shadowEngineManifest();
  const kinds =
    market === "US"
      ? ["US_A0", "US_A2", "US_B3"]
      : ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
  for (const kind of kinds) {
    const id = `${ADOPTED_SERIES_VERSION}:${kind}`;
    const registry = await store.readSeries(id);
    if (!registry || registry.codeHash !== codeHash)
      throw new Error(`Missing or changed October registry: ${kind}`);
    const run = await store.readSession<
      import("../src/lib/ledger/octoberShadowPipeline").OctoberRun
    >(id, date);
    if (!run) return false;
    await assertStoredOctoberRun(registry, run);
    if (run.receipt.date !== date) throw new Error("October saved session date mismatch");
    if (run.publication?.sourceHash !== sourceHash || run.receipt.codeHash !== codeHash)
      throw new Error(`Immutable October source/engine conflict: ${kind}`);
  }
  return true;
}
export const sourceSeriesHash = (hash: string): SeriesHash => {
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("Source SHA-256 required");
  return hash as SeriesHash;
};
