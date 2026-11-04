/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic immutable lineage */
import { beforeAll, expect, it } from "vitest";

import { prepareNov3Recovery, type Nov3RecoveryInput } from "./core";
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
const H = (x: unknown) => captureCanonicalProof(x).hash;
let input: Nov3RecoveryInput;
import { createNov3Fixture } from "./nov3-fixture";
beforeAll(async () => {
  input = await createNov3Fixture();
}, 60000);
it("proves exactly Nov3 while preserving completed November lineage", async () => {
  const before = H(input);
  const r = await prepareNov3Recovery(input);
  expect(r.status).toBe("PROVEN_NOV3_RETROSPECTIVE_CONTINUATION");
  expect(H(input)).toBe(before);
  if (r.status !== "PROVEN_NOV3_RETROSPECTIVE_CONTINUATION") return;
  expect(r.plan.sessions.map((s) => s.date)).toEqual(["2026-11-03"]);
  expect(r.plan.writeSet).toHaveLength(2);
  expect(r.historicalAvailabilityClaim).toBe(false);
  expect(r.operationalApproval).toBe(false);
});
it("rejects old dates, a missing November completion and changed historical prefix", async () => {
  for (const change of [
    (i: any) => {
      i.authority.targetDates = ["2026-10-30", "2026-11-02"];
    },
    (i: any) => {
      i.priorRecovery.completion.payload.result.status = "VALIDATED";
      i.priorRecovery.completion.hash = H(i.priorRecovery.completion.payload);
    },
    (i: any) => {
      i.capturedObjects[0].payload = {};
      i.capturedObjects[0].hash = H({});
    },
    (i: any) => {
      i.targetSessions[0].lateRecovery.historicalAvailabilityClaim = true;
    },
  ]) {
    const x = structuredClone(input);
    change(x);
    expect((await prepareNov3Recovery(x)).status).toBe("BLOCKED_NOV3_RETROSPECTIVE_BOUNDARY");
  }
});
