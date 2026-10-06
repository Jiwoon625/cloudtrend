import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyOctoberShadowInitialization,
  planOctoberShadowInitialization,
  runOctoberShadowInitialization,
} from "../../../scripts/initialize-october-shadow";
import {
  canonicalSeriesJson,
  freezeAdoptedSeries,
  hashSeriesValue,
  initializeModelSeries,
  type FrozenModelSeries,
} from "./modelSeries";
import { octoberShadowStore, type OctoberShadowStore } from "./octoberShadowRepository.server";

vi.mock("../../../scripts/analysis-run-store", () => ({
  trustedSupabaseClient: () => ({ localTestOnly: true }),
}));
vi.mock("./octoberShadowRepository.server", () => ({ octoberShadowStore: vi.fn() }));

vi.mock("../../../scripts/october-shadow-code-manifest", () => ({
  adoptedShadowFrozenCodeHash: () => `sha256:${"a".repeat(64)}`,
  shadowEngineManifest: async () => ({
    codeHash: `sha256:${"b".repeat(64)}`,
    manifest: { version: "test-local-manifest", files: {} },
  }),
}));

function fixture() {
  const registry = new Map<string, FrozenModelSeries>();
  let writes = 0;
  let failAt: number | null = null;
  let corruptReadback = false;
  const store: Pick<OctoberShadowStore, "readSeries" | "insertSeries"> = {
    async readSeries(id) {
      const saved = registry.get(id);
      if (!saved) return null;
      const readback = structuredClone(saved);
      if (corruptReadback && registry.size === 8)
        readback.contractHash = `sha256:${"f".repeat(64)}`;
      return readback;
    },
    async insertSeries(series) {
      writes++;
      if (writes === failAt) throw new Error("Simulated initialization interruption");
      const existing = registry.get(series.bookId);
      if (existing && canonicalSeriesJson(existing) !== canonicalSeriesJson(series))
        throw new Error("Immutable test registry conflict");
      if (!existing) registry.set(series.bookId, structuredClone(series));
    },
  };
  return {
    store,
    registry,
    failAt: (at: number | null) => {
      failAt = at;
    },
    corruptReadback: () => {
      corruptReadback = true;
    },
  };
}

describe("October initialization verified-result audit artifact", () => {
  it("reports exact persisted contracts and opening states after interruption and a later retry", async () => {
    const f = fixture();
    const firstPlan = await planOctoberShadowInitialization("2026-10-03T00:00:00Z");
    const originalPlan = structuredClone(firstPlan);
    f.failAt(3);
    await expect(applyOctoberShadowInitialization(firstPlan, f.store)).rejects.toThrow(
      "interruption",
    );
    expect(f.registry.size).toBe(2);
    const alreadySaved = [...f.registry.values()].map((series) => structuredClone(series));
    const retryPlan = await planOctoberShadowInitialization("2026-10-03T01:00:00Z");
    f.failAt(null);
    const result = await applyOctoberShadowInitialization(retryPlan, f.store);
    expect(result.artifact).toBe("VERIFIED_REGISTRY_READBACK");
    expect(result.planHash).toBe(
      await hashSeriesValue({ artifact: "INITIALIZATION_PLAN", ...retryPlan }),
    );
    expect(result.reusedBookIds).toEqual(alreadySaved.map((series) => series.bookId));
    expect(result.sessionsInserted).toBe(0);
    expect(result.series).toEqual([...f.registry.values()]);
    expect(result.series.slice(0, 2)).toEqual(alreadySaved);
    expect(result.reusedContracts).toEqual(
      alreadySaved.map(({ bookId, contractHash, frozenAt }) => ({
        bookId,
        contractHash,
        frozenAt,
      })),
    );
    expect(
      result.series
        .slice(0, 2)
        .every((series) => series.frozenAt === firstPlan.series[0]!.frozenAt),
    ).toBe(true);
    expect(
      result.series.slice(2).every((series) => series.frozenAt === retryPlan.series[0]!.frozenAt),
    ).toBe(true);
    expect(result.series[0]!.contractHash).not.toBe(retryPlan.series[0]!.contractHash);
    expect(result.openingStates).toEqual(result.series.map(initializeModelSeries));
    expect(result.openingStates[0]!.contractHash).toBe(alreadySaved[0]!.contractHash);
    expect(firstPlan).toEqual(originalPlan);
    const subsequentPlan = await planOctoberShadowInitialization("2026-10-03T02:00:00Z");
    const secondRetry = await applyOctoberShadowInitialization(subsequentPlan, f.store);
    expect(secondRetry.series).toEqual(result.series);
    expect(secondRetry.reusedBookIds).toEqual(result.series.map((series) => series.bookId));
    expect(secondRetry.reusedContracts).toHaveLength(8);
  });

  it("never returns a verified-success result for missing or tampered final registry readback", async () => {
    const plan = await planOctoberShadowInitialization("2026-10-03T00:00:00Z");
    const f = fixture();
    f.corruptReadback();
    await expect(applyOctoberShadowInitialization(plan, f.store)).rejects.toThrow("mismatch");
    const missing = fixture();
    const originalRead = missing.store.readSeries;
    missing.store.readSeries = async (id) =>
      missing.registry.size === 8 ? null : originalRead(id);
    await expect(applyOctoberShadowInitialization(plan, missing.store)).rejects.toThrow(
      "readback is missing",
    );
  });

  it("refuses incomplete plans and rejects incompatible contracts on a retry", async () => {
    const plan = await planOctoberShadowInitialization("2026-10-03T00:00:00Z");
    const f = fixture();
    await expect(
      applyOctoberShadowInitialization({ ...plan, series: plan.series.slice(1) }, f.store),
    ).rejects.toThrow("complete ordered");
    expect(f.registry.size).toBe(0);
    expect((await applyOctoberShadowInitialization(plan, f.store)).reusedBookIds).toEqual([]);
    const changed = structuredClone(plan);
    changed.series[0] = await freezeAdoptedSeries({
      kind: changed.series[0]!.policy.kind,
      frozenAt: "2026-10-03T01:00:00Z",
      codeHash: changed.series[0]!.codeHash,
      sourceHash: `sha256:${"c".repeat(64)}`,
    });
    await expect(applyOctoberShadowInitialization(changed, f.store)).rejects.toThrow("immutable");
    expect([...f.registry.values()]).toEqual(plan.series);
  });
});

it("writes distinct private plan and exact verified-result files on a local simulated apply retry", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "october-initialization-test-"));
  const f = fixture();
  vi.mocked(octoberShadowStore).mockReturnValue(f.store as OctoberShadowStore);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  const uid = "00000000-0000-0000-0000-000000000001";
  try {
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    f.failAt(3);
    const firstFolder = path.join(folder, "interrupted");
    await expect(
      runOctoberShadowInitialization(["--output", firstFolder, "--apply", "--user", uid]),
    ).rejects.toThrow("interruption");
    expect(
      JSON.parse(
        await readFile(path.join(firstFolder, "october-shadow-initialization.json"), "utf8"),
      ).artifact,
    ).toBe("INITIALIZATION_PLAN");
    await expect(
      readFile(path.join(firstFolder, "october-shadow-initialization-verified.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(log).not.toHaveBeenCalled();
    f.failAt(null);
    vi.setSystemTime(new Date("2026-10-03T01:00:00Z"));
    const retryFolder = path.join(folder, "retry");
    await runOctoberShadowInitialization(["--output", retryFolder, "--apply", "--user", uid]);
    const planPath = path.join(retryFolder, "october-shadow-initialization.json");
    const resultPath = path.join(retryFolder, "october-shadow-initialization-verified.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(plan.artifact).toBe("INITIALIZATION_PLAN");
    expect(result.artifact).toBe("VERIFIED_REGISTRY_READBACK");
    expect(result.ownerId).toBe(uid);
    expect(result.series).toEqual([...f.registry.values()]);
    expect(result.reusedContracts).toHaveLength(2);
    expect(result.reusedBookIds).toEqual(
      result.series.slice(0, 2).map((series: FrozenModelSeries) => series.bookId),
    );
    expect(result.planHash).toBe(await hashSeriesValue(plan));
    expect(result.series[0].contractHash).not.toBe(plan.series[0].contractHash);
    expect(result.openingStates).toEqual(result.series.map(initializeModelSeries));
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      initialized: true,
      planArtifact: planPath,
      verifiedArtifact: resultPath,
      sessionsInserted: 0,
    });
  } finally {
    vi.useRealTimers();
    log.mockRestore();
    await rm(folder, { recursive: true, force: true });
  }
});
