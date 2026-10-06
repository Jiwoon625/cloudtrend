import { describe, expect, it } from "vitest";
import { freezeAdoptedSeries, guardModelRun, hashSeriesValue } from "./modelSeries";
import {
  modelJournalPath,
  persistModelRun,
  type ImmutableModelStore,
  type ModelJournalRun,
} from "./modelJournal";
const h = `sha256:${"a".repeat(64)}` as const;
const uid = "00000000-0000-0000-0000-000000000001";
function store() {
  const objects = new Map<string, unknown>();
  const adapter: ImmutableModelStore = {
    withSeriesLock: async (_key, action) => action(),
    read: async <T>(path: string) =>
      objects.has(path) ? (structuredClone(objects.get(path)) as T) : null,
    putImmutable: async (path, value) => {
      if (objects.has(path)) throw new Error("Already exists");
      objects.set(path, structuredClone(value));
    },
    latestSessionDate: async (path) =>
      [...objects.keys()]
        .filter((k) => k.startsWith(`${path}/`))
        .map((k) => k.split("/").at(-1)!.slice(0, 10))
        .sort()
        .at(-1) ?? null,
  };
  return { adapter, objects };
}
describe("private immutable model journal", () => {
  it("inserts, verifies and idempotently reuses runs without overwriting or resetting", async () => {
    const series = await freezeAdoptedSeries({
      kind: "KR_KOSDAQ",
      codeHash: h,
      sourceHash: h,
      frozenAt: "2026-10-02T12:00:00Z",
    });
    const { receipt } = await guardModelRun(series, {
      date: "2026-10-06",
      codeHash: h,
      configHash: series.configHash,
      sourceHash: h,
    });
    const body = {
      book: "MODEL" as const,
      bookId: series.bookId,
      contractHash: series.contractHash,
      receipt,
      previousStateHash: null,
    };
    const run: ModelJournalRun = { ...body, stateHash: await hashSeriesValue(body) };
    const { adapter, objects } = store();
    expect((await persistModelRun(adapter, uid, series, run, null)).reused).toBe(false);
    expect((await persistModelRun(adapter, uid, series, run, null)).reused).toBe(true);
    expect(objects.size).toBe(2);
    const invalidBody = {
      ...body,
      receipt: {
        ...receipt,
        codeHash: `sha256:${"b".repeat(64)}` as const,
        configHash: `sha256:${"b".repeat(64)}` as const,
        runHash: `sha256:${"b".repeat(64)}` as const,
      },
    };
    await expect(
      persistModelRun(
        store().adapter,
        uid,
        series,
        { ...invalidBody, stateHash: await hashSeriesValue(invalidBody) },
        null,
      ),
    ).rejects.toThrow("Frozen code/config");
    const secondBody = {
      ...body,
      receipt: (
        await guardModelRun(series, {
          date: "2026-10-07",
          codeHash: h,
          configHash: series.configHash,
          sourceHash: h,
        })
      ).receipt,
      previousStateHash: run.stateHash,
    };
    const second = { ...secondBody, stateHash: await hashSeriesValue(secondBody) };
    await expect(persistModelRun(adapter, uid, series, second, null)).rejects.toThrow(
      "Cannot reset",
    );
    expect((await persistModelRun(adapter, uid, series, second, run)).reused).toBe(false);
    expect(objects.size).toBe(3);
    await expect(
      persistModelRun(
        adapter,
        uid,
        series,
        { ...run, stateHash: `sha256:${"b".repeat(64)}` },
        null,
      ),
    ).rejects.toThrow("integrity");
  });
  it("rejects arbitrary paths, actual books and historical alternative namespaces", () => {
    expect(() => modelJournalPath(uid, "ACTUAL", "registry.json")).toThrow();
    expect(() =>
      modelJournalPath(uid, "adopted-shadow-2026-10-12-v2:US_A0", "../../secret"),
    ).toThrow();
  });
});
