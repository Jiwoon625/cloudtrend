import { describe, expect, it } from "vitest";
import { hashSeriesValue } from "./modelSeries";
import {
  KR_RETROSPECTIVE_POLICY,
  reviewedRetrospectiveProvenance,
  verifyKrRetrospectiveAuthority,
  type KrRetrospectiveAuthority,
} from "./krRetrospectivePublication";

const H = `sha256:${"a".repeat(64)}` as const;
const OTHER = `sha256:${"b".repeat(64)}` as const;
async function rehash(a: KrRetrospectiveAuthority) {
  a.registry.receiptHash = await hashSeriesValue(a.receipt);
  a.authoritativeRegistryHash = await hashSeriesValue(a.registry);
}
async function fixture(v2 = true) {
  const dataset = { fixture: "dataset" },
    config = { fixture: "config" };
  const dates = v2 ? ["2026-11-03"] : ["2026-10-26", "2026-10-27"];
  const receipt = {
    version: v2 ? "kr-reviewed-retrospective-source-v2" : "kr-reviewed-retrospective-source-v1",
    owner: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    preparationHash: H,
    capsuleHash: H,
    captureManifestHash: H,
    sourceManifestHash: H,
    captureFinishedAt: "2026-11-04T03:00:00Z",
    originFinalPublicationHash: H,
    originFinalActivatedAt: "2026-11-04T01:00:00Z",
    derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
    preparationRuntimeCodeHash: H,
    runtimeCodeHash: H,
    predecessorDate: v2 ? "2026-11-02" : "2026-10-23",
    predecessorHeads: [
      "KR_MIXED",
      "KR_KOSPI",
      "KR_KOSDAQ",
      "ETF_V02",
      "KR_KOSPI_CONFIRM1_BEAR",
    ].map((book) => ({
      bookId: `adopted-shadow-2026-10-12-v1:${book}`,
      stateHash: H,
    })),
    dates: await Promise.all(
      dates.map(async (date) => ({
        date,
        sourceHash: H,
        datasetHash: await hashSeriesValue(dataset),
        configHash: await hashSeriesValue(config),
        evidenceStoredAt: "2026-11-04T03:10:00Z",
        modelAvailableAt: "2026-11-04T08:00:00+09:00",
        modelDecisionAt: "2026-11-04T08:10:00+09:00",
      })),
    ),
    historicalAvailabilityClaim: false,
  };
  const a = {
    receipt,
    registry: {
      version: v2
        ? "kr-reviewed-retrospective-registry-v2"
        : "kr-reviewed-retrospective-registry-v1",
      status: "APPROVED",
      policy: KR_RETROSPECTIVE_POLICY,
      receiptHash: H,
    },
    authoritativeRegistryHash: H,
  } as KrRetrospectiveAuthority;
  await rehash(a);
  return {
    a,
    input: {
      date: dates[0]!,
      sourceHash: H as string as `sha256:${string}`,
      dataset,
      config,
      runtimeCodeHash: H as string as `sha256:${string}`,
      availableAt: a.receipt.dates[0]!.modelAvailableAt,
      decisionAt: a.receipt.dates[0]!.modelDecisionAt,
      sourceEvidence: [] as Array<{
        sourceHash: `sha256:${string}`;
        asOfDate: string;
        registeredAt: string;
      }>,
    },
  };
}

describe("independent Nov3-only retrospective authority review", () => {
  it("retains v1 two-date authority and rejects relabeling it as v2", async () => {
    const { a } = await fixture(false);
    await expect(verifyKrRetrospectiveAuthority(a)).resolves.toBeDefined();
    Object.assign(a.registry, { version: "kr-reviewed-retrospective-registry-v2" });
    Object.assign(a.receipt, { version: "kr-reviewed-retrospective-source-v2" });
    await rehash(a);
    await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
  });
  it("admits only the independently hashed single-date receipt with honest late clocks", async () => {
    const { a, input } = await fixture();
    const before = JSON.stringify(a);
    const p = await reviewedRetrospectiveProvenance(a, input);
    expect(p.historicalAvailabilityClaim).toBe(false);
    expect(p.evidenceStoredAt).toBe("2026-11-04T03:10:00Z");
    expect(p.modelAvailableAt).toBe(input.availableAt);
    expect(JSON.stringify(a)).toBe(before);
  });
  it.each([
    "empty",
    "two",
    "wrongDate",
    "wrongPredecessor",
    "registryV1",
    "receiptV1",
    "registryUnknown",
    "receiptUnknown",
    "historicalClaim",
  ])("rejects exact v2 scope violation %s", async (kind) => {
    const { a } = await fixture();
    if (kind === "empty") a.receipt.dates = [];
    if (kind === "two") a.receipt.dates.push({ ...a.receipt.dates[0]!, date: "2026-11-04" });
    if (kind === "wrongDate") a.receipt.dates[0]!.date = "2026-11-04";
    if (kind === "wrongPredecessor") {
      a.receipt.predecessorDate = "2026-11-03";
      a.receipt.dates[0]!.date = "2026-11-04";
    }
    if (kind === "registryV1")
      Object.assign(a.registry, { version: "kr-reviewed-retrospective-registry-v1" });
    if (kind === "receiptV1")
      Object.assign(a.receipt, { version: "kr-reviewed-retrospective-source-v1" });
    if (kind === "registryUnknown")
      Object.assign(a.registry, { version: "kr-reviewed-retrospective-registry-v3" });
    if (kind === "receiptUnknown")
      Object.assign(a.receipt, { version: "kr-reviewed-retrospective-source-v3" });
    if (kind === "historicalClaim") Object.assign(a.receipt, { historicalAvailabilityClaim: true });
    await rehash(a);
    await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
  });
  it.each([
    "owner",
    "preparationHash",
    "capsuleHash",
    "captureManifestHash",
    "sourceManifestHash",
    "runtimeCodeHash",
    "preparationRuntimeCodeHash",
    "predecessorHeads",
    "dates",
  ] as const)("rejects self-rehashed %s without trusted registry authorization", async (field) => {
    const { a } = await fixture();
    if (field === "predecessorHeads") a.receipt.predecessorHeads[0]!.stateHash = OTHER;
    else if (field === "dates") a.receipt.dates[0]!.configHash = OTHER;
    else
      Object.assign(a.receipt, {
        [field]: field === "owner" ? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" : OTHER,
      });
    a.registry.receiptHash = await hashSeriesValue(a.receipt);
    await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
  });
  it.each([
    "source",
    "dataset",
    "config",
    "runtime",
    "date",
    "availableAt",
    "decisionAt",
    "actualEvidence",
  ])("binds exact replay input %s", async (field) => {
    const { a, input } = await fixture();
    if (field === "source") input.sourceHash = OTHER;
    if (field === "runtime") input.runtimeCodeHash = OTHER;
    if (field === "dataset") input.dataset.fixture = "other";
    if (field === "config") input.config.fixture = "other";
    if (field === "date") input.date = "2026-11-02";
    if (field === "availableAt") input.availableAt = "2026-11-04T07:59:00+09:00";
    if (field === "decisionAt") input.decisionAt = "2026-11-04T08:11:00+09:00";
    if (field === "actualEvidence")
      input.sourceEvidence.push({
        sourceHash: H,
        asOfDate: input.date,
        registeredAt: input.availableAt,
      });
    await expect(reviewedRetrospectiveProvenance(a, input)).rejects.toThrow();
  });
  it.each([
    "owner",
    "preparationHash",
    "capsuleHash",
    "captureManifestHash",
    "sourceManifestHash",
    "originFinalPublicationHash",
    "runtimeCodeHash",
    "preparationRuntimeCodeHash",
    "captureFinishedAt",
    "originFinalActivatedAt",
    "predecessorDate",
  ] as const)(
    "rejects malformed scalar %s even with internally consistent hashes",
    async (field) => {
      for (const value of [null, 123456, true, {}, "array"]) {
        const { a } = await fixture();
        Object.assign(a.receipt, { [field]: value === "array" ? [a.receipt[field]] : value });
        await rehash(a);
        await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
      }
    },
  );
  it.each([
    "date",
    "sourceHash",
    "datasetHash",
    "configHash",
    "evidenceStoredAt",
    "modelAvailableAt",
    "modelDecisionAt",
  ] as const)("rejects malformed date proof %s", async (field) => {
    const { a } = await fixture();
    Object.assign(a.receipt.dates[0]!, { [field]: [a.receipt.dates[0]![field]] });
    await rehash(a);
    await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
  });
  it.each(["missing", "duplicate", "unknownBook", "arrayBook", "arrayHash", "extra", "notArray"])(
    "rejects malformed predecessor scope %s",
    async (kind) => {
      const { a } = await fixture();
      if (kind === "missing") a.receipt.predecessorHeads.pop();
      if (kind === "duplicate") a.receipt.predecessorHeads[1] = a.receipt.predecessorHeads[0]!;
      if (kind === "unknownBook") a.receipt.predecessorHeads[0]!.bookId += "_OTHER";
      if (kind === "arrayBook")
        Object.assign(a.receipt.predecessorHeads[0]!, {
          bookId: [a.receipt.predecessorHeads[0]!.bookId],
        });
      if (kind === "arrayHash") Object.assign(a.receipt.predecessorHeads[0]!, { stateHash: [H] });
      if (kind === "extra") Object.assign(a.receipt.predecessorHeads[0]!, { wildcard: true });
      if (kind === "notArray") Object.assign(a.receipt, { predecessorHeads: {} });
      await rehash(a);
      await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
    },
  );
});

it.each([
  "captureBeforeActivation",
  "evidenceBeforeCapture",
  "evidenceAtDecision",
  "availableAfterDecision",
  "invalidCapture",
  "extraReceipt",
  "extraDate",
  "extraRegistry",
  "unapproved",
  "wrongPolicy",
  "datesObject",
  "nullDate",
])("fails closed on retrospective chronology or malformed scope: %s", async (kind) => {
  const { a } = await fixture();
  const d = a.receipt.dates[0]!;
  if (kind === "captureBeforeActivation") a.receipt.captureFinishedAt = "2026-11-04T00:00:00Z";
  if (kind === "evidenceBeforeCapture") d.evidenceStoredAt = "2026-11-04T02:59:59Z";
  if (kind === "evidenceAtDecision") d.evidenceStoredAt = d.modelDecisionAt;
  if (kind === "availableAfterDecision") d.modelAvailableAt = "2026-11-04T08:11:00+09:00";
  if (kind === "invalidCapture") a.receipt.captureFinishedAt = "invalid";
  if (kind === "extraReceipt") Object.assign(a.receipt, { wildcard: true });
  if (kind === "extraDate") Object.assign(d, { wildcard: true });
  if (kind === "extraRegistry") Object.assign(a.registry, { wildcard: true });
  if (kind === "unapproved") Object.assign(a.registry, { status: "PENDING" });
  if (kind === "wrongPolicy") Object.assign(a.registry, { policy: "ALLOW_HISTORY_REWRITE" });
  if (kind === "datesObject") Object.assign(a.receipt, { dates: { 0: d, length: 1 } });
  if (kind === "nullDate") Object.assign(a.receipt, { dates: [null] });
  await rehash(a);
  await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
});

it.each([0, 1, 3])("keeps v1's original two-date requirement, rejects %s dates", async (length) => {
  const { a } = await fixture(false);
  while (a.receipt.dates.length > length) a.receipt.dates.pop();
  if (length === 3) a.receipt.dates.push({ ...a.receipt.dates[1]!, date: "2026-10-28" });
  await rehash(a);
  await expect(verifyKrRetrospectiveAuthority(a)).rejects.toThrow();
});
