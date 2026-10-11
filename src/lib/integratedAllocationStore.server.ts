import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalSeriesJson, hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";
import {
  createIntegratedAllocationShadow,
  verifyIntegratedAllocationLedger,
  INTEGRATED_ALLOCATION_VERSION,
  type AllocationShadowKind,
} from "./integratedAllocationShadow";
import {
  integratedRegistry,
  prepareIntegratedInitialization,
  type IntegratedDailyPublication,
  type IntegratedRegistry,
} from "./integratedAllocationPublication";
import runtime from "./integratedAllocationRuntime.generated.json";
export const integratedAllocationCodeHash = runtime.codeHash as SeriesHash;
const bookId = (kind: AllocationShadowKind) => `${INTEGRATED_ALLOCATION_VERSION}:${kind}`;
function owner(uid: string) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw new Error("Verified owner required");
}
export async function readIntegratedAllocationBook(
  client: SupabaseClient,
  uid: string,
  kind: AllocationShadowKind,
) {
  owner(uid);
  const id = bookId(kind);
  const { data: registryRow, error: registryError } = await client
    .from("ledger_model_series")
    .select("payload")
    .eq("user_id", uid)
    .eq("series_id", id)
    .maybeSingle();
  if (registryError) throw new Error("통합 Shadow 계약 조회 실패");
  if (!registryRow)
    return { kind, status: "NOT_INITIALIZED" as const, registry: null, head: null, ledger: null };
  const registry = registryRow.payload as IntegratedRegistry;
  const expected = await integratedRegistry(kind, integratedAllocationCodeHash);
  if (canonicalSeriesJson(registry) !== canonicalSeriesJson(expected))
    throw new Error("통합 Shadow 계약·실행 버전 대조 필요");
  const { data: rows, error } = await client
    .from("ledger_model_sessions")
    .select("payload")
    .eq("user_id", uid)
    .eq("series_id", id)
    .order("session_date", { ascending: false })
    .limit(1);
  if (error) throw new Error("통합 Shadow 세션 조회 실패");
  const head = (rows?.[0]?.payload ?? null) as IntegratedDailyPublication | null;
  if (head) {
    const { stateHash, canonicalPayload, ...body } = head;
    if (
      head.bookId !== id ||
      canonicalSeriesJson(head.registry) !== canonicalSeriesJson(registry) ||
      canonicalPayload !== canonicalSeriesJson(body) ||
      stateHash !== (await hashSeriesValue(body))
    )
      throw new Error("통합 Shadow 저장 결과 무결성 오류");
    await verifyIntegratedAllocationLedger(head.result);
    const { stateHash: innerHash, ...inner } = head.result;
    if (
      head.resultCanonicalPayload !== canonicalSeriesJson(inner) ||
      innerHash !== (await hashSeriesValue(inner))
    )
      throw new Error("통합 Shadow 내부 상태 대사 실패");
  }
  const ledger =
    head?.result ?? (await createIntegratedAllocationShadow(kind, { codeHash: registry.codeHash }));
  return {
    kind,
    status: head ? ("RECORDED" as const) : ("INITIALIZED_WAITING" as const),
    registry,
    head,
    ledger,
  };
}
export async function initializeIntegratedAllocationBook(
  client: SupabaseClient,
  uid: string,
  kind: AllocationShadowKind,
) {
  owner(uid);
  const existing = await readIntegratedAllocationBook(client, uid, kind);
  if (existing.registry) return existing;
  const envelope = await prepareIntegratedInitialization(kind, integratedAllocationCodeHash);
  const { data, error } = await client.rpc("ledger_append_own_october_model_session", {
    p_run: envelope,
    p_previous_date: null,
    p_previous_hash: null,
  });
  if (error || !data?.initialized) throw new Error("통합 Shadow 초기화 결과 확인 필요");
  const saved = await readIntegratedAllocationBook(client, uid, kind);
  if (!saved.registry) throw new Error("통합 Shadow 초기화 재조회 실패");
  return saved;
}
export async function appendIntegratedAllocationPublication(
  client: SupabaseClient,
  uid: string,
  publication: IntegratedDailyPublication,
  previous: IntegratedDailyPublication | null,
  mode: "service" | "authenticated-owner" = "authenticated-owner",
) {
  owner(uid);
  const args = {
    p_run: publication,
    p_previous_date: previous?.receipt.date ?? null,
    p_previous_hash: previous?.stateHash ?? null,
  };
  const { data, error } =
    mode === "service"
      ? await client.rpc("ledger_append_model_session", {
          p_user_id: uid,
          p_series: publication.registry,
          ...args,
        })
      : await client.rpc("ledger_append_own_october_model_session", args);
  if (error || data?.stateHash !== publication.stateHash)
    throw new Error("통합 Shadow 기록 결과 확인 필요");
  const saved = await readIntegratedAllocationBook(client, uid, publication.registry.policy.kind);
  const { data: day, error: dayError } = await client
    .from("ledger_model_sessions")
    .select("payload")
    .eq("user_id", uid)
    .eq("series_id", publication.bookId)
    .eq("session_date", publication.receipt.date)
    .maybeSingle();
  if (dayError || !day || canonicalSeriesJson(day.payload) !== canonicalSeriesJson(publication))
    throw new Error("통합 Shadow 기록 대사 실패");
  return { reused: data.reused === true, book: saved };
}
