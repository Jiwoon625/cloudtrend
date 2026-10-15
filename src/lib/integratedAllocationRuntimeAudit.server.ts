import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalSeriesJson, type SeriesHash } from "./ledger/modelSeries";
import { INTEGRATED_ALLOCATION_VERSION } from "./integratedAllocationShadow";
import {
  reviewedIntegratedRuntime,
  type IntegratedRuntimeAdmission,
} from "./integratedAllocationRuntimeAdmission";

export const INTEGRATED_RUNTIME_ATTEMPT_VERSION = "integrated-allocation-runtime-attempt-v1";
type Attempt = {
  admission: Readonly<IntegratedRuntimeAdmission>;
  kind:
    "INITIALIZATION_ATTEMPT" | "PUBLICATION_ATTEMPT" | "EVIDENCE_PREPARED" | "EVIDENCE_RESTORED";
  date: string;
  subjectHash: SeriesHash;
  sourceHash: SeriesHash;
  market?: "KR" | "US";
  bookId?: string;
  previousStateHash?: SeriesHash | null;
};
/** Write-ahead provenance, not an assertion of economic publication success.
 * Exact intent is read back before publication/storage. Retrying an uncertain write
 * reads first; no update/delete or immutable economic-payload mutation is possible.
 */
export async function recordIntegratedRuntimeAttempt(
  client: SupabaseClient,
  uid: string,
  input: Attempt,
) {
  const review = reviewedIntegratedRuntime(
    input.admission.runtimeCodeHash,
    input.admission.frozenCodeHash,
  );
  if (
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid) ||
    canonicalSeriesJson(review) !== canonicalSeriesJson(input.admission) ||
    ![
      "INITIALIZATION_ATTEMPT",
      "PUBLICATION_ATTEMPT",
      "EVIDENCE_PREPARED",
      "EVIDENCE_RESTORED",
    ].includes(input.kind) ||
    input.date < "2026-10-12" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    !Number.isFinite(Date.parse(`${input.date}T00:00:00Z`)) ||
    new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date ||
    ![
      input.subjectHash,
      input.sourceHash,
      ...(input.previousStateHash ? [input.previousStateHash] : []),
    ].every((hash) => /^sha256:[a-f\d]{64}$/.test(hash)) ||
    (input.kind === "EVIDENCE_PREPARED" || input.kind === "EVIDENCE_RESTORED"
      ? !input.market || input.bookId !== undefined || input.previousStateHash !== undefined
      : input.market !== undefined ||
        ![`${INTEGRATED_ALLOCATION_VERSION}:O1`, `${INTEGRATED_ALLOCATION_VERSION}:S07`].includes(
          input.bookId ?? "",
        ) ||
        input.previousStateHash === undefined)
  )
    throw new Error("Invalid integrated runtime provenance intent");
  const market = input.market ?? "KR";
  const { admission: _admission, date: _date, market: _market, ...subject } = input;
  const attempt = { version: INTEGRATED_RUNTIME_ATTEMPT_VERSION, ...review, ...subject };
  const read = async () => {
    const { data, error } = await client
      .from("shadow_replay_audit")
      .select("details,source_hash")
      .eq("user_id", uid)
      .eq("market", market)
      .eq("signal_date", input.date)
      .eq("strategy_version", INTEGRATED_ALLOCATION_VERSION)
      .contains("details", {
        integratedRuntimeAttempt: {
          version: INTEGRATED_RUNTIME_ATTEMPT_VERSION,
          kind: input.kind,
          subjectHash: input.subjectHash,
          runtimeCodeHash: review.runtimeCodeHash,
        },
      });
    if (error) throw new Error("Integrated runtime provenance read failed");
    for (const row of data ?? []) {
      if (
        row.source_hash !== input.sourceHash ||
        canonicalSeriesJson(row.details?.integratedRuntimeAttempt) !== canonicalSeriesJson(attempt)
      )
        throw new Error("Integrated runtime provenance conflict");
    }
    return Boolean(data?.length);
  };
  if (await read()) return { reused: true };
  await client.from("shadow_replay_audit").insert({
    user_id: uid,
    market,
    signal_date: input.date,
    calculated_at: new Date().toISOString(),
    source_captured_at: null,
    model_available_at: null,
    model_decision_at: null,
    execution_at: null,
    replay_mode: "RETROSPECTIVE",
    status: "WAITING_INPUT",
    source_hash: input.sourceHash,
    strategy_version: INTEGRATED_ALLOCATION_VERSION,
    reason: "Runtime provenance intent only; economic publication outcome is not asserted",
    details: { integratedRuntimeAttempt: attempt },
  });
  if (!(await read())) throw new Error("Integrated runtime provenance write could not be verified");
  return { reused: false };
}
