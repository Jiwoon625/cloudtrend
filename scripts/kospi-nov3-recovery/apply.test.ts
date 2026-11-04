/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic immutable evidence */
import { beforeAll, expect, it } from "vitest";
import { createNov3Fixture } from "./nov3-fixture";
import { prepareNov3Recovery } from "./core";
import { applyNov3Recovery, nov3ApprovalCandidate } from "./apply";
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
import type { ShadowObjectStore } from "../../src/lib/kospiShadowStore";
const H = (x: unknown) => captureCanonicalProof(x).hash;
let receipt: any, approval: any;
beforeAll(async () => {
  const input = await createNov3Fixture();
  const result = await prepareNov3Recovery(input);
  receipt = {
    version: "kospi-nov3-recovery-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    input,
    result,
  };
  approval = await nov3ApprovalCandidate(H(receipt), result, {
    codeCommit: "b".repeat(40),
    runtimeHash: H("Nov3 writer"),
  });
}, 60000);
function setup() {
  const objects = new Map<string, unknown>(
    receipt.input.capturedObjects.map((x: any) => [x.path, structuredClone(x.payload)]),
  );
  const writes: string[] = [];
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => structuredClone(objects.get(p) ?? null) as T | null,
    latestSessionDate: async (p) =>
      [...objects.keys()]
        .filter((x) => x.startsWith(p + "/") && /\/\d{4}-\d{2}-\d{2}\.json$/.test(x))
        .sort()
        .at(-1)
        ?.slice(-15, -5) ?? null,
    putImmutable: async (p, v) => {
      if (objects.has(p)) throw Error("collision");
      objects.set(p, structuredClone(v));
      writes.push(p);
    },
    putLatest: async (p, v) => {
      objects.set(p, structuredClone(v));
      writes.push(p);
    },
  };
  const args = {
    store,
    preparationReceipt: receipt,
    approval,
    authoritativePreparationHash: H(receipt),
    authoritativeApprovalHash: H(approval),
    approvedRuntimeCodeHash: approval.runtimeCodeHash,
    approvedWriterCodeCommit: approval.writerCodeCommit,
    approvedWriterRuntimeHash: approval.writerRuntimeHash,
    assertExclusiveWriter: async () => {},
  };
  return { objects, writes, args };
}
it("VALIDATE writes nothing, APPLY appends only Nov3 and projection, retry is read-only", async () => {
  const f = setup();
  const before = new Map(f.objects);
  expect((await applyNov3Recovery({ ...f.args, validateOnly: true })).status).toBe("VALIDATED");
  expect(f.writes).toEqual([]);
  const r = await applyNov3Recovery(f.args);
  expect(r.status).toBe("VERIFIED");
  expect(r.verifiedWriteCount).toBe(2);
  expect(f.writes[0]).toMatch(/sessions\/2026-11-03.json$/);
  expect(f.writes[1]).toMatch(/latest.json$/);
  for (const [path, value] of before)
    if (path !== f.writes[1]) expect(H(f.objects.get(path))).toBe(H(value));
  expect((await applyNov3Recovery(f.args)).verifiedWriteCount).toBe(0);
}, 30000);
it("cannot use the old November approval or rewrite a conflicting Nov3 session", async () => {
  const f = setup();
  const old = receipt.input.priorRecovery.approval.payload;
  await expect(
    applyNov3Recovery({ ...f.args, approval: old, authoritativeApprovalHash: H(old) }),
  ).rejects.toThrow();
  expect(f.writes).toEqual([]);
  const path = `${approval.owner}/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1/sessions/2026-11-03.json`;
  f.objects.set(path, { not: "approved" });
  await expect(applyNov3Recovery(f.args)).rejects.toThrow();
  expect(f.writes).toEqual([]);
});
