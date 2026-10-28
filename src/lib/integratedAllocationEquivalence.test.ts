/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { hashSeriesValue } from "./ledger/modelSeries";
import {
  economicSessionInputs,
  prepareIntegratedEquivalenceProof,
  verifyIntegratedEquivalenceApproval,
  INTEGRATED_EQUIVALENCE_POLICY,
} from "./integratedAllocationEquivalence";
vi.mock("./integratedAllocationReplayAdapter", () => ({
  adaptIntegratedKrEvidence: (_: any, { market, evidence }: any) => ({
    market,
    date: evidence.date,
    sourceHash: evidence.sourceHash,
    ...evidence.economics,
  }),
  adaptIntegratedUsSession: (_: any, { analysis }: any) => ({
    market: "U",
    date: analysis.date,
    sourceHash: "same",
    cash: "100",
  }),
}));
vi.mock("./integratedAllocationPublication", () => ({
  prepareIntegratedDailyPublication: async ({ registry, previous, date, sessions }: any) => ({
    ...previous,
    registry,
    previousStateHash: previous.stateHash,
    receipt: { date },
    stateHash: await hashSeriesValue(sessions),
  }),
}));
const H = "sha256:" + "a".repeat(64);
async function fixture() {
  const original = {
    date: "2026-10-26",
    sourceHash: "old",
    economics: {
      prices: [{ symbol: "TEST", open: "10" }],
      cash: "100",
      pending: [{ budget: "20" }],
      fees: "1",
      allocation: { K: "0.5" },
    },
  };
  const candidate = { ...structuredClone(original), sourceHash: "new" };
  const books = [];
  for (const kind of ["O1", "S07"]) {
    const previous: any = {
      registry: { policy: { kind } },
      stateHash: H,
      result: {
        markets: { K: { sessions: ["2026-10-23"] }, U: { lastSessionDate: "2026-10-23" } },
      },
    };
    const sessions = [
      ...["K", "E"].map((market) => ({
        market,
        date: original.date,
        sourceHash: "old",
        ...original.economics,
      })),
      { market: "U", date: original.date, sourceHash: "same", cash: "100" },
    ];
    const completed = {
      ...previous,
      previousStateHash: H,
      receipt: { date: original.date },
      stateHash: await hashSeriesValue(sessions),
    };
    books.push({ kind, previous, completed });
  }
  return {
    date: original.date,
    calculatedAt: "2026-10-28T12:00:00Z",
    original,
    candidate,
    history: [{ date: "2026-10-23" }],
    usPrevious: { analysis: { date: "2026-10-23" } },
    usCurrent: { analysis: { date: original.date } },
    books,
  } as any;
}
describe("exact provenance-only equivalence", () => {
  it("retains every field other than the single top-level sourceHash", () => {
    const value: any = [
      {
        sourceHash: "outer",
        nested: { sourceHash: "inner" },
        cash: "1",
        positions: [{ quantity: "2" }],
        fees: "3",
        pnl: "4",
        pending: [{ budget: "5" }],
        allocation: ["K", "E"],
      },
    ];
    expect(economicSessionInputs(value)).toEqual([
      {
        nested: { sourceHash: "inner" },
        cash: "1",
        positions: [{ quantity: "2" }],
        fees: "3",
        pnl: "4",
        pending: [{ budget: "5" }],
        allocation: ["K", "E"],
      },
    ]);
    expect(value[0].sourceHash).toBe("outer");
  });
  it("proves exact original baseline and does not mutate frozen input", async () => {
    const f = await fixture(),
      before = JSON.stringify(f),
      p = await prepareIntegratedEquivalenceProof(f);
    expect(p.books).toHaveLength(2);
    expect(p.originalEvidenceHash).not.toBe(p.candidateEvidenceHash);
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each(["cash", "fees", "pending", "allocation", "prices"])(
    "rejects changed economic %s even with valid candidate self hashes",
    async (field) => {
      const f = await fixture();
      f.candidate.economics[field] = { changed: true };
      await expect(prepareIntegratedEquivalenceProof(f)).rejects.toThrow();
    },
  );
  it("rejects modified completed state or missing historical session", async () => {
    const f = await fixture();
    f.books[0].completed.stateHash = "changed";
    await expect(prepareIntegratedEquivalenceProof(f)).rejects.toThrow();
    const g = await fixture();
    g.history = [];
    await expect(prepareIntegratedEquivalenceProof(g)).rejects.toThrow();
  });
  it("requires independent exact approval hash, runtime, activation, evidence and proof", async () => {
    const live = await fixture(),
      preparedProof = await prepareIntegratedEquivalenceProof(live);
    const approval: any = {
      version: "integrated-source-equivalence-approval-v1",
      status: "APPROVED",
      policy: INTEGRATED_EQUIVALENCE_POLICY,
      preparationHash: H,
      proofHash: await hashSeriesValue(preparedProof),
      runtimeCodeHash: H,
      notBefore: live.date,
      date: live.date,
      originalEvidenceHash: preparedProof.originalEvidenceHash,
      candidateEvidenceHash: preparedProof.candidateEvidenceHash,
    };
    const input: any = {
      approval,
      authoritativeApprovalHash: await hashSeriesValue(approval),
      preparationHash: H,
      preparedProof,
      runtimeCodeHash: H,
      live,
    };
    expect((await verifyIntegratedEquivalenceApproval(input)).retainedEvidenceHash).toBe(
      preparedProof.originalEvidenceHash,
    );
    for (const changes of [
      { runtimeCodeHash: "other" },
      { authoritativeApprovalHash: H },
      { preparationHash: "other" },
    ])
      await expect(verifyIntegratedEquivalenceApproval({ ...input, ...changes })).rejects.toThrow();
    const late = { ...approval, notBefore: "2026-10-27" };
    await expect(
      verifyIntegratedEquivalenceApproval({
        ...input,
        approval: late,
        authoritativeApprovalHash: await hashSeriesValue(late),
      }),
    ).rejects.toThrow();
    const forged = { ...approval, candidateEvidenceHash: H };
    await expect(
      verifyIntegratedEquivalenceApproval({
        ...input,
        approval: forged,
        authoritativeApprovalHash: await hashSeriesValue(forged),
      }),
    ).rejects.toThrow();
  });
});
