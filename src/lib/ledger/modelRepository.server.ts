import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertModelSeriesIsolation,
  guardModelRun,
  hashSeriesValue,
  verifyFrozenSeries,
  type FrozenModelSeries,
} from "./modelSeries";
import type { ModelJournalRun } from "./modelJournal";
/** Single PostgreSQL transaction serializes all dates of one model series across all workers. */
export async function appendFrozenModelRun<T extends ModelJournalRun>(
  client: SupabaseClient,
  userId: string,
  series: FrozenModelSeries,
  run: T,
  previous: T | null,
) {
  if (!/^[a-f\d-]{36}$/i.test(userId)) throw new Error("Verified model owner required");
  await verifyFrozenSeries(series);
  assertModelSeriesIsolation(series, run);
  if (run.receipt.book !== "MODEL") throw new Error("Model receipt required");
  await guardModelRun(series, run.receipt, run.receipt);
  const { stateHash, ...body } = run;
  if (
    (await hashSeriesValue(body)) !== stateHash ||
    run.previousStateHash !== (previous?.stateHash ?? null)
  )
    throw new Error("Model state/predecessor integrity mismatch");
  if (previous) {
    assertModelSeriesIsolation(series, previous);
    const { stateHash: previousHash, ...previousBody } = previous;
    if ((await hashSeriesValue(previousBody)) !== previousHash)
      throw new Error("Previous model state changed");
  }
  const { data, error } = await client.rpc("ledger_append_model_session", {
    p_user_id: userId,
    p_series: series,
    p_run: run,
    p_previous_date: previous?.receipt.date ?? null,
    p_previous_hash: previous?.stateHash ?? null,
  });
  if (error) throw new Error(`Frozen model append failed: ${error.message}`);
  if (!data || typeof data.reused !== "boolean" || data.stateHash !== run.stateHash)
    throw new Error("Model persistence acknowledgement mismatch");
  return data as { reused: boolean; stateHash: string };
}
