/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic authenticated historical evidence */
import { expect, it, vi } from "vitest";
import { createNov3Fixture } from "./nov3-fixture";
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
import originalRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const H = (v: unknown) => captureCanonicalProof(v).hash;
it("keeps historical runtime immutable and bridges only through exact current replay", async () => {
  const input = await createNov3Fixture();
  const historicalHash = input.priorRecovery.plan.hash;
  const differentAdmitted =
    "sha256:55dcf41767160a6b507422447ee6a4818b34a41a55205128086bbce6d058c990";
  expect(input.priorRecovery.plan.payload.result.authority.runtimeCodeHash).not.toBe(
    differentAdmitted,
  );
  vi.resetModules();
  vi.doMock("../../src/lib/kospiShadowPublicationRuntime.generated.json", () => ({
    default: { ...originalRuntime, codeHash: differentAdmitted },
  }));
  try {
    const { prepareNov3Recovery } = await import("./core");
    input.authority.runtimeCodeHash = differentAdmitted;
    (input.targetSessions[0] as any).lateRecovery.runtimeCodeHash = differentAdmitted;
    const result = await prepareNov3Recovery(input);
    expect(result.status).toBe("PROVEN_NOV3_RETROSPECTIVE_CONTINUATION");
    expect(input.priorRecovery.plan.hash).toBe(historicalHash);
    expect(H(input.priorRecovery.plan.payload)).toBe(historicalHash);
    if (result.status !== "PROVEN_NOV3_RETROSPECTIVE_CONTINUATION") return;
    expect(result.runtimeBridge.originalTaggedFullReplayEqual).toBe(true);
    expect(result.runtimeBridge.priorApprovedRuntimeHash).not.toBe(
      result.runtimeBridge.currentRuntimeHash,
    );
    for (const mutate of [
      (x: any) => {
        x.priorRecovery.plan.payload.result.runtimeBridge.currentRuntimeHash = H("forged");
      },
      (x: any) => {
        x.priorRecovery.plan.payload.result.snapshots[0].source.lateRecovery.runtimeCodeHash =
          H("forged");
      },
      (x: any) => {
        x.priorRecovery.completion.payload.result.status = "VALIDATED";
      },
      (x: any) => {
        x.priorRecovery.plan.payload.input.authority.runtimeCodeHash = H("unadmitted");
      },
    ]) {
      const x = structuredClone(input);
      mutate(x);
      x.priorRecovery.plan.hash = H(x.priorRecovery.plan.payload);
      x.priorRecovery.completion.hash = H(x.priorRecovery.completion.payload);
      expect((await prepareNov3Recovery(x)).status).toBe("BLOCKED_NOV3_RETROSPECTIVE_BOUNDARY");
    }
  } finally {
    vi.doUnmock("../../src/lib/kospiShadowPublicationRuntime.generated.json");
    vi.resetModules();
  }
}, 30000);
