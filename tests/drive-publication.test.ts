import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { drivePublicationSources } from "../src/lib/driveResultPublication";
import { driveFixture } from "./drive-publication-fixture";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
describe("explicit Drive cache provenance", () => {
  test("legacy registered source identity stays unchanged", async () => {
    const registered = [{ id: "a", data_hash: "d", schema_hash: "s", activated_at: null }];
    expect(await drivePublicationSources(undefined, registered, "base", "2026-10-06")).toBe(
      registered,
    );
  });
  test("bound manifest and ordered Drive generations extend rather than replace the base", async () => {
    const proof = driveFixture();
    const registered = [{ id: "a", data_hash: "d", schema_hash: "s", activated_at: null }];
    const result = await drivePublicationSources(
      proof,
      registered,
      proof.baseFingerprint,
      proof.asOfDate,
      proof.phase,
    );
    expect(result.map((r) => r.id)).toEqual(["a", proof.sources[0]!.record.id]);
  });
  test.each([
    "baseline",
    "date",
    "phase",
    "hash",
    "size",
    "path",
    "duplicate",
    "manifest",
  ] as const)("rejects %s drift", async (kind) => {
    const p = driveFixture();
    const s = p.sources[0]!;
    if (kind === "baseline") p.baseFingerprint = sha("changed");
    if (kind === "date") p.asOfDate = "2026-10-07";
    if (kind === "phase") p.phase = "FINAL";
    if (kind === "hash") s.record.file_hash = "sha256:" + sha("changed");
    if (kind === "size") s.record.file_size_bytes++;
    if (kind === "path") s.record.storage_path = "drive://different/input.csv";
    if (kind === "duplicate") p.sources.push(s);
    if (kind === "manifest") s.record.validation_result.krPublication.manifestText += " ";
    await expect(
      drivePublicationSources(p, [], sha("base"), "2026-10-06", "PRELIMINARY"),
    ).rejects.toThrow();
  });
});

test("Drive generations reject an old dashboard or altered proof", async () => {
  const { currentDriveGeneration, krResultPhase } =
    await import("../src/lib/driveResultPublication");
  const cache = {
    publicationId: "A",
    inputFingerprint: "input",
    resultDigest: "digest",
    drivePublication: driveFixture(),
  };
  const head = { version: "drive-input-head-v1", ...cache };
  expect(currentDriveGeneration(head, cache)).toBe(true);
  expect(currentDriveGeneration({ ...head, publicationId: "B" }, cache)).toBe(false);
  expect(
    currentDriveGeneration(head, {
      ...cache,
      drivePublication: { ...cache.drivePublication, asOfDate: "2026-10-07" },
    }),
  ).toBe(false);
  expect(krResultPhase({})).toBe("FINAL");
});
