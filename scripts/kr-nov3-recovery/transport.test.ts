/* eslint-disable @typescript-eslint/no-explicit-any -- malformed transport fixtures */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("../../src/lib/krScreeningPublication", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/krScreeningPublication")>()),
  krSourcePublication: (r: any) => r.__publication,
}));
import {
  assertKrNov3Workflow,
  KR_NOV3_WORKFLOW,
  assertExactThirdRows,
  readKrNov3Evidence,
} from "./transport";
import { extractUnisonRawEvidence, buildKrCompanionCapture, saveKrPrivate } from "./entry";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const owner = "11111111-1111-4111-8111-111111111111";
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW: KR_NOV3_WORKFLOW,
  RECOVERY_CONCURRENCY_GROUP: "kospi-prospective-shadow",
  GITHUB_SHA: "a".repeat(40),
};
it("only exact manual main/concurrency workflow can authorize execution", () => {
  expect(() => assertKrNov3Workflow(env)).not.toThrow();
  for (const key of Object.keys(env))
    expect(() => assertKrNov3Workflow({ ...env, [key]: "invalid" })).toThrow();
});
it("shared KOSPI workflow may archive PLAN only, never authorize or APPLY", () => {
  const sibling = { ...env, GITHUB_WORKFLOW: "KOSPI Nov3 reviewed recovery" };
  expect(() => assertKrNov3Workflow(sibling, true)).not.toThrow();
  expect(() => assertKrNov3Workflow(sibling)).toThrow();
  expect(() =>
    assertKrNov3Workflow(
      { ...sibling, GITHUB_WORKFLOW: "KOSPI November 3 reviewed recovery" },
      true,
    ),
  ).toThrow();
});
function rawFixture() {
  const csv =
    "symbol,date,shortSellingVolume,tradingValueSource,investorValueSource\n" +
    ["2026-10-12", "2026-10-13", "2026-10-14"]
      .map((d) => `018000,${d},70814,CLOSE_X_VOLUME_PROXY,TOSS_NET_VOLUME_X_CLOSE_PROXY`)
      .join("\n");
  const row = {
    id: owner,
    storage_path: owner + "/source/screening/test.csv",
    file_hash: hash("raw"),
    __publication: { phase: "FINAL", asOfDate: "2026-11-03" },
  };
  const pin = { path: row.storage_path, hash: row.file_hash, generation: { version: "original" } };
  const c = {
    sourceRows: [row],
    sourceObjectPins: [pin],
    selectedFinalSourceRow: row,
    selectedFinalSourcePin: pin,
    sourceObjects: [
      {
        id: row.id,
        path: row.storage_path,
        storedHash: row.file_hash,
        generation: pin.generation,
        canonicalHash: hash(csv),
      },
    ],
  };
  return { csv, c };
}
it("extracts only three exact raw observations from the selected validated canonical bytes", () => {
  const { c, csv } = rawFixture(),
    e = extractUnisonRawEvidence(c, csv);
  expect(e.sourceId).toBe(owner);
  expect(e.sourceHash).toBe(c.selectedFinalSourceRow.file_hash);
  expect(e.rows).toHaveLength(3);
  expect(e.rows[0]).toMatchObject({
    symbol: "018000",
    shortSellingVolume: 70814,
    tradingValueSource: "CLOSE_X_VOLUME_PROXY",
  });
});
it.each(["csv", "selection", "pin", "canonical", "duplicates", "missing", "numerator"])(
  "rejects raw evidence %s mismatch",
  (kind) => {
    const f = rawFixture();
    let csv = f.csv;
    if (kind === "csv") csv += "\n";
    if (kind === "selection")
      f.c.selectedFinalSourceRow = { ...f.c.selectedFinalSourceRow, id: "another" };
    if (kind === "pin")
      f.c.selectedFinalSourcePin = { ...f.c.selectedFinalSourcePin, hash: hash("wrong") };
    if (kind === "canonical") f.c.sourceObjects[0]!.canonicalHash = hash("wrong");
    if (kind === "duplicates") csv += "\n" + csv.split("\n")[1];
    if (kind === "missing") csv = csv.split("\n").slice(0, -1).join("\n");
    if (kind === "numerator") csv = csv.replaceAll("70814", "70814.5");
    if (["duplicates", "missing", "numerator"].includes(kind))
      f.c.sourceObjects[0]!.canonicalHash = hash(csv);
    expect(() => extractUnisonRawEvidence(f.c, csv)).toThrow();
  },
);
it("capture rejects coerced owner/code and inventory before processing datasets", async () => {
  for (const c of [
    {},
    {
      version: "kospi-nov3-readonly-capture-v1",
      owner: [owner],
      codeVersion: "a".repeat(40),
      historicalAvailabilityClaim: false,
    },
    {
      version: "kospi-nov3-readonly-capture-v1",
      owner,
      codeVersion: ["a".repeat(40)],
      historicalAvailabilityClaim: false,
    },
  ])
    await expect(buildKrCompanionCapture(c, {} as any, {} as any)).rejects.toThrow();
});
it("private files are exclusive mode0600 and cannot overwrite previous evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-nov3-test-")),
    file = path.join(dir, "proof.json");
  try {
    saveKrPrivate(file, { bound: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => saveKrPrivate(file, { bound: false })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ bound: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("independent authority requires exactly one receipt and one registry, preserving null historical clocks", () => {
  const candidate = {
    receipt: { reviewId: "reviewed-kr-vintage-v3" },
    registry: { reviewId: "reviewed-kr-vintage-v3" },
  } as any;
  const rows = ["krSourceVintageReview", "krSourceVintageApproval"].map((key) => ({
    source_hash: hash(
      JSON.stringify(key.endsWith("Review") ? candidate.receipt : candidate.registry),
    ),
    market: "KR",
    strategy_version: "reviewed-kr-vintage-v3",
    signal_date: "2026-11-03",
    replay_mode: "RETROSPECTIVE",
    model_available_at: null,
    model_decision_at: null,
    execution_at: null,
    details: { [key]: key.endsWith("Review") ? candidate.receipt : candidate.registry },
  }));
  expect(assertExactThirdRows(rows, candidate, false).size).toBe(2);
  expect(() => assertExactThirdRows(rows.slice(0, 1), candidate, false)).toThrow();
  expect(assertExactThirdRows(rows.slice(0, 1), candidate, true).size).toBe(1);
  expect(() => assertExactThirdRows([rows[0], rows[0]], candidate, true)).toThrow();
  expect(() =>
    assertExactThirdRows(
      [{ ...rows[0], model_available_at: "2026-11-03" }, rows[1]],
      candidate,
      false,
    ),
  ).toThrow();
  expect(() =>
    assertExactThirdRows(
      [{ ...rows[0], details: { ...rows[0]!.details, extra: true } }, rows[1]],
      candidate,
      false,
    ),
  ).toThrow();
});
it("blocked diagnosis is not an admissible approval or plan evidence type", async () => {
  const fetcher = vi.fn();
  await expect(
    readKrNov3Evidence(
      { owner, origin: "https://example.supabase.co", key: "test", fetcher },
      hash("x"),
      "kr-nov3-recovery-blocked-v1",
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
