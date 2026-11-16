import { afterEach, expect, it, vi } from "vitest";
import { installDriveReadOnlyNetwork } from "../scripts/drive-history-network";
import { krDataStatusObjectPath, krDataStatusPointerPath } from "../src/lib/dataStatusPublication";
const original = globalThis.fetch;
const owner = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const base = "https://example.supabase.co/storage/v1/object/cloudtrend-data/";
afterEach(() => {
  globalThis.fetch = original;
});
it("permits both exact status objects after explicit generation authorization", async () => {
  const transport = vi.fn(async () => new Response("{}"));
  globalThis.fetch = transport;
  const boundary = installDriveReadOnlyNetwork();
  boundary.enableResultWrites(owner, "run-test-20261116", generation);
  for (const path of [krDataStatusObjectPath(owner, generation), krDataStatusPointerPath(owner)])
    await expect(fetch(base + path, { method: "POST" })).resolves.toBeInstanceOf(Response);
  expect(transport).toHaveBeenCalledTimes(2);
});
it("denies other owners/generations, mutation methods, and clears old grants", async () => {
  const transport = vi.fn(async () => new Response("{}"));
  globalThis.fetch = transport;
  const boundary = installDriveReadOnlyNetwork();
  boundary.enableResultWrites(owner, "run-test-20261116", generation);
  for (const path of [
    krDataStatusObjectPath(owner, owner),
    krDataStatusObjectPath(generation, generation),
    krDataStatusPointerPath(generation),
    `${owner}/cache/data-status/other.json`,
  ])
    await expect(fetch(base + path, { method: "POST" })).rejects.toThrow("supabase-write");
  for (const method of ["DELETE", "PATCH"])
    await expect(fetch(base + krDataStatusPointerPath(owner), { method })).rejects.toThrow(
      "supabase-write",
    );
  boundary.enableResultWrites(owner, "replacement-run");
  for (const path of [krDataStatusObjectPath(owner, generation), krDataStatusPointerPath(owner)])
    await expect(fetch(base + path, { method: "PUT" })).rejects.toThrow("supabase-write");
  expect(transport).not.toHaveBeenCalled();
});
it("rejects malformed generation without allowing path injection", () => {
  globalThis.fetch = vi.fn(async () => new Response("{}"));
  const boundary = installDriveReadOnlyNetwork();
  expect(() => boundary.enableResultWrites(owner, "run-test-20261116", "../other")).toThrow(
    "Invalid result publication identity",
  );
});
