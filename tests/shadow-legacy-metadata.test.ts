import { describe, expect, it, vi } from "vitest";
import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiShadowSession,
} from "../src/lib/engine/kospiShadow";
import {
  persistKospiShadow,
  shadowObjectPath,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import { loadKospiShadow } from "../src/lib/kospiShadowCloud";
import { readObject } from "../src/lib/cloud";

vi.mock("../src/lib/cloud", () => ({
  ownerPath: async (suffix: string) => `11111111-1111-4111-8111-111111111111/${suffix}`,
  readObject: vi.fn(),
}));

const uid = "11111111-1111-4111-8111-111111111111";
const session: KospiShadowSession = {
  date: "2026-10-02",
  previousSessionDate: "2026-10-01",
  sourceHash: "synthetic-source",
  configHash: "synthetic-config",
  codeVersion: "historical-code",
  sourceCollectedAt: "2026-10-02T08:00:00Z",
  confirmedClose: true,
  benchmarkClose: 2500,
  gate: { date: "2026-10-02", status: "NEUTRAL", issues: [] },
  rows: [],
};

function historicalFixture() {
  const snapshot = stepKospiShadow(session, null);
  // An opaque synthetic value tests preservation without publishing a private resource link.
  const latest = {
    ...snapshot,
    policy: { ...snapshot.policy, researchReference: "synthetic-private-provenance" },
  };
  const view: KospiShadowView = {
    schemaVersion: 1,
    registry: {
      strategyId: snapshot.policy.id,
      ruleVersion: snapshot.policy.version,
      initializedDate: session.date,
      configHash: session.configHash,
      config: {},
      initialSourceHash: session.sourceHash,
      initialCodeVersion: session.codeVersion,
    },
    latest,
    history: [snapshot.daily],
    recentTrades: [],
    tradeHistoryTruncated: false,
  };
  return { view, latest };
}

describe("historical optional research metadata compatibility", () => {
  it("reads the original immutable payload without deleting optional metadata", async () => {
    const { view } = historicalFixture();
    const original = JSON.stringify(view);
    vi.mocked(readObject).mockResolvedValue(structuredClone(view));
    expect(KOSPI_SHADOW_POLICY).not.toHaveProperty("researchReference");
    expect(await loadKospiShadow()).toEqual(view);
    expect(JSON.stringify(view)).toBe(original);
  });

  it("reuses a historical session containing extra provenance without rewriting any object", async () => {
    const { view, latest } = historicalFixture();
    const data = new Map<string, unknown>([
      [shadowObjectPath(uid, "registry.json"), view.registry],
      [shadowObjectPath(uid, "latest.json"), view],
      [shadowObjectPath(uid, `sessions/${session.date}.json`), latest],
    ]);
    const before = JSON.stringify([...data]);
    const putImmutable = vi.fn(),
      putLatest = vi.fn();
    const store: ShadowObjectStore = {
      read: async <T>(path: string) => structuredClone(data.get(path) ?? null) as T | null,
      latestSessionDate: async () => session.date,
      putImmutable,
      putLatest,
    };
    const result = await persistKospiShadow(store, uid, session, {});
    expect(result).toEqual({ reused: true, view });
    expect(putImmutable).not.toHaveBeenCalled();
    expect(putLatest).not.toHaveBeenCalled();
    expect(JSON.stringify([...data])).toBe(before);
  });
});
