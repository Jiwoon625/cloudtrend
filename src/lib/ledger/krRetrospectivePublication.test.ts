import { describe, it, expect } from "vitest";
import { hashSeriesValue } from "./modelSeries";
import {
  KR_RETROSPECTIVE_POLICY,
  verifyKrRetrospectiveAuthority,
  reviewedRetrospectiveProvenance,
  type KrRetrospectiveAuthority,
} from "./krRetrospectivePublication";
const H = `sha256:${"a".repeat(64)}` as const;
async function fixture() {
  const dataset = { synthetic: true },
    config = { synthetic: "config" };
  const receipt: KrRetrospectiveAuthority["receipt"] = {
    version: "kr-reviewed-retrospective-source-v1",
    owner: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    preparationHash: H,
    capsuleHash: H,
    captureManifestHash: H,
    sourceManifestHash: H,
    captureFinishedAt: "2026-10-28T12:00:00Z",
    originFinalPublicationHash: H,
    originFinalActivatedAt: "2026-10-28T00:00:00Z",
    derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
    preparationRuntimeCodeHash: H,
    runtimeCodeHash: H,
    predecessorDate: "2026-10-23",
    predecessorHeads: [
      "KR_MIXED",
      "KR_KOSPI",
      "KR_KOSDAQ",
      "ETF_V02",
      "KR_KOSPI_CONFIRM1_BEAR",
    ].map((k) => ({ bookId: "adopted-shadow-2026-10-12-v1:" + k, stateHash: H })),
    dates: [],
    historicalAvailabilityClaim: false,
  };
  for (const [date, next] of [
    ["2026-10-26", "2026-10-27"],
    ["2026-10-27", "2026-10-28"],
  ])
    receipt.dates.push({
      date: date!,
      sourceHash: H,
      datasetHash: await hashSeriesValue(dataset),
      configHash: await hashSeriesValue(config),
      evidenceStoredAt: "2026-10-28T13:00:00Z",
      modelAvailableAt: next + "T08:00:00+09:00",
      modelDecisionAt: next + "T08:10:00+09:00",
    });
  const registry: KrRetrospectiveAuthority["registry"] = {
    version: "kr-reviewed-retrospective-registry-v1",
    status: "APPROVED",
    policy: KR_RETROSPECTIVE_POLICY,
    receiptHash: await hashSeriesValue(receipt),
  };
  const authority = {
    registry,
    receipt,
    authoritativeRegistryHash: await hashSeriesValue(registry),
  };
  const d = receipt.dates[0]!;
  return {
    authority,
    input: {
      date: d.date,
      sourceHash: H,
      dataset,
      config,
      runtimeCodeHash: H,
      availableAt: d.modelAvailableAt,
      decisionAt: d.modelDecisionAt,
      sourceEvidence: [] as Array<{ sourceHash: typeof H; asOfDate: string; registeredAt: string }>,
    },
  };
}
describe("exact late-source retrospective authority", () => {
  it("retains actual late registration/capture and separately labeled modeled clocks", async () => {
    const f = await fixture();
    const p = await reviewedRetrospectiveProvenance(f.authority, f.input);
    expect(p.evidenceStoredAt).toBe("2026-10-28T13:00:00Z");
    expect(p.modelAvailableAt).toBe("2026-10-27T08:00:00+09:00");
    expect(p.historicalAvailabilityClaim).toBe(false);
  });
  it.each(["runtime", "dataset", "config", "source", "date", "actual", "model"])(
    "rejects altered %s despite well-formed independent authority",
    async (field) => {
      const f = await fixture();
      if (field === "runtime") f.input.runtimeCodeHash = ("sha256:" + "b".repeat(64)) as typeof H;
      if (field === "dataset") f.input.dataset.synthetic = false;
      if (field === "config") f.input.config.synthetic = "different";
      if (field === "source") f.input.sourceHash = ("sha256:" + "b".repeat(64)) as typeof H;
      if (field === "date") f.input.date = "2026-10-28";
      if (field === "actual")
        f.input.sourceEvidence.push({
          sourceHash: H,
          asOfDate: f.input.date,
          registeredAt: f.input.availableAt,
        });
      if (field === "model") f.input.availableAt = "2026-10-27T07:59:00+09:00";
      await expect(reviewedRetrospectiveProvenance(f.authority, f.input)).rejects.toThrow();
    },
  );
  it("does not accept a changed self-hashed receipt without the separately authoritative registry hash", async () => {
    const f = await fixture();
    f.authority.receipt.preparationHash = `sha256:${"b".repeat(64)}`;
    f.authority.registry.receiptHash = await hashSeriesValue(f.authority.receipt);
    await expect(verifyKrRetrospectiveAuthority(f.authority)).rejects.toThrow();
  });
  it("rejects duplicate/missing predecessor scope and extra authority fields", async () => {
    for (const edit of [
      (a: KrRetrospectiveAuthority) => a.receipt.predecessorHeads.pop(),
      (a: KrRetrospectiveAuthority) =>
        a.receipt.predecessorHeads.push(a.receipt.predecessorHeads[0]!),
    ]) {
      const f = await fixture();
      edit(f.authority);
      f.authority.registry.receiptHash = await hashSeriesValue(f.authority.receipt);
      f.authority.authoritativeRegistryHash = await hashSeriesValue(f.authority.registry);
      await expect(verifyKrRetrospectiveAuthority(f.authority)).rejects.toThrow();
    }
  });
});
