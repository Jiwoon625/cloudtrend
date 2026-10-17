import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const state = vi.hoisted(() => ({ receipts: [false, false], reads: 0 }));
vi.mock("../src/lib/operationalUnderlyingIndexRelease", () => ({
  OPERATIONAL_INDEX_ENABLED: true,
}));
vi.mock("../src/lib/operationalIndexInstallation.server", () => ({
  hasOperationalIndexInstallation: async () => state.receipts[state.reads++] ?? false,
}));
vi.mock("../src/lib/underlyingIndexDiagnostics.server", async (original) => ({
  ...(await original<typeof import("../src/lib/underlyingIndexDiagnostics.server")>()),
  readArtifactText: async () => null,
}));
import { operationalArtifactForPublication } from "../src/lib/operationalUnderlyingIndex.server";
beforeEach(() => {
  state.receipts = [false, false];
  state.reads = 0;
});
describe("installation receipt race", () => {
  it("rechecks a missing receipt after absent artifact before selecting legacy", async () => {
    expect(
      await operationalArtifactForPublication(
        {} as SupabaseClient,
        "owner",
        "2026-10-19",
        "2026-10-19T00:00:00Z",
      ),
    ).toBeUndefined();
    expect(state.reads).toBe(2);
  });
  it("blocks a receipt-first installation appearing between absent reads", async () => {
    state.receipts = [false, true];
    await expect(
      operationalArtifactForPublication(
        {} as SupabaseClient,
        "owner",
        "2026-10-19",
        "2026-10-19T00:00:00Z",
      ),
    ).rejects.toThrow("설치가 시작");
    expect(state.reads).toBe(2);
  });
});
