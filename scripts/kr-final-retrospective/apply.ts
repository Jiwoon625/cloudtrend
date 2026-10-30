/** Exact bounded MODEL-only writes. No collector, actual, integrated, source-registry or security writes. */
import { hashSeriesValue, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import {
  assertStoredOctoberRun,
  type OctoberRun,
} from "../../src/lib/ledger/octoberShadowPipeline";
import type { OctoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import { KOSPI_SHADOW_NAMESPACE, type ShadowObjectStore } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
import { verifyKrRetrospectiveAuthority } from "../../src/lib/ledger/krRetrospectivePublication";
import {
  applyPreparedKospiRetrospective,
  type ApplyKospiRetrospectiveInput,
} from "../kospi-final-retrospective-apply";
import { check, DATES, KINDS, PREDECESSOR, same, type FinalPlan } from "./core";

export interface FinalApproval {
  version: "kr-final-retrospective-approval-v1";
  status: "APPROVED";
  owner: string;
  planHash: SeriesHash;
  captureHash: SeriesHash;
  codeCommit: string;
  runtimeHashes: { october: SeriesHash; kospi: SeriesHash };
  retrospectiveRegistryHash: SeriesHash;
  legacyApprovalHash: SeriesHash;
  historicalAvailabilityClaim: false;
}
export async function finalApprovalCandidate(plan: FinalPlan): Promise<FinalApproval> {
  return {
    version: "kr-final-retrospective-approval-v1",
    status: "APPROVED",
    owner: plan.preparation.owner,
    planHash: await hashSeriesValue(plan),
    captureHash: plan.captureHash,
    codeCommit: plan.preparation.codeCommit,
    runtimeHashes: plan.preparation.runtimeHashes,
    retrospectiveRegistryHash: plan.retrospectiveAuthorityCandidate.authoritativeRegistryHash,
    legacyApprovalHash: plan.legacyApprovalHash,
    historicalAvailabilityClaim: false,
  };
}
export interface FinalApplyInput {
  phase: "VALIDATE" | "APPLY";
  plan: FinalPlan;
  approval: FinalApproval;
  /** Independently read authoritative private pins, never trust dispatch assertions alone. */
  authoritativePlanHash: SeriesHash;
  authoritativeApprovalHash: SeriesHash;
  admittedCodeCommit: string;
  admittedRuntimeHashes: FinalApproval["runtimeHashes"];
  owner: string;
  store: OctoberShadowStore;
  legacyStore: ShadowObjectStore;
  /** Full sources/generations,128model prefix,10series,allactual,artifact inventory and legacy prefix.
   * Permit ONLY exact planned append progress; reject any unrelated drift. Called before every write. */
  assertFresh(plan: FinalPlan): Promise<void>;
  assertExclusiveWriter: ApplyKospiRetrospectiveInput["assertExclusiveWriter"];
  /** Exact immutable source→plan→authority linkage. Implementation must read back after uncertain writes. */
  putProvenance(plan: FinalPlan, approval: FinalApproval): Promise<void>;
}

export async function applyFinalRetrospective(i: FinalApplyInput) {
  const p = i.plan,
    a = i.approval;
  check(
    (await hashSeriesValue(p)) === i.authoritativePlanHash &&
      (await hashSeriesValue(a)) === i.authoritativeApprovalHash &&
      same(a, await finalApprovalCandidate(p)),
    "AUTHORITATIVE_APPROVAL",
  );
  check(
    a.owner === i.owner &&
      a.codeCommit === i.admittedCodeCommit &&
      same(a.runtimeHashes, i.admittedRuntimeHashes),
    "ADMITTED_OWNER_RUNTIME",
  );
  check(
    p.version === "kr-final-retrospective-plan-v1" &&
      p.operationalApproval === false &&
      p.historicalAvailabilityClaim === false &&
      p.sourceRegistryMutation === false &&
      p.integratedMutation === false &&
      p.actualMutation === false &&
      p.expectedNewModelSessions === 10 &&
      p.expectedNewLegacySessions === 2,
    "PLAN_SCOPE",
  );
  check(
    same(p.preparation.scope, { predecessorDate: PREDECESSOR, dates: DATES, kinds: KINDS }) &&
      same(
        p.predecessors.map((x) => x.series.policy.kind),
        KINDS,
      ),
    "EXACT_DATES_KINDS",
  );
  check(
    (await hashSeriesValue(p.preparation)) === p.preparationHash &&
      p.captureHash === p.preparation.captureHash &&
      (await hashSeriesValue(p.legacyReceipt)) === p.legacyReceiptHash &&
      (await hashSeriesValue(p.legacyApprovalCandidate)) === p.legacyApprovalHash,
    "INNER_BINDING",
  );
  const retrospective = await verifyKrRetrospectiveAuthority(p.retrospectiveAuthorityCandidate);
  check(
    retrospective.receipt.preparationHash === p.preparationHash &&
      retrospective.receipt.capsuleHash === p.captureHash &&
      retrospective.receipt.owner === i.owner &&
      retrospective.registryHash === a.retrospectiveRegistryHash,
    "RETROSPECTIVE_BINDING",
  );
  check(
    same(
      p.preparedPublications.map((x) => x.date),
      DATES,
    ) &&
      same(
        p.newArchives.map((x) => x.date),
        DATES,
      ) &&
      p.newAdoptedSessions.length === 10,
    "OUTPUT_INVENTORY",
  );
  check(
    same(
      p.preparedPublications.flatMap((x) => x.entries.map((e) => e.run)),
      p.newAdoptedSessions,
    ),
    "OUTPUT_FLATTENING",
  );
  for (const pub of p.preparedPublications) {
    const { preparedHash, ...body } = pub;
    check(
      pub.market === "KR" &&
        (await hashSeriesValue(body)) === preparedHash &&
        same(
          pub.entries.map((e) => e.series.policy.kind),
          KINDS,
        ),
      "PREPARED_HASH_KINDS",
    );
    for (const e of pub.entries) {
      await assertStoredOctoberRun(e.series, e.run);
      check(
        e.run.receipt.date === pub.date &&
          e.run.publication.reviewedRetrospective?.registryHash === a.retrospectiveRegistryHash,
        "RUN_PROVENANCE",
      );
    }
  }
  const gate = async () => {
    await i.assertExclusiveWriter({
      owner: i.owner,
      namespace: `${i.owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`,
      requiredConcurrencyGroup: "kospi-prospective-shadow",
    });
    await i.assertFresh(p);
  };
  await gate();
  // Rehearse the legacy helper against fresh live reads in isolated memory BEFORE
  // any adopted-model mutation. The memory writer has no external capability.
  const legacyPaths = new Set(p.legacyReceipt.kospi.capturedObjects.map((x) => x.path));
  for (const item of p.legacyReceipt.kospi.result.plan.writeSet) legacyPaths.add(item.path);
  const legacyValues = new Map<string, unknown>();
  for (const path of legacyPaths) {
    const value = await i.legacyStore.read(path);
    if (value !== null) legacyValues.set(path, structuredClone(value));
  }
  const simulation: ShadowObjectStore = {
    read: async <T>(path: string) => structuredClone(legacyValues.get(path) ?? null) as T | null,
    latestSessionDate: async (root) =>
      [...legacyValues.keys()]
        .filter((path) => path.startsWith(root + "/"))
        .map((path) => path.slice(root.length + 1))
        .filter((path) => /^\d{4}-\d{2}-\d{2}\.json$/.test(path))
        .sort()
        .at(-1)
        ?.slice(0, -5) ?? null,
    putImmutable: async (path, value) => {
      check(
        !legacyValues.has(path) || same(legacyValues.get(path), value),
        "LEGACY_MEMORY_COLLISION",
      );
      legacyValues.set(path, structuredClone(value));
    },
    putLatest: async (path, value) => {
      legacyValues.set(path, structuredClone(value));
    },
  };
  await applyPreparedKospiRetrospective({
    store: simulation,
    preparationReceipt: p.legacyReceipt,
    approval: p.legacyApprovalCandidate,
    authoritativePreparationHash: p.legacyReceiptHash,
    authoritativeApprovalHash: p.legacyApprovalHash,
    approvedRuntimeCodeHash: i.admittedRuntimeHashes.kospi,
    assertExclusiveWriter: i.assertExclusiveWriter,
  });
  // Validate full existing or exact partial target prefix, not merely latest hash.
  for (const x of p.predecessors) {
    check(
      (await hashSeriesValue(x.run)) === x.payloadHash &&
        same(await i.store.readSeries(x.series.bookId), x.series) &&
        same(await i.store.readSession(x.series.bookId, PREDECESSOR), x.run),
      "IMMUTABLE_PREDECESSOR",
    );
    let previous = x.run,
      missing = false;
    for (const pub of p.preparedPublications) {
      const expected = pub.entries.find((e) => e.series.bookId === x.series.bookId)!;
      check(
        expected.previousDate === previous.receipt.date &&
          expected.previousHash === previous.stateHash &&
          same(expected.series, x.series),
        "ORDERED_PREDECESSOR",
      );
      const saved = await i.store.readSession<OctoberRun>(x.series.bookId, pub.date);
      if (!saved) missing = true;
      else check(!missing && same(saved, expected.run), "PARTIAL_PREFIX");
      if (saved) previous = saved;
      else {
        // Continue checking plan linkage even when live target is absent.
        const next = p.preparedPublications
          .find((z) => z.date > pub.date)
          ?.entries.find((e) => e.series.bookId === x.series.bookId);
        if (next)
          check(
            next.previousHash === expected.run.stateHash && next.previousDate === pub.date,
            "PLANNED_CHAIN",
          );
        break;
      }
    }
    // No newer or orphan target admitted; assertFresh also binds the entire roster.
    const savedFirst = await i.store.readSession<OctoberRun>(x.series.bookId, DATES[0]!);
    const savedSecond = await i.store.readSession<OctoberRun>(x.series.bookId, DATES[1]!);
    check(
      !savedSecond ||
        (savedFirst &&
          same(
            savedSecond,
            p.preparedPublications[1]!.entries.find((e) => e.series.bookId === x.series.bookId)!
              .run,
          )),
      "NO_GAPPED_TARGET",
    );
    check(
      same(await i.store.readLatest(x.series.bookId), savedSecond ?? savedFirst ?? x.run),
      "LATEST_PREFIX",
    );
  }
  check(i.phase === "VALIDATE" || i.phase === "APPLY", "PHASE");
  if (i.phase === "VALIDATE") return { status: "VALIDATED", historicalAvailabilityClaim: false };
  await gate();
  await i.putProvenance(p, a);
  for (const archive of p.newArchives) {
    await gate();
    const r = await i.store.putKrInput(archive);
    check(
      r.date === archive.date &&
        r.hash === (await hashSeriesValue(archive)) &&
        same(await i.store.readKrInput(r.date, r.hash), archive),
      "ARCHIVE_READBACK",
    );
  }
  for (const pub of p.preparedPublications) {
    await gate();
    check(same(await i.store.prepare(pub), pub), "PREPARED_READBACK");
    for (const e of pub.entries) {
      await gate();
      const saved = await i.store.readSession<OctoberRun>(e.series.bookId, pub.date);
      if (saved) {
        check(same(saved, e.run), "REUSE_EXACT");
        continue;
      }
      const prev = await i.store.readSession<OctoberRun>(e.series.bookId, e.previousDate!);
      check(prev && prev.stateHash === e.previousHash, "LIVE_PREDECESSOR");
      // An error may mean commit succeeded: authoritative read once, never blind retry.
      let failure: unknown;
      try {
        await i.store.append(e.series, e.run, prev);
      } catch (error) {
        failure = error;
      }
      const after = await i.store.readSession<OctoberRun>(e.series.bookId, pub.date);
      if (!same(after, e.run)) {
        if (failure) throw failure;
        throw new Error("FINAL_RETROSPECTIVE_APPEND_READBACK");
      }
    }
  }
  await gate();
  const legacy = await applyPreparedKospiRetrospective({
    store: i.legacyStore,
    preparationReceipt: p.legacyReceipt,
    approval: p.legacyApprovalCandidate,
    authoritativePreparationHash: p.legacyReceiptHash,
    authoritativeApprovalHash: p.legacyApprovalHash,
    approvedRuntimeCodeHash: i.admittedRuntimeHashes.kospi,
    assertExclusiveWriter: async (scope) => {
      await i.assertExclusiveWriter(scope);
      await i.assertFresh(p);
    },
  });
  await gate();
  for (const pub of p.preparedPublications)
    for (const e of pub.entries)
      check(
        same(await i.store.readSession(e.series.bookId, pub.date), e.run),
        "FINAL_MODEL_READBACK",
      );
  return {
    status: "APPLIED",
    expectedNewModelSessions: 10,
    expectedNewLegacySessions: 2,
    historicalAvailabilityClaim: false,
    legacy,
  };
}
