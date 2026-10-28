/* eslint-disable @typescript-eslint/no-explicit-any */
/** Exact prepared MODEL-only continuation. Operational caller must resolve private authority first. */
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import {
  assertStoredOctoberRun,
  type OctoberRun,
  type PreparedOctoberPublication,
} from "../../src/lib/ledger/octoberShadowPipeline";
import type { OctoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import type { IntegratedDailyPublication } from "../../src/lib/integratedAllocationPublication";
import { verifyIntegratedAllocationLedger } from "../../src/lib/integratedAllocationShadow";
import { verifyKrRetrospectiveAuthority } from "../../src/lib/ledger/krRetrospectivePublication";
import { buildExecutionProvenance } from "./operation-schema";
import { requireCheck } from "../kr-vintage-preflight/transport";
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const kinds = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
export interface RecoveryApplyApproval {
  version: "kr-adjusted-recovery-apply-approval-v1";
  status: "APPROVED";
  owner: string;
  operationManifestHash: SeriesHash;
  preparationHash: SeriesHash;
  fullPlanHash: SeriesHash;
  runtimeHashes: { october: SeriesHash; integrated: SeriesHash; kospi: SeriesHash };
  retrospectiveRegistryHash: SeriesHash;
  vintageAuthorityHash: SeriesHash;
  executionProvenanceHash: SeriesHash;
  historyCorrectionHash: SeriesHash;
  kospiApprovalHash: SeriesHash;
}
export interface ExactModelApplyInput {
  phase: "VALIDATE" | "APPLY";
  plan: any;
  approval: RecoveryApplyApproval;
  authoritativePlanHash: SeriesHash;
  authoritativeApprovalHash: SeriesHash;
  runtimeHashes: RecoveryApplyApproval["runtimeHashes"];
  owner: string;
  store: OctoberShadowStore;
  /** Must reject every foreign/mismatched target archive/prepared object, including orphan artifacts. */
  assertArtifactInventory(plan: any): Promise<void>;
  assertActualLedgersUnchanged(): Promise<void>;
  provenance: {
    putImmutable(payload: unknown, hash: SeriesHash): Promise<void>;
    read(hash: SeriesHash): Promise<unknown>;
  };
  evidence: {
    readKr(date: string): Promise<{ hash: SeriesHash; payload: any } | null>;
    putKrImmutable(date: string, payload: any, hash: SeriesHash): Promise<void>;
  };
  integrated: {
    read(kind: "O1" | "S07"): Promise<IntegratedDailyPublication>;
    readSession(kind: "O1" | "S07", date: string): Promise<IntegratedDailyPublication | null>;
    append(value: IntegratedDailyPublication, previous: IntegratedDailyPublication): Promise<void>;
  };
}
async function verifyIntegrated(value: IntegratedDailyPublication) {
  const { stateHash, canonicalPayload, ...body } = value;
  requireCheck(
    (await hashSeriesValue(body)) === stateHash && canonicalSeriesJson(body) === canonicalPayload,
  );
  await verifyIntegratedAllocationLedger(value.result);
}
export async function applyApprovedModelPlan(input: ExactModelApplyInput) {
  const { plan, approval, store } = input;
  requireCheck(
    (await hashSeriesValue(plan)) === input.authoritativePlanHash &&
      (await hashSeriesValue(approval)) === input.authoritativeApprovalHash &&
      approval.version === "kr-adjusted-recovery-apply-approval-v1" &&
      approval.status === "APPROVED" &&
      approval.owner === input.owner &&
      approval.fullPlanHash === input.authoritativePlanHash &&
      approval.preparationHash === plan.preparationHash &&
      approval.operationManifestHash === plan.operationManifestHash &&
      same(approval.runtimeHashes, input.runtimeHashes),
  );
  requireCheck(same(plan.executionProvenance, await buildExecutionProvenance(plan)));
  const model = plan.models;
  requireCheck(
    model.version === "kr-adjusted-ordered-model-plan-v1" &&
      model.operationalApproval === false &&
      model.historicalAvailabilityClaim === false &&
      model.originalPrefixPreserved === true &&
      model.expectedNewModelSessions === 12,
  );
  requireCheck(
    approval.retrospectiveRegistryHash === model.retrospectiveAuthorityCandidateHash &&
      approval.vintageAuthorityHash === model.vintageAuthorityCandidateHash &&
      (await hashSeriesValue(plan.executionProvenance)) === approval.executionProvenanceHash &&
      (await hashSeriesValue(plan.historyCorrection)) === approval.historyCorrectionHash,
  );
  requireCheck(
    model.preparedPublications.length === 2 &&
      model.newKrArchives.length === 2 &&
      model.newIntegratedSessions.length === 2 &&
      model.scope.dates.length === 2,
  );
  const retrospective = await verifyKrRetrospectiveAuthority(model.retrospectiveAuthorityCandidate);
  requireCheck(
    retrospective.registryHash === model.retrospectiveAuthorityCandidateHash &&
      retrospective.registryHash === approval.retrospectiveRegistryHash &&
      retrospective.receipt.owner === input.owner,
  );
  requireCheck(
    same(
      model.newAdoptedSessions,
      model.preparedPublications.flatMap((p: PreparedOctoberPublication) =>
        p.entries.map((e) => e.run),
      ),
    ),
  );
  const originals = new Map<string, OctoberRun>();
  const dates = model.scope.dates as string[];
  for (let i = 0; i < model.preparedPublications.length; i++) {
    const p = model.preparedPublications[i] as PreparedOctoberPublication,
      { preparedHash, ...body } = p;
    requireCheck(
      (await hashSeriesValue(body)) === preparedHash &&
        p.market === "KR" &&
        p.date === dates[i] &&
        p.runtimeCodeHash === input.runtimeHashes.october &&
        same(
          p.entries.map((e) => e.series.policy.kind),
          kinds,
        ) &&
        p.entries[0]!.run.publication.reviewedRetrospective?.registryHash ===
          approval.retrospectiveRegistryHash,
    );
    const datedAuthority = model.retrospectiveAuthorityCandidate.receipt.dates.find(
      (x: any) => x.date === p.date,
    );
    requireCheck(datedAuthority && datedAuthority.sourceHash === p.sourceHash);
    const existingPrepared = await store.readPrepared("KR", p.date);
    requireCheck(!existingPrepared || same(existingPrepared, p));
    for (const e of p.entries) {
      requireCheck(
        e.run.receipt.date === p.date &&
          e.run.publication.inputHash === p.inputHash &&
          e.run.publication.sourceHash === p.sourceHash &&
          same(
            e.run.publication.reviewedRetrospective,
            p.entries[0]!.run.publication.reviewedRetrospective,
          ),
      );
      const registered = await store.readSeries(e.series.bookId);
      requireCheck(registered && same(registered, e.series));
      await assertStoredOctoberRun(registered, e.run);
      const pin = model.retrospectiveAuthorityCandidate.receipt.predecessorHeads.find(
        (r: any) => r.bookId === e.series.bookId,
      );
      const original = await store.readSession<OctoberRun>(
        e.series.bookId,
        model.scope.predecessorDate,
      );
      requireCheck(pin && original && original.stateHash === pin.stateHash);
      await assertStoredOctoberRun(registered, original);
      originals.set(e.series.bookId, original);
      const expectedPrevious =
        i === 0
          ? original
          : (model.preparedPublications[i - 1] as PreparedOctoberPublication).entries.find(
              (x) => x.series.bookId === e.series.bookId,
            )!.run;
      requireCheck(
        e.previousDate === expectedPrevious.receipt.date &&
          e.previousHash === expectedPrevious.stateHash &&
          e.run.previousStateHash === expectedPrevious.stateHash,
      );
      if (["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"].includes(e.series.policy.kind)) {
        const priorRefs = (expectedPrevious as any).frozenInputArchive?.days;
        const archive = model.newKrArchives.find((a: any) => a.date === p.date);
        requireCheck(Array.isArray(priorRefs) && archive);
        requireCheck(
          same((e.run as any).frozenInputArchive?.days, [
            ...priorRefs,
            { date: p.date, hash: await hashSeriesValue(archive) },
          ]),
        );
      }
      const saved = await store.readSession<OctoberRun>(e.series.bookId, p.date);
      requireCheck(!saved || same(saved, e.run));
      const latest = await store.readLatest<OctoberRun>(e.series.bookId);
      requireCheck(
        latest &&
          [
            original,
            ...model.preparedPublications.flatMap((x: PreparedOctoberPublication) =>
              x.entries.filter((y) => y.series.bookId === e.series.bookId).map((y) => y.run),
            ),
          ].some((x) => same(x, latest)),
      );
    }
  }
  requireCheck(
    same(
      model.newKrArchives.map((a: any) => a.date),
      dates,
    ),
  );
  // A retry is a complete prefix, never a gap or merely a latest-hash match.
  for (const [bookId, original] of originals) {
    let last = original,
      missing = false;
    for (const p of model.preparedPublications as PreparedOctoberPublication[]) {
      const expected = p.entries.find((e) => e.series.bookId === bookId)!.run;
      const saved = await store.readSession<OctoberRun>(bookId, p.date);
      if (!saved) missing = true;
      else {
        requireCheck(!missing && same(saved, expected));
        last = saved;
      }
    }
    requireCheck(same(await store.readLatest(bookId), last));
  }
  const originalKr = await input.evidence.readKr(dates[0]!);
  requireCheck(
    originalKr &&
      originalKr.hash === plan.retainedIntegrated26EvidenceHash &&
      (await hashSeriesValue(originalKr.payload)) === originalKr.hash,
  );
  const newKr = plan.integratedNextEvidence;
  requireCheck(
    newKr.payload.date === dates[1] && (await hashSeriesValue(newKr.payload)) === newKr.hash,
  );
  const savedNext = await input.evidence.readKr(dates[1]!);
  requireCheck(!savedNext || same(savedNext, newKr));
  const oldIntegrated = new Map<"O1" | "S07", IntegratedDailyPublication>();
  requireCheck(
    same(
      model.newIntegratedSessions.map((x: IntegratedDailyPublication) => x.registry.policy.kind),
      ["O1", "S07"],
    ),
  );
  for (const value of model.newIntegratedSessions as IntegratedDailyPublication[]) {
    await verifyIntegrated(value);
    const kind = value.registry.policy.kind,
      head = await input.integrated.read(kind);
    await verifyIntegrated(head);
    const priorPin = model.retainedIntegrated26.find((x: any) => x.kind === kind);
    requireCheck(
      priorPin && value.previousStateHash === priorPin.stateHash && value.receipt.date === dates[1],
    );
    requireCheck(head.stateHash === priorPin.stateHash || same(head, value));
    const original = await input.integrated.readSession(kind, dates[0]!);
    requireCheck(original && original.stateHash === priorPin.stateHash);
    await verifyIntegrated(original);
    oldIntegrated.set(kind, original);
  }
  await input.assertArtifactInventory(plan);
  await input.assertActualLedgersUnchanged();
  if (input.phase === "VALIDATE") return { status: "EXACT_MODEL_PLAN_VALIDATED" };
  requireCheck(input.phase === "APPLY");
  // This immutable source-to-state linkage must be present before any late-derived model append.
  await input.provenance.putImmutable(plan.executionProvenance, approval.executionProvenanceHash);
  requireCheck(
    same(await input.provenance.read(approval.executionProvenanceHash), plan.executionProvenance),
  );
  for (const a of model.newKrArchives) {
    const r = await store.putKrInput(a);
    requireCheck(r.date === a.date && r.hash === (await hashSeriesValue(a)));
  }
  for (const p of model.preparedPublications as PreparedOctoberPublication[]) {
    requireCheck(same(await store.prepare(p), p));
    for (const e of p.entries) {
      const saved = await store.readSession<OctoberRun>(e.series.bookId, p.date);
      if (saved) {
        requireCheck(same(saved, e.run));
        continue;
      }
      const previous = await store.readSession<OctoberRun>(e.series.bookId, e.previousDate!);
      requireCheck(previous && previous.stateHash === e.previousHash);
      await store.append(e.series, e.run, previous);
      requireCheck(same(await store.readSession<OctoberRun>(e.series.bookId, p.date), e.run));
    }
  }
  await input.evidence.putKrImmutable(dates[1]!, newKr.payload, newKr.hash);
  requireCheck(same(await input.evidence.readKr(dates[1]!), newKr));
  for (const value of model.newIntegratedSessions as IntegratedDailyPublication[]) {
    const kind = value.registry.policy.kind,
      head = await input.integrated.read(kind);
    if (!same(head, value)) {
      requireCheck(head.stateHash === value.previousStateHash);
      await input.integrated.append(value, head);
    }
    requireCheck(same(await input.integrated.read(kind), value));
  }
  for (const [bookId, original] of originals)
    requireCheck(same(await store.readSession(bookId, model.scope.predecessorDate), original));
  requireCheck(same(await input.evidence.readKr(dates[0]!), originalKr));
  for (const [kind, original] of oldIntegrated)
    requireCheck(same(await input.integrated.readSession(kind, dates[0]!), original));
  await input.assertActualLedgersUnchanged();
  return {
    status: "EXACT_MODEL_PLAN_APPLIED",
    expectedNewModelSessions: 12,
    originalPrefixPreserved: true,
    actualLedgersUnchanged: true,
    historicalAvailabilityClaim: false,
  };
}
