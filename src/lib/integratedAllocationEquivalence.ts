/** Exact reviewed provenance equivalence. Never an economic-history rewrite. */
import { canonicalSeriesJson, hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";
import { validDate } from "./ledger/date";
import {
  adaptIntegratedKrEvidence,
  adaptIntegratedUsSession,
  type IntegratedKrEvidence,
  type AllocationAdapterClock,
} from "./integratedAllocationReplayAdapter";
import {
  prepareIntegratedDailyPublication,
  type IntegratedDailyPublication,
} from "./integratedAllocationPublication";
import type { UsProspectiveAnalysis } from "./engine/usProspective";
import type { IntegratedAllocationSessionInput } from "./integratedAllocationShadow";

export const INTEGRATED_EQUIVALENCE_POLICY =
  "PRESERVE_COMPLETED_SESSION_EXACT_INPUTS_EXCEPT_SOURCE_HASH_V1" as const;
export interface IntegratedEquivalenceInputs {
  date: string;
  calculatedAt: string;
  original: IntegratedKrEvidence;
  candidate: IntegratedKrEvidence;
  history: IntegratedKrEvidence[];
  usPrevious: { analysis: UsProspectiveAnalysis; clock: AllocationAdapterClock };
  usCurrent: { analysis: UsProspectiveAnalysis; clock: AllocationAdapterClock };
  books: Array<{
    kind: "O1" | "S07";
    previous: IntegratedDailyPublication;
    completed: IntegratedDailyPublication;
  }>;
}
export interface IntegratedEquivalenceBookProof {
  kind: "O1" | "S07";
  previousStateHash: SeriesHash;
  completedStateHash: SeriesHash;
  baselineSessions: IntegratedAllocationSessionInput[];
  candidateSessions: IntegratedAllocationSessionInput[];
  baselineSessionsHash: SeriesHash;
  candidateSessionsHash: SeriesHash;
  economicSessionInputsHash: SeriesHash;
  candidatePublicationHash: SeriesHash;
}
export interface IntegratedEquivalenceProof {
  version: "integrated-source-equivalence-proof-v1";
  policy: typeof INTEGRATED_EQUIVALENCE_POLICY;
  date: string;
  originalEvidenceHash: SeriesHash;
  candidateEvidenceHash: SeriesHash;
  historyHashes: SeriesHash[];
  previousUsHash: SeriesHash;
  currentUsHash: SeriesHash;
  books: IntegratedEquivalenceBookProof[];
}
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const assert = (condition: unknown): void => {
  if (!condition) throw new Error("Integrated exact equivalence verification failed");
};
/** Only the single top-level provenance field is excluded; every other input stays exact. */
export function economicSessionInputs(sessions: readonly IntegratedAllocationSessionInput[]) {
  return sessions.map(({ sourceHash: _, ...allOtherInputs }) => allOtherInputs);
}
export async function prepareIntegratedEquivalenceProof(
  input: IntegratedEquivalenceInputs,
): Promise<IntegratedEquivalenceProof> {
  assert(
    validDate(input.date) &&
      input.original.date === input.date &&
      input.candidate.date === input.date &&
      Number.isFinite(Date.parse(input.calculatedAt)),
  );
  assert(
    equal(
      input.books.map((b) => b.kind),
      ["O1", "S07"],
    ),
  );
  assert(
    input.history.length > 0 &&
      input.history.every(
        (e, i) => e.date < input.date && (i === 0 || e.date > input.history[i - 1]!.date),
      ),
  );
  assert(input.usCurrent.analysis.date === input.date);
  const books: IntegratedEquivalenceBookProof[] = [];
  for (const { kind, previous, completed } of input.books) {
    assert(
      previous.registry.policy.kind === kind &&
        completed.registry.policy.kind === kind &&
        completed.receipt.date === input.date &&
        completed.previousStateHash === previous.stateHash &&
        equal(previous.registry, completed.registry),
    );
    assert(input.usPrevious.analysis.date === previous.result.markets.U.lastSessionDate);
    assert(
      equal(
        input.history.map((e) => e.date),
        previous.result.markets.K.sessions,
      ),
    );
    const make = (evidence: IntegratedKrEvidence) => [
      adaptIntegratedKrEvidence(previous.result, { market: "K", evidence, history: input.history }),
      adaptIntegratedKrEvidence(previous.result, { market: "E", evidence, history: input.history }),
      adaptIntegratedUsSession(previous.result, {
        analysis: input.usCurrent.analysis,
        previousAnalysis: input.usPrevious.analysis,
        clock: input.usCurrent.clock,
      }),
    ];
    const baselineSessions = make(input.original),
      candidateSessions = make(input.candidate);
    assert(
      equal(economicSessionInputs(baselineSessions), economicSessionInputs(candidateSessions)),
    );
    const baseline = await prepareIntegratedDailyPublication({
      registry: previous.registry,
      previous,
      date: input.date,
      sessions: baselineSessions,
      now: input.calculatedAt,
    });
    assert(equal(baseline, completed));
    const candidate = await prepareIntegratedDailyPublication({
      registry: previous.registry,
      previous,
      date: input.date,
      sessions: candidateSessions,
      now: input.calculatedAt,
    });
    books.push({
      kind,
      previousStateHash: previous.stateHash,
      completedStateHash: completed.stateHash,
      baselineSessions,
      candidateSessions,
      baselineSessionsHash: await hashSeriesValue(baselineSessions),
      candidateSessionsHash: await hashSeriesValue(candidateSessions),
      economicSessionInputsHash: await hashSeriesValue(economicSessionInputs(baselineSessions)),
      candidatePublicationHash: candidate.stateHash,
    });
  }
  const originalEvidenceHash = await hashSeriesValue(input.original),
    candidateEvidenceHash = await hashSeriesValue(input.candidate);
  assert(originalEvidenceHash !== candidateEvidenceHash);
  return {
    version: "integrated-source-equivalence-proof-v1",
    policy: INTEGRATED_EQUIVALENCE_POLICY,
    date: input.date,
    originalEvidenceHash,
    candidateEvidenceHash,
    historyHashes: await Promise.all(input.history.map(hashSeriesValue)),
    previousUsHash: await hashSeriesValue(input.usPrevious),
    currentUsHash: await hashSeriesValue(input.usCurrent),
    books,
  };
}
export interface IntegratedEquivalenceApproval {
  version: "integrated-source-equivalence-approval-v1";
  status: "APPROVED";
  policy: typeof INTEGRATED_EQUIVALENCE_POLICY;
  preparationHash: SeriesHash;
  proofHash: SeriesHash;
  runtimeCodeHash: SeriesHash;
  notBefore: string;
  date: string;
  originalEvidenceHash: SeriesHash;
  candidateEvidenceHash: SeriesHash;
}
export async function verifyIntegratedEquivalenceApproval(input: {
  approval: IntegratedEquivalenceApproval;
  authoritativeApprovalHash: SeriesHash;
  preparationHash: SeriesHash;
  preparedProof: IntegratedEquivalenceProof;
  runtimeCodeHash: SeriesHash;
  live: IntegratedEquivalenceInputs;
}) {
  const a = input.approval;
  assert(
    equal(
      Object.keys(a).sort(),
      [
        "version",
        "status",
        "policy",
        "preparationHash",
        "proofHash",
        "runtimeCodeHash",
        "notBefore",
        "date",
        "originalEvidenceHash",
        "candidateEvidenceHash",
      ].sort(),
    ),
  );
  assert(
    a.version === "integrated-source-equivalence-approval-v1" &&
      a.status === "APPROVED" &&
      a.policy === INTEGRATED_EQUIVALENCE_POLICY,
  );
  assert(
    (await hashSeriesValue(a)) === input.authoritativeApprovalHash &&
      a.preparationHash === input.preparationHash &&
      a.runtimeCodeHash === input.runtimeCodeHash &&
      validDate(a.notBefore) &&
      a.notBefore <= input.live.date &&
      a.date === input.live.date,
  );
  assert(
    a.proofHash === (await hashSeriesValue(input.preparedProof)) &&
      a.originalEvidenceHash === (await hashSeriesValue(input.live.original)) &&
      a.candidateEvidenceHash === (await hashSeriesValue(input.live.candidate)),
  );
  const recomputed = await prepareIntegratedEquivalenceProof(input.live);
  assert(equal(recomputed, input.preparedProof));
  return {
    proofHash: a.proofHash,
    approvalHash: input.authoritativeApprovalHash,
    retainedEvidenceHash: a.originalEvidenceHash,
    candidateEvidenceHash: a.candidateEvidenceHash,
    completedStateHashes: recomputed.books.map((b) => ({
      kind: b.kind,
      stateHash: b.completedStateHash,
    })),
  };
}
