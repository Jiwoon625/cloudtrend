/** Exact Nov3 five-book append. VALIDATE never invokes a writer. */
import { hashSeriesValue, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import {
  assertStoredOctoberRun,
  type OctoberRun,
} from "../../src/lib/ledger/octoberShadowPipeline";
import type { OctoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import { verifyKrRetrospectiveAuthority } from "../../src/lib/ledger/krRetrospectivePublication";
import {
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApproval,
} from "../../src/lib/ledger/krSourceVintage";
import { check, same, DATES, KINDS, PREDECESSOR, type KrNov3Plan } from "./core";

export interface KrNov3Approval {
  version: "kr-nov3-recovery-approval-v1";
  status: "APPROVED";
  owner: string;
  planHash: SeriesHash;
  captureHash: SeriesHash;
  codeCommit: string;
  runtimeHashes: { october: SeriesHash; kospi: SeriesHash };
  retrospectiveRegistryHash: SeriesHash;
  vintageRegistryHash: SeriesHash;
  vintageReceiptHash: SeriesHash;
  historicalAvailabilityClaim: false;
}
/** Proposal only. A separately reviewed private archive record must authorize it. */
export async function krNov3ApprovalCandidate(p: KrNov3Plan): Promise<KrNov3Approval> {
  check(p.version === "kr-nov3-recovery-plan-v1" && p.operationalApproval === false, "PLAN_KIND");
  const vintage = await verifyKrSourceVintagePrivateApproval(p.vintageAuthorityCandidate);
  return {
    version: "kr-nov3-recovery-approval-v1",
    status: "APPROVED",
    owner: p.preparation.owner,
    planHash: await hashSeriesValue(p),
    captureHash: p.captureHash,
    codeCommit: p.preparation.codeCommit,
    runtimeHashes: p.preparation.runtimeHashes,
    retrospectiveRegistryHash: p.retrospectiveAuthorityCandidate.authoritativeRegistryHash,
    vintageRegistryHash: vintage.registryHash,
    vintageReceiptHash: vintage.receiptHash,
    historicalAvailabilityClaim: false,
  };
}
export interface KrNov3ApplyInput {
  phase: "VALIDATE" | "APPLY";
  plan: KrNov3Plan;
  approval: KrNov3Approval;
  authoritativePlanHash: SeriesHash;
  authoritativeApprovalHash: SeriesHash;
  owner: string;
  admittedCodeCommit: string;
  admittedRuntimeHashes: KrNov3Approval["runtimeHashes"];
  store: OctoberShadowStore;
  /** Independently fetch the separately staged owner-private v3 authority. */
  readAuthority(): Promise<KrSourceVintagePrivateApproval | null>;
  /** Full preserved row inventories and object generations, permitting exact plan progress only. */
  assertFresh(plan: KrNov3Plan): Promise<void>;
  assertExclusiveWriter(): Promise<void>;
  putProvenance(plan: KrNov3Plan, approval: KrNov3Approval): Promise<void>;
}
export async function validateKrNov3Plan(p: KrNov3Plan) {
  check(
    p.version === "kr-nov3-recovery-plan-v1" &&
      p.operationalApproval === false &&
      p.historicalAvailabilityClaim === false &&
      p.sourceRegistryMutation === false &&
      p.integratedMutation === false &&
      p.actualMutation === false &&
      p.expectedNewModelSessions === 5,
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
      p.captureHash === p.preparation.captureHash,
    "INNER_BINDING",
  );
  const retrospective = await verifyKrRetrospectiveAuthority(p.retrospectiveAuthorityCandidate);
  const vintage = await verifyKrSourceVintagePrivateApproval(p.vintageAuthorityCandidate);
  check(
    retrospective.receipt.preparationHash === p.preparationHash &&
      retrospective.receipt.capsuleHash === p.captureHash &&
      retrospective.receipt.owner === p.preparation.owner &&
      retrospective.receipt.predecessorDate === PREDECESSOR &&
      same(
        retrospective.receipt.dates.map((x) => x.date),
        DATES,
      ),
    "RETROSPECTIVE_BINDING",
  );
  check(
    p.vintageAuthorityCandidate.registry.version === "kr-source-vintage-approval-v3" &&
      same(p.sourceVintageApproval, p.vintageAuthorityCandidate) &&
      same(p.vintageAuthorityCandidate.predecessor, p.sourceVintagePredecessor) &&
      vintage.activationDate === DATES[0],
    "VINTAGE_BINDING",
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
      p.newAdoptedSessions.length === 5 &&
      same(
        p.preparedPublications.flatMap((x) => x.entries.map((e) => e.run)),
        p.newAdoptedSessions,
      ),
    "OUTPUT_INVENTORY",
  );
  const pub = p.preparedPublications[0]!;
  const { preparedHash, ...body } = pub;
  check(
    pub.market === "KR" &&
      (await hashSeriesValue(body)) === preparedHash &&
      same(
        pub.entries.map((x) => x.series.policy.kind),
        KINDS,
      ),
    "PREPARED_HASH_KINDS",
  );
  for (const e of pub.entries) {
    const prior = p.predecessors.find((x) => x.series.bookId === e.series.bookId);
    check(
      prior &&
        prior.run.receipt.date === PREDECESSOR &&
        (await hashSeriesValue(prior.run)) === prior.payloadHash &&
        same(prior.series, e.series) &&
        e.previousDate === PREDECESSOR &&
        e.previousHash === prior.run.stateHash,
      "ORDERED_PREDECESSOR",
    );
    await assertStoredOctoberRun(e.series, e.run);
    check(
      e.run.receipt.date === DATES[0] &&
        e.run.publication.reviewedRetrospective?.registryHash === retrospective.registryHash,
      "RUN_PROVENANCE",
    );
  }
}
export async function applyKrNov3Recovery(i: KrNov3ApplyInput) {
  const p = i.plan,
    a = i.approval;
  check(i.phase === "VALIDATE" || i.phase === "APPLY", "PHASE");
  check(
    (await hashSeriesValue(p)) === i.authoritativePlanHash &&
      (await hashSeriesValue(a)) === i.authoritativeApprovalHash &&
      same(a, await krNov3ApprovalCandidate(p)),
    "AUTHORITATIVE_APPROVAL",
  );
  check(
    a.owner === i.owner &&
      a.codeCommit === i.admittedCodeCommit &&
      same(a.runtimeHashes, i.admittedRuntimeHashes),
    "ADMITTED_OWNER_RUNTIME",
  );
  await validateKrNov3Plan(p);
  const gate = async () => {
    await i.assertExclusiveWriter();
    check(
      same(await i.readAuthority(), p.vintageAuthorityCandidate),
      "INDEPENDENT_VINTAGE_AUTHORITY",
    );
    await i.assertFresh(p);
  };
  await gate();
  const pub = p.preparedPublications[0]!;
  const savedPrepared = await i.store.readPrepared("KR", DATES[0]!);
  check(savedPrepared === null || same(savedPrepared, pub), "EXISTING_PREPARED_CONFLICT");
  // Admit every book before the first write. Exact partial application is resumable;
  // no conflicting target or later head is accepted, and no earlier row can change.
  for (const x of p.predecessors) {
    check(
      same(await i.store.readSeries(x.series.bookId), x.series) &&
        same(await i.store.readSession(x.series.bookId, PREDECESSOR), x.run),
      "IMMUTABLE_PREDECESSOR",
    );
    const expected = pub.entries.find((e) => e.series.bookId === x.series.bookId)!;
    const saved = await i.store.readSession<OctoberRun>(x.series.bookId, DATES[0]!);
    check(saved === null || same(saved, expected.run), "EXACT_TARGET_PREFIX");
    check(same(await i.store.readLatest(x.series.bookId), saved ?? x.run), "LATEST_PREFIX");
  }
  if (i.phase === "VALIDATE")
    return {
      status: "VALIDATED" as const,
      noOperationalWrites: true,
      historicalAvailabilityClaim: false,
    };
  await gate();
  await i.putProvenance(p, a);
  for (const archive of p.newArchives) {
    await gate();
    const hash = await hashSeriesValue(archive);
    let failure: unknown;
    try {
      await i.store.putKrInput(archive);
    } catch (error) {
      failure = error;
    }
    let after: unknown;
    try {
      after = await i.store.readKrInput(archive.date, hash);
    } catch {
      /* original failure below */
    }
    if (!same(after ?? null, archive)) {
      if (failure) throw failure;
      throw new Error("KR_NOV3_RECOVERY_ARCHIVE_READBACK");
    }
  }
  await gate();
  let preparationFailure: unknown;
  try {
    await i.store.prepare(pub);
  } catch (error) {
    preparationFailure = error;
  }
  if (!same(await i.store.readPrepared("KR", DATES[0]!), pub)) {
    if (preparationFailure) throw preparationFailure;
    throw new Error("KR_NOV3_RECOVERY_PREPARED_READBACK");
  }
  for (const e of pub.entries) {
    await gate();
    const saved = await i.store.readSession(e.series.bookId, DATES[0]!);
    if (saved) {
      check(same(saved, e.run), "REUSE_EXACT");
      continue;
    }
    const prev = await i.store.readSession<OctoberRun>(e.series.bookId, PREDECESSOR);
    const expected = p.predecessors.find((x) => x.series.bookId === e.series.bookId)!;
    check(
      same(prev, expected.run) && same(await i.store.readLatest(e.series.bookId), prev),
      "LIVE_PREDECESSOR",
    );
    let failure: unknown;
    try {
      await i.store.append(e.series, e.run, prev);
    } catch (error) {
      failure = error;
    }
    const after = await i.store.readSession(e.series.bookId, DATES[0]!);
    if (!same(after, e.run)) {
      if (failure) throw failure;
      throw new Error("KR_NOV3_RECOVERY_APPEND_READBACK");
    }
  }
  await gate();
  for (const e of pub.entries)
    check(
      same(await i.store.readSession(e.series.bookId, DATES[0]!), e.run) &&
        same(await i.store.readLatest(e.series.bookId), e.run),
      "FINAL_MODEL_READBACK",
    );
  return {
    status: "APPLIED" as const,
    expectedNewModelSessions: 5,
    historicalAvailabilityClaim: false,
  };
}
