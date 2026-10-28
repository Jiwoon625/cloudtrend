/* eslint-disable @typescript-eslint/no-explicit-any */
/** Only the exact externally approved plan is admitted; never a collector or an ordinary FINAL path. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashSeriesValue, canonicalSeriesJson } from "../../src/lib/ledger/modelSeries";
import { octoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import {
  readIntegratedAllocationBook,
  appendIntegratedAllocationPublication,
} from "../../src/lib/integratedAllocationStore.server";
import { verifyKrSourceVintagePrivateApproval } from "../../src/lib/ledger/krSourceVintage";
import { readKrSourceVintageApproval } from "../../src/lib/krSourceVintageApproval.server";
import type { ShadowObjectStore } from "../../src/lib/kospiShadowStore";
import { applyPreparedKospiRetrospective } from "../kospi-final-retrospective-apply";
import { requireCheck } from "../kr-vintage-preflight/transport";
import { PREPARATION } from "./transport";
import { applyApprovedModelPlan } from "./apply-model-plan";
import { registerReviewedHistory, historyRegistrationIdentity } from "./register-history";
import {
  operationReader,
  assertActualState,
  assertModelInventory,
  assertCurrentSources,
  type OperationConnection,
} from "./operation-transport";
import {
  OPERATION_MANIFEST,
  FULL_PLAN,
  APPLY_APPROVAL,
  EXECUTION_PROVENANCE,
  same,
  validateOperationManifest,
  verifyFullRecoveryPlan,
} from "./operation-schema";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import integratedRuntime from "../../src/lib/integratedAllocationRuntime.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const runtimes = {
  october: octoberRuntime.codeHash,
  integrated: integratedRuntime.codeHash,
  kospi: kospiRuntime.codeHash,
};
export function assertRecoveryWorkflow(env: NodeJS.ProcessEnv = process.env) {
  requireCheck(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW === "KR adjusted recovery reviewed PLAN APPLY" &&
      env.RECOVERY_CONCURRENCY_GROUP === "kospi-prospective-shadow" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
  );
}
async function immutableEvidence(
  client: SupabaseClient,
  uid: string,
  prefix: string,
  hash: string,
  payload: unknown,
) {
  requireCheck(prefix === EXECUTION_PROVENANCE || prefix === "kr-adjusted-recovery-model-stage:");
  const id = prefix + hash.slice(7);
  const read = async () => {
    const { data, error } = await client
      .from("ledger_provenance_archive")
      .select("source_hash,payload")
      .eq("user_id", uid)
      .eq("source_id", id)
      .eq("source_revision", "1")
      .limit(2);
    requireCheck(!error && data && data.length <= 1);
    if (data[0]) requireCheck(data[0].source_hash === hash && same(data[0].payload, payload));
    return data?.[0]?.payload ?? null;
  };
  requireCheck((await hashSeriesValue(payload)) === hash);
  if (!(await read())) {
    try {
      await client
        .from("ledger_provenance_archive")
        .insert({ user_id: uid, source_id: id, source_revision: "1", source_hash: hash, payload });
    } catch {
      /* exact readback, no retry */
    }
    requireCheck(await read());
  }
  return read;
}
async function provisionVintage(client: SupabaseClient, uid: string, preparation: any, plan: any) {
  const v = plan.vintageAuthorityCandidate;
  for (const [key, value, id] of [
    ["krSourceVintageApproval", preparation.vintageV1.registry, "reviewed-kr-vintage-v1"],
    ["krSourceVintageReview", preparation.vintageV1.receipt, "reviewed-kr-vintage-v1"],
    ["krSourceVintageApproval", v.registry, "reviewed-kr-vintage-v2"],
    ["krSourceVintageReview", v.receipt, "reviewed-kr-vintage-v2"],
  ] as const) {
    const read = async () => {
      const { data, error } = await client
        .from("shadow_replay_audit")
        .select("details")
        .eq("user_id", uid)
        .eq("market", "KR")
        .eq("strategy_version", id)
        .contains("details", { [key]: { reviewId: id } });
      requireCheck(!error && data);
      for (const r of data) requireCheck(same(r.details?.[key], value));
      return data.length > 0;
    };
    if (await read()) continue;
    requireCheck(id === "reviewed-kr-vintage-v2");
    try {
      await client.from("shadow_replay_audit").insert({
        user_id: uid,
        market: "KR",
        signal_date: preparation.scope.dates[0],
        calculated_at: new Date().toISOString(),
        source_captured_at: preparation.captureObservedAt,
        model_available_at: null,
        model_decision_at: null,
        execution_at: null,
        replay_mode: "RETROSPECTIVE",
        status: "WAITING_INPUT",
        source_hash: await hashSeriesValue(value),
        strategy_version: id,
        reason:
          "Exact independently reviewed adjusted-source recovery authority; not an economic outcome",
        details: { [key]: value },
      });
    } catch {
      /* exact readback */
    }
    requireCheck(await read());
  }
  requireCheck(same(await readKrSourceVintageApproval(client, uid, preparation.scope.dates[0]), v));
}
function legacyStore(client: SupabaseClient, uid: string, preparation: any): ShadowObjectStore {
  const root = `${uid}/shadow/kospi-confirm1-bear-rsaccel-v1`,
    revision = root + "/revisions/october14-retrospective-v1";
  const reads = new Set(preparation.kospi.capturedObjects.map((x: any) => x.path));
  for (const d of preparation.scope.dates) reads.add(`${revision}/sessions/${d}.json`);
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => {
      requireCheck(reads.has(p));
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .download(p, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
      if (error) {
        if (String(error.statusCode) === "404" || error.message === "Object not found") return null;
        throw new Error("LEGACY_READ_REJECTED");
      }
      return JSON.parse(await data.text()) as T;
    },
    latestSessionDate: async (p: string) => {
      requireCheck(p === root + "/sessions" || p === revision + "/sessions");
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .list(p, { limit: 1, sortBy: { column: "name", order: "desc" } });
      requireCheck(!error);
      const n = data?.[0]?.name;
      requireCheck(!n || /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
      return n?.slice(0, -5) ?? null;
    },
    putImmutable: async (p, v) => {
      assertRecoveryWorkflow();
      requireCheck(
        preparation.scope.dates.some((d: string) => p === `${revision}/sessions/${d}.json`),
      );
      try {
        await client.storage
          .from("cloudtrend-data")
          .upload(p, canonicalSeriesJson(v), { upsert: false, contentType: "application/json" });
      } catch {
        /* helper performs exact readback */
      }
      requireCheck(same(await store.read(p), v));
    },
    putLatest: async (p, v) => {
      assertRecoveryWorkflow();
      requireCheck(p === revision + "/latest.json");
      try {
        await client.storage.from("cloudtrend-data").upload(p, canonicalSeriesJson(v), {
          upsert: true,
          contentType: "application/json",
          cacheControl: "0",
        });
      } catch {
        /* exact helper readback */
      }
      requireCheck(same(await store.read(p), v));
    },
  };
  return store;
}
export async function prepareLegacyValidationStore(
  liveLegacy: ShadowObjectStore,
  owner: string,
  preparation: any,
): Promise<ShadowObjectStore> {
  const cache = new Map<string, any>();
  for (const item of preparation.kospi.capturedObjects)
    cache.set(item.path, await liveLegacy.read(item.path));
  const revision = `${owner}/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1`;
  for (const date of preparation.scope.dates) {
    const target = `${revision}/sessions/${date}.json`;
    cache.set(target, await liveLegacy.read(target));
  }
  const dry: ShadowObjectStore = {
    read: async <T>(path: string) => structuredClone(cache.get(path) ?? null) as T | null,
    latestSessionDate: async (prefix) => {
      const actual = await liveLegacy.latestSessionDate(prefix);
      requireCheck(!actual || cache.get(`${prefix}/${actual}.json`));
      return (
        [...cache.entries()]
          .filter(
            ([p, v]) =>
              v &&
              p.startsWith(prefix + "/") &&
              /^\d{4}-\d{2}-\d{2}\.json$/.test(p.slice(prefix.length + 1)),
          )
          .map(([p]) => p.slice(-15, -5))
          .sort()
          .at(-1) ?? null
      );
    },
    putImmutable: async (path, value) => {
      requireCheck(!cache.get(path) || same(cache.get(path), value));
      cache.set(path, structuredClone(value));
    },
    putLatest: async (path, value) => {
      cache.set(path, structuredClone(value));
    },
  };

  return dry;
}

export async function applyOperation(
  o: OperationConnection & {
    client: SupabaseClient;
    manifestHash: string;
    planHash: string;
    approvalHash: string;
  },
) {
  assertRecoveryWorkflow();
  const r = operationReader(o),
    m = (await r.archive(OPERATION_MANIFEST, o.manifestHash, o.manifestHash)).payload;
  await validateOperationManifest(m, o.manifestHash, o.owner);
  requireCheck(same(m.runtimeHashes, runtimes) && m.codeCommit === process.env.GITHUB_SHA);
  const p = (await r.archive(PREPARATION, m.preparationReadPlanHash, m.preparationHash)).payload,
    plan = (await r.archive(FULL_PLAN, o.manifestHash, o.planHash)).payload,
    approval = (await r.archive(APPLY_APPROVAL, o.planHash, o.approvalHash)).payload;
  await verifyFullRecoveryPlan(plan, o.planHash, m, o.manifestHash);
  requireCheck(
    same(
      plan.integratedNextEvidence,
      p.candidate.evidence.find((e: any) => e.payload.date === p.scope.dates[1]),
    ) && plan.retainedIntegrated26EvidenceHash === p.integrated26.originalEvidenceHash,
  );
  requireCheck(
    approval.owner === o.owner &&
      approval.fullPlanHash === o.planHash &&
      approval.operationManifestHash === o.manifestHash &&
      approval.preparationHash === m.preparationHash &&
      same(approval.runtimeHashes, runtimes) &&
      approval.status === "APPROVED" &&
      approval.version === "kr-adjusted-recovery-apply-approval-v1",
  );
  requireCheck(
    approval.kospiApprovalHash === (await hashSeriesValue(plan.kospiApprovalCandidate)) &&
      approval.vintageAuthorityHash === (await hashSeriesValue(plan.vintageAuthorityCandidate)) &&
      approval.retrospectiveRegistryHash === plan.models.retrospectiveAuthorityCandidateHash &&
      approval.executionProvenanceHash === (await hashSeriesValue(plan.executionProvenance)) &&
      approval.historyCorrectionHash === (await hashSeriesValue(plan.historyCorrection)),
  );
  await verifyKrSourceVintagePrivateApproval(plan.vintageAuthorityCandidate);
  requireCheck(
    same(plan.vintageAuthorityCandidate.predecessor, {
      registry: p.vintageV1.registry,
      receipt: p.vintageV1.receipt,
    }) && same(plan.vintageAuthorityCandidate.receipt, p.vintageReviewProposal),
  );
  const own = await historyRegistrationIdentity(plan, o.planHash, o.approvalHash),
    newRuns = [...plan.models.newAdoptedSessions, ...plan.models.newIntegratedSessions],
    store = octoberShadowStore(o.client, o.owner);
  await assertActualState(o, m);
  let completed = false;
  try {
    await assertModelInventory(o, m, newRuns);
    await assertCurrentSources(o, m, own);
    for (const pin of p.archiveReferences)
      requireCheck(
        (await hashSeriesValue(await store.readKrInput(pin.date, pin.payloadHash))) ===
          pin.payloadHash,
      );
    // All target namespaces must be absent or exact reviewed partial artifacts before ANY authority/model write.
    const inventory = async () => {
      for (const date of p.scope.dates) {
        const { data, error } = await o.client
          .from("ledger_provenance_archive")
          .select("source_id,source_hash,payload")
          .eq("user_id", o.owner)
          .eq("source_revision", "1")
          .or(`source_id.eq.october-prepared:KR:${date},source_id.like.october-input:KR:${date}:%`);
        requireCheck(!error && data);
        const prepared = plan.models.preparedPublications.find((x: any) => x.date === date),
          archive = plan.models.newKrArchives.find((x: any) => x.date === date),
          archiveHash = await hashSeriesValue(archive);
        requireCheck(
          data.length <= 2 && new Set(data.map((x) => x.source_id)).size === data.length,
        );
        for (const row of data) {
          const isPrepared = row.source_id === `october-prepared:KR:${date}`;
          requireCheck(
            row.source_id ===
              (isPrepared
                ? `october-prepared:KR:${date}`
                : `october-input:KR:${date}:${archiveHash.slice(7)}`) &&
              same(row.payload, isPrepared ? prepared : archive) &&
              row.source_hash === (await hashSeriesValue(row.payload)),
          );
        }
      }
    };
    await inventory();
    const evidence = {
      readKr: async (date: string) => {
        requireCheck(p.scope.dates.includes(date));
        const { data, error } = await o.client.storage
          .from("cloudtrend-data")
          .download(`${o.owner}/staging/integrated-allocation-inputs/v1/KR/${date}.json`);
        if (error) {
          if (String(error.statusCode) === "404" || error.message === "Object not found")
            return null;
          throw new Error("KR_EVIDENCE_READ_REJECTED");
        }
        const v = JSON.parse(await data.text());
        requireCheck(v.hash === (await hashSeriesValue(v.payload)));
        return v;
      },
      putKrImmutable: async (date: string, payload: any, hash: any) => {
        requireCheck(
          date === p.scope.dates[1] &&
            hash === plan.integratedNextEvidence.hash &&
            same(payload, plan.integratedNextEvidence.payload),
        );
        const object = `${o.owner}/staging/integrated-allocation-inputs/v1/KR/${date}.json`;
        try {
          await o.client.storage
            .from("cloudtrend-data")
            .upload(object, canonicalSeriesJson({ hash, payload }), {
              upsert: false,
              contentType: "application/json",
            });
        } catch {
          /* exact readback in adapter */
        }
      },
    };
    const integrated = {
      read: async (kind: "O1" | "S07") => {
        const book = await readIntegratedAllocationBook(o.client, o.owner, kind);
        requireCheck(book.head);
        return book.head;
      },
      readSession: async (kind: "O1" | "S07", date: string) => {
        const rows = await r.rows("ledger_model_sessions", "payload", {
          series_id: `eq.integrated-allocation-shadow-2026-10-12-v1:${kind}`,
          session_date: "eq." + date,
        });
        requireCheck(rows.length <= 1);
        return rows[0]?.payload ?? null;
      },
      append: async (value: any, previous: any) => {
        await appendIntegratedAllocationPublication(o.client, o.owner, value, previous);
      },
    };
    const modelInput = {
      phase: "VALIDATE" as "VALIDATE" | "APPLY",
      plan,
      approval,
      authoritativePlanHash: o.planHash as any,
      authoritativeApprovalHash: o.approvalHash as any,
      runtimeHashes: runtimes as any,
      owner: o.owner,
      store,
      assertArtifactInventory: inventory,
      assertActualLedgersUnchanged: () => assertActualState(o, m),
      provenance: {
        putImmutable: async (payload: unknown, hash: `sha256:${string}`) => {
          await immutableEvidence(o.client, o.owner, EXECUTION_PROVENANCE, hash, payload);
        },
        read: async (hash: `sha256:${string}`) => {
          const rows = await r.rows("ledger_provenance_archive", "payload,source_hash", {
            source_id: "eq." + EXECUTION_PROVENANCE + hash.slice(7),
            source_revision: "eq.1",
          });
          requireCheck(rows.length === 1 && rows[0].source_hash === hash);
          return rows[0].payload;
        },
      },
      evidence,
      integrated,
    };
    await applyApprovedModelPlan(modelInput);
    const liveLegacy = legacyStore(o.client, o.owner, p);
    const dry = await prepareLegacyValidationStore(liveLegacy, o.owner, p);
    const legacyInput = {
      store: liveLegacy,
      preparationReceipt: p,
      approval: plan.kospiApprovalCandidate,
      authoritativePreparationHash: m.preparationHash,
      authoritativeApprovalHash: approval.kospiApprovalHash,
      approvedRuntimeCodeHash: runtimes.kospi,
      assertExclusiveWriter: async (scope: {
        owner: string;
        namespace: string;
        requiredConcurrencyGroup: "kospi-prospective-shadow";
      }) => {
        assertRecoveryWorkflow();
        requireCheck(
          scope.owner === o.owner && scope.requiredConcurrencyGroup === "kospi-prospective-shadow",
        );
      },
    };
    await applyPreparedKospiRetrospective({ ...legacyInput, store: dry });
    await registerReviewedHistory({
      ...o,
      manifest: m,
      plan,
      planHash: o.planHash,
      approvalHash: o.approvalHash,
      validateOnly: true,
    });
    // All subsystems admit the exact plan before the first authority/model mutation.
    await provisionVintage(o.client, o.owner, p, plan);
    await applyApprovedModelPlan({ ...modelInput, phase: "APPLY" });
    await applyPreparedKospiRetrospective(legacyInput);
    const historyStage = await registerReviewedHistory({
      ...o,
      manifest: m,
      plan,
      planHash: o.planHash,
      approvalHash: o.approvalHash,
    });
    await assertModelInventory(o, m, newRuns);
    for (const run of newRuns) {
      const row = await r.one("ledger_model_sessions", "payload", {
        series_id: "eq." + run.bookId,
        session_date: "eq." + run.receipt.date,
      });
      requireCheck(same(row.payload, run));
    }
    await assertActualState(o, m);
    completed = true;
    const outcome = {
      version: "kr-adjusted-recovery-model-stage-receipt-v1",
      fullRecoveryComplete: false,
      historyStage,
      fullPlanHash: o.planHash,
      approvalHash: o.approvalHash,
      operationManifestHash: o.manifestHash,
      expectedNewModelSessions: 12,
      originalModelInventoryHash: await hashSeriesValue(m.modelInventory),
      actualLedgersUnchanged: true,
      historicalAvailabilityClaim: false,
      legacyTargetDate: p.scope.dates[1],
      currentPhasePreserved: true,
    };
    const receiptHash = await hashSeriesValue(outcome);
    await immutableEvidence(
      o.client,
      o.owner,
      "kr-adjusted-recovery-model-stage:",
      receiptHash,
      outcome,
    );
    return {
      status: "MODELS_RESTORED_HISTORY_ACTIVATION_REQUIRES_INDEPENDENT_CAS",
      fullRecoveryComplete: false,
      receiptHash,
      newModelSessions: 12,
      actualLedgersUnchanged: true,
      historicalAvailabilityClaim: false,
    };
  } finally {
    // Even a partial failure must prove the actual books unchanged; never suppress this guard.
    await assertActualState(o, m);
    void completed;
  }
}
