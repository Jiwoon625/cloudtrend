/** Authenticated runner only. New bounded path; existing collector/runtime remains untouched. */
import { trustedSupabaseClient } from "../analysis-run-store";
import { octoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import {
  KOSPI_SHADOW_NAMESPACE,
  type ShadowObjectStore,
  type KospiShadowView,
} from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
import { applyFinalRetrospective, type FinalApproval } from "./apply";
import { check, same, DATES, prepareFinalRetrospective, type FinalPlan } from "./core";
import {
  readEvidence,
  appendEvidence,
  assertCaptureFresh,
  validateRequest,
  type Connection,
} from "./transport";
import type { FinalCapture } from "./contracts";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";

import {
  assertFinalWorkflow,
  assertFinalExclusiveScope,
  finalExecutionPhase,
} from "./runtime-admission";

/** Exact intermediate projections, computed only from independently pinned predecessor/snapshots. */
export function legacyAllowedValues(p: FinalPlan) {
  const owner = p.preparation.owner;
  const revision = `${owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const latest = revision + "/latest.json";
  let view = structuredClone(
    p.legacyReceipt.kospi.capturedObjects.find((x) => x.path === latest)!.payload,
  ) as KospiShadowView;
  const expected: Record<string, unknown[]> = { [latest]: [view] };
  for (const snapshot of p.legacyReceipt.kospi.result.snapshots) {
    expected[`${revision}/sessions/${snapshot.source.date}.json`] = [snapshot];
    const trades = [...view.recentTrades, ...snapshot.trades];
    view = {
      schemaVersion: 1,
      registry: view.registry,
      latest: snapshot,
      history: [...view.history, snapshot.daily],
      recentTrades: trades.slice(-1000),
      tradeHistoryTruncated: view.tradeHistoryTruncated || trades.length > 1000,
    };
    expected[latest]!.push(view);
  }
  check(same(view, p.legacyReceipt.kospi.result.finalProjection), "LEGACY_PROJECTED_OUTPUT");
  return expected;
}
async function main() {
  assertFinalWorkflow();
  const o: Connection = {
    origin: process.env.SUPABASE_URL ?? "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: process.env.SUPABASE_USER_ID ?? "",
  };
  const phase = finalExecutionPhase();
  const planHash = process.env.EXPECTED_PLAN_HASH as SeriesHash;
  const approvalHash = process.env.EXPECTED_APPROVAL_HASH as SeriesHash;
  const p = (await readEvidence(o, "plan", planHash)) as FinalPlan;
  const a = (await readEvidence(o, "approval", approvalHash)) as FinalApproval;
  check(
    p.preparation.owner === o.owner && p.preparation.codeCommit === process.env.GITHUB_SHA,
    "PRIVATE_OWNER_CODE",
  );
  const capture = (await readEvidence(o, "capture", p.captureHash)) as FinalCapture;
  const requestHash = process.env.EXPECTED_REQUEST_HASH ?? "";
  check(
    (capture.captureManifest as { requestHash: string }).requestHash === requestHash,
    "REQUEST_CHAIN",
  );
  await validateRequest(
    await readEvidence(o, "request", requestHash),
    requestHash,
    o.owner,
    process.env.GITHUB_SHA!,
  );
  check(
    (await hashSeriesValue(capture)) === p.captureHash &&
      same(await prepareFinalRetrospective(capture), p),
    "DETERMINISTIC_PLAN_REPRODUCTION",
  );
  const client = trustedSupabaseClient();
  const model = octoberShadowStore(client, o.owner, "service");
  const root = `${o.owner}/${KOSPI_SHADOW_NAMESPACE}`;
  const revision = `${root}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const allowed = legacyAllowedValues(p);
  const reads = new Set([
    ...p.legacyReceipt.kospi.capturedObjects.map((x) => x.path),
    ...Object.keys(allowed),
  ]);
  const store: ShadowObjectStore = {
    read: async <T>(path: string) => {
      check(reads.has(path), "LEGACY_READ_SCOPE");
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .download(
          path,
          path.endsWith("/latest.json") ? { cacheNonce: crypto.randomUUID() } : undefined,
          path.endsWith("/latest.json") ? { cache: "no-store" } : undefined,
        );
      if (error) {
        if (String(error.statusCode) === "404" || error.message === "Object not found") return null;
        throw new Error("FINAL_LEGACY_READ_FAILED");
      }
      return JSON.parse(await data.text()) as T;
    },
    latestSessionDate: async (path) => {
      check(path === root + "/sessions" || path === revision + "/sessions", "LEGACY_LIST_SCOPE");
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .list(path, { limit: 1, sortBy: { column: "name", order: "desc" } });
      check(
        !error && (!data?.[0]?.name || /^\d{4}-\d{2}-\d{2}\.json$/.test(data[0].name)),
        "LEGACY_LATEST_NAME",
      );
      return data?.[0]?.name.slice(0, -5) ?? null;
    },
    putImmutable: async (path, value) => {
      assertFinalWorkflow();
      check(
        DATES.some((date) => path === `${revision}/sessions/${date}.json`) &&
          allowed[path]?.some((x) => same(x, value)),
        "LEGACY_APPEND_SCOPE",
      );
      try {
        await client.storage.from("cloudtrend-data").upload(path, canonicalSeriesJson(value), {
          upsert: false,
          contentType: "application/json",
        });
      } catch {
        /* exactly one authoritative readback below */
      }
      check(same(await store.read(path), value), "LEGACY_APPEND_READBACK");
    },
    putLatest: async (path, value) => {
      assertFinalWorkflow();
      check(
        path === revision + "/latest.json" && allowed[path]?.slice(1).some((x) => same(x, value)),
        "LEGACY_PROJECTION_SCOPE",
      );
      try {
        await client.storage.from("cloudtrend-data").upload(path, canonicalSeriesJson(value), {
          upsert: true,
          contentType: "application/json",
          cacheControl: "0",
        });
      } catch {
        /* authoritative readback, never retry */
      }
      check(same(await store.read(path), value), "LEGACY_PROJECTION_READBACK");
    },
  };
  const guard = {
    preservationBaseline: p.preparation.preservationBaseline,
    captureManifest: p.captureManifest,
  } as FinalCapture;
  const artifacts = [
    ...(await Promise.all(
      p.newArchives.map(async (payload) => {
        const hash = await hashSeriesValue(payload);
        return {
          source_id: `october-input:KR:${payload.date}:${hash.slice(7)}`,
          source_hash: hash,
          payload,
        };
      }),
    )),
    ...(await Promise.all(
      p.preparedPublications.map(async (payload) => ({
        source_id: `october-prepared:KR:${payload.date}`,
        source_hash: await hashSeriesValue(payload),
        payload,
      })),
    )),
  ];
  const input = {
    phase: "VALIDATE" as "VALIDATE" | "APPLY",
    plan: p,
    approval: a,
    authoritativePlanHash: planHash,
    authoritativeApprovalHash: approvalHash,
    admittedCodeCommit: process.env.GITHUB_SHA!,
    admittedRuntimeHashes: {
      october: octoberRuntime.codeHash as SeriesHash,
      kospi: kospiRuntime.codeHash as SeriesHash,
    },
    owner: o.owner,
    store: model,
    legacyStore: store,
    assertFresh: async () => {
      await assertCaptureFresh(o, guard, p.newAdoptedSessions, allowed, artifacts);
    },
    assertExclusiveWriter: async (scope: {
      owner: string;
      namespace: string;
      requiredConcurrencyGroup: string;
    }) => {
      assertFinalExclusiveScope(scope, o.owner);
    },
    putProvenance: async () => {
      await appendEvidence(o, "execution", {
        version: "kr-final-retrospective-execution-v1",
        owner: o.owner,
        planHash,
        approvalHash,
        captureHash: p.captureHash,
        requestHash,
        preparationHash: p.preparationHash,
        retrospectiveRegistryHash: a.retrospectiveRegistryHash,
        legacyApprovalHash: p.legacyApprovalHash,
        historicalAvailabilityClaim: false,
      });
    },
  };
  const validation = await applyFinalRetrospective(input);
  if (phase === "VALIDATE") return { ...validation, planHash, noOperationalWrites: true };
  input.phase = "APPLY";
  const result = await applyFinalRetrospective(input);
  const completion = {
    version: "kr-final-retrospective-completion-v1",
    owner: o.owner,
    planHash,
    approvalHash,
    completedAt: new Date().toISOString(),
    result,
    historicalAvailabilityClaim: false,
  };
  const saved = await appendEvidence(o, "completion", completion);
  return {
    status: result.status,
    planHash,
    completionHash: saved.hash,
    expectedNewModelSessions: 10,
    expectedNewLegacySessions: 2,
    historicalAvailabilityClaim: false,
  };
}
main()
  .then((x) => console.log(JSON.stringify(x)))
  .catch((error) => {
    console.error(
      JSON.stringify({
        status: "FINAL_RETROSPECTIVE_REJECTED_OR_PARTIAL_CHECK_STATE",
        code:
          error instanceof Error
            ? error.message.replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180)
            : "UNKNOWN",
        completionClaim: false,
      }),
    );
    process.exitCode = 1;
  });
