import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  type KospiShadowRow,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../../src/lib/engine/kospiShadow";
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  shadowObjectPath,
  type ShadowObjectStore,
} from "../../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  initializeKospiShadowRevision,
} from "../../src/lib/kospiShadowSeries";
export const SHADOW_TEST_UID = "00000000-0000-0000-0000-000000000001";
export const SHADOW_TEST_ROOT = `${SHADOW_TEST_UID}/${KOSPI_SHADOW_NAMESPACE}`;
export const SHADOW_TEST_REVISION_ROOT = `${SHADOW_TEST_ROOT}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
export const SHADOW_TEST_COMPUTED_AT = "2026-10-15T00:10:00Z";
export async function createShadowRevisionFixture() {
  const data = new Map<string, unknown>();
  const read = async <T>(path: string): Promise<T | null> =>
    structuredClone(data.get(path) ?? null) as T | null;
  const store: ShadowObjectStore = {
    read,
    latestSessionDate: async (namespace) => {
      const prefix = `${namespace}/`;
      return (
        [...data.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          .filter((suffix) => /^\d{4}-\d{2}-\d{2}\.json$/.test(suffix))
          .map((suffix) => suffix.slice(0, -5))
          .sort()
          .at(-1) ?? null
      );
    },
    putImmutable: async (path, value) => {
      if (data.has(path)) throw new Error(`immutable collision: ${path}`);
      data.set(path, structuredClone(value));
    },
    putLatest: async (path, value) => {
      data.set(path, structuredClone(value));
    },
  };
  const config = { fixture: "shadow-cloud-ui-synthetic", version: 1 };
  const configHash = await hashSeriesValue(config);
  const makeRow = (date: string, symbol: string, score: number): KospiShadowRow => ({
    date,
    symbol,
    name: `Synthetic ${symbol}`,
    sector: symbol,
    open: 100,
    close: 100,
    volume: 1000,
    score,
    priority: 1,
    rsAccel: 1,
    commonHistory: true,
    onsetEligible: true,
  });
  const makeSession = async (
    date: string,
    previousSessionDate: string,
    heldScore: number,
    onsetScore = 7,
  ): Promise<KospiShadowSession> => ({
    date,
    previousSessionDate,
    sourceHash: await hashSeriesValue({ fixture: "cloud-ui", date, heldScore, onsetScore }),
    configHash,
    codeVersion: "synthetic-code-v1",
    sourceCollectedAt: `${date}T08:00:00Z`,
    confirmedClose: true,
    benchmarkClose: 2500,
    gate: { date, status: "NEUTRAL", issues: [] },
    rows: [makeRow(date, "TEST_HELD", heldScore), makeRow(date, "TEST_NEW", onsetScore)],
  });
  const dates = [
    "2026-10-02",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-12",
    "2026-10-13",
  ];
  let previous = "2026-10-01";
  for (const [index, date] of dates.entries()) {
    await persistKospiShadow(
      store,
      SHADOW_TEST_UID,
      await makeSession(date, previous, index === 0 ? 7 : index === 1 ? 8 : 8.5),
      config,
    );
    previous = date;
  }
  const predecessor = await read<KospiShadowSnapshot>(
    shadowObjectPath(SHADOW_TEST_UID, "sessions/2026-10-13.json"),
  );
  if (!predecessor) throw new Error("synthetic predecessor missing");
  const original = (
    await persistKospiShadow(
      store,
      SHADOW_TEST_UID,
      await makeSession("2026-10-14", "2026-10-13", 8.5),
      config,
    )
  ).view;
  const corrected = await makeSession("2026-10-14", "2026-10-13", 8.5, 8);
  corrected.sourceCollectedAt = "2026-10-15T00:00:00Z";
  const approval = {
    revisionId: KOSPI_SHADOW_CORRECTION_REVISION_ID,
    predecessorDate: "2026-10-13" as const,
    correctionDate: "2026-10-14" as const,
    expectedPredecessorHash: await hashSeriesValue(predecessor),
    expectedOriginalTargetHash: await hashSeriesValue(original.latest),
    expectedCorrectedSourceHash: corrected.sourceHash,
    computedAt: SHADOW_TEST_COMPUTED_AT,
  };
  const correctedView = (
    await initializeKospiShadowRevision(store, SHADOW_TEST_UID, corrected, config, approval)
  ).view;
  const bytes = () => JSON.stringify([...data.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return { data, read, store, original, correctedView, predecessor, corrected, approval, bytes };
}
