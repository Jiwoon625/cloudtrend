import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsProspectiveAnalysis } from "./engine/usProspective";
import type {
  AllocationAdapterClock,
  IntegratedKrEvidence,
} from "./integratedAllocationReplayAdapter";
import { integratedAllocationCodeHash } from "./integratedAllocationStore.server";
import { INTEGRATED_ALLOCATION_VERSION } from "./integratedAllocationShadow";
import { hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";
import { regularOpenAt } from "./ledger/octoberShadowCalendar";

/** Only an already prepared day's evidence; never a source-data reload or second analysis. */
export type IntegratedAllocationOutboxPayload =
  | IntegratedKrEvidence
  | {
      version: "integrated-us-daily-evidence-v1";
      analysis: UsProspectiveAnalysis;
      clock: AllocationAdapterClock;
    };

export const INTEGRATED_ALLOCATION_OUTBOX_VERSION = "integrated-allocation-input-outbox-v1";
interface Outbox {
  version: typeof INTEGRATED_ALLOCATION_OUTBOX_VERSION;
  market: "KR" | "US";
  date: string;
  hash: SeriesHash;
  payload: IntegratedAllocationOutboxPayload;
}
function identity(uid: string, market: string, date: string) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw new Error("Verified allocation outbox owner required");
  if (
    !["KR", "US"].includes(market) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    date < "2026-10-12"
  )
    throw new Error("Invalid allocation outbox market/date");
}
async function verify(outbox: Outbox, market: "KR" | "US", date: string) {
  const payload = outbox?.payload;
  const actualDate =
    payload?.version === "integrated-kr-daily-evidence-v1"
      ? payload.date
      : payload?.version === "integrated-us-daily-evidence-v1"
        ? payload.analysis?.date
        : null;
  const clock = payload?.clock;
  if (
    outbox?.version !== INTEGRATED_ALLOCATION_OUTBOX_VERSION ||
    outbox.market !== market ||
    outbox.date !== date ||
    actualDate !== date ||
    (market === "KR") !== (payload?.version === "integrated-kr-daily-evidence-v1") ||
    !clock ||
    clock.codeHash !== integratedAllocationCodeHash ||
    !/^sha256:[a-f\d]{64}$/.test(clock.sourceHash) ||
    !clock.calendar?.sessions.includes(date) ||
    !Number.isFinite(Date.parse(clock.availableAt)) ||
    !Number.isFinite(Date.parse(clock.decisionAt)) ||
    Date.parse(clock.availableAt) > Date.parse(clock.decisionAt) ||
    outbox.hash !== (await hashSeriesValue(payload))
  )
    throw new Error("통합 배분 복구 입력의 날짜·해시·실행 버전 대조 실패");
  return payload;
}

/** Read only this owner's append-only retry records. Conflicting versions never win by recency. */
export async function readIntegratedAllocationOutbox(
  client: SupabaseClient,
  uid: string,
  market: "KR" | "US",
  date: string,
): Promise<IntegratedAllocationOutboxPayload | null> {
  identity(uid, market, date);
  const { data, error } = await client
    .from("shadow_replay_audit")
    .select("details")
    .eq("user_id", uid)
    .eq("market", market)
    .eq("signal_date", date)
    .eq("strategy_version", INTEGRATED_ALLOCATION_VERSION)
    .contains("details", {
      integratedAllocationOutbox: { version: INTEGRATED_ALLOCATION_OUTBOX_VERSION },
    });
  if (error) throw new Error("통합 배분 복구 대기 입력 조회 실패");
  let selected: Outbox | null = null;
  for (const row of data ?? []) {
    const outbox = row.details?.integratedAllocationOutbox as Outbox;
    await verify(outbox, market, date);
    if (selected && selected.hash !== outbox.hash)
      throw new Error("통합 배분 동일 날짜의 복구 입력 충돌");
    selected = outbox;
  }
  return selected?.payload ?? null;
}

/**
 * Called only after immutable storage failed, and before the legacy success audit.
 * Uses existing owner-only SELECT/INSERT; no table, permission, frozen run or trade changes.
 */
export async function storeIntegratedAllocationOutbox(
  client: SupabaseClient,
  uid: string,
  input: {
    market: "KR" | "US";
    date: string;
    payload: IntegratedAllocationOutboxPayload;
    calculatedAt?: string;
    replayMode?: "CONTEMPORANEOUS" | "RETROSPECTIVE";
  },
): Promise<{ reused: boolean; hash: SeriesHash }> {
  identity(uid, input.market, input.date);
  const outbox: Outbox = {
    version: INTEGRATED_ALLOCATION_OUTBOX_VERSION,
    market: input.market,
    date: input.date,
    hash: await hashSeriesValue(input.payload),
    payload: input.payload,
  };
  await verify(outbox, input.market, input.date);
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(calculatedAt)) ||
    Date.parse(calculatedAt) < Date.parse(input.payload.clock.decisionAt)
  )
    throw new Error("통합 배분 판단 시각 전의 복구 입력은 보관할 수 없습니다");
  const old = await readIntegratedAllocationOutbox(client, uid, input.market, input.date);
  if (old) {
    if ((await hashSeriesValue(old)) !== outbox.hash)
      throw new Error("통합 배분 동일 날짜의 복구 입력 충돌");
    return { reused: true, hash: outbox.hash };
  }
  const next = input.payload.clock.calendar.sessions.find((date) => date > input.date);
  const executionAt = next ? regularOpenAt(input.market, next) : null;
  const { error } = await client.from("shadow_replay_audit").insert({
    user_id: uid,
    market: input.market,
    signal_date: input.date,
    calculated_at: calculatedAt,
    source_captured_at: null,
    model_available_at: input.payload.clock.availableAt,
    model_decision_at: input.payload.clock.decisionAt,
    execution_at: executionAt,
    replay_mode:
      input.replayMode ??
      (executionAt && Date.parse(calculatedAt) <= Date.parse(executionAt)
        ? "CONTEMPORANEOUS"
        : "RETROSPECTIVE"),
    status: "WAITING_INPUT",
    source_hash: input.payload.clock.sourceHash,
    strategy_version: INTEGRATED_ALLOCATION_VERSION,
    reason: "통합 배분 입력 저장 재시도 대기",
    details: { integratedAllocationOutbox: outbox },
  });
  // An uncertain insert response may have committed. Verify without blindly appending again.
  const saved = await readIntegratedAllocationOutbox(client, uid, input.market, input.date);
  if (!saved || (await hashSeriesValue(saved)) !== outbox.hash)
    throw new Error(`통합 배분 복구 입력 보관 확인 실패${error ? " · 재조회 필요" : ""}`);
  return { reused: false, hash: outbox.hash };
}
