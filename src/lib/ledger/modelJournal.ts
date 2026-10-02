import {
  assertModelSeriesIsolation,
  guardModelRun,
  hashSeriesValue,
  verifyFrozenSeries,
  type FrozenModelSeries,
  type ModelRunReceipt,
  type SeriesHash,
} from "./modelSeries";
export interface ModelJournalRun {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  receipt: ModelRunReceipt;
  previousStateHash: SeriesHash | null;
  stateHash: SeriesHash;
}
export interface ImmutableModelStore {
  /** Must be a cross-process exclusive lease/transaction, not a process-local mutex in production. */
  withSeriesLock<T>(key: string, action: () => Promise<T>): Promise<T>;
  read<T>(path: string): Promise<T | null>;
  /** Must implement atomic insert-if-absent; collision must read/compare or fail, never overwrite. */
  putImmutable(path: string, value: unknown): Promise<void>;
  latestSessionDate(path: string): Promise<string | null>;
}
export function modelJournalPath(userId: string, seriesId: string, suffix: string) {
  if (
    !/^[a-f\d-]{36}$/i.test(userId) ||
    !/^adopted-shadow-2026-10-05-v1:(KR_MIXED|KR_KOSPI|KR_KOSDAQ|US_A0|ETF_V02)$/.test(seriesId) ||
    !/^(registry\.json|sessions|sessions\/\d{4}-\d{2}-\d{2}\.json)$/.test(suffix)
  )
    throw new Error("Invalid private model journal path");
  return `${userId}/ledger-models/${encodeURIComponent(seriesId)}/${suffix}`;
}
/** Durable append, with no mutable latest pointer or history pruning. */
async function persistLockedModelRun<T extends ModelJournalRun>(
  store: ImmutableModelStore,
  userId: string,
  series: FrozenModelSeries,
  run: T,
  previous: T | null,
): Promise<{ reused: boolean; run: T }> {
  await verifyFrozenSeries(series);
  assertModelSeriesIsolation(series, run);
  if (run.receipt.book !== "MODEL") throw new Error("Invalid model receipt book");
  await guardModelRun(series, run.receipt, run.receipt);
  const { stateHash, ...body } = run;
  if (
    (await hashSeriesValue(body)) !== stateHash ||
    run.receipt.contractHash !== series.contractHash ||
    run.receipt.bookId !== series.bookId ||
    run.receipt.date < series.accountingStartDate
  )
    throw new Error("Model run integrity mismatch");
  const path = (suffix: string) => modelJournalPath(userId, series.bookId, suffix);
  const registry = await store.read<FrozenModelSeries>(path("registry.json"));
  if (registry && (await hashSeriesValue(registry)) !== (await hashSeriesValue(series)))
    throw new Error("Existing model registry cannot be overwritten");
  const existing = await store.read<T>(path(`sessions/${run.receipt.date}.json`));
  if (existing) {
    if (!registry || (await hashSeriesValue(existing)) !== (await hashSeriesValue(run)))
      throw new Error("Immutable model day conflict");
    return { reused: true, run: existing };
  }
  const latestDate = await store.latestSessionDate(path("sessions"));
  if (previous) {
    assertModelSeriesIsolation(series, previous);
    const savedPrevious = await store.read<T>(path(`sessions/${previous.receipt.date}.json`));
    if (
      !registry ||
      !savedPrevious ||
      (await hashSeriesValue(savedPrevious)) !== (await hashSeriesValue(previous)) ||
      latestDate !== previous.receipt.date ||
      run.previousStateHash !== previous.stateHash ||
      run.receipt.date <= previous.receipt.date
    )
      throw new Error("Authoritative model predecessor is missing or newer history exists");
  } else if (latestDate || run.previousStateHash !== null)
    throw new Error("Cannot reset or initialize over existing model history");
  if (!registry) await store.putImmutable(path("registry.json"), series);
  await store.putImmutable(path(`sessions/${run.receipt.date}.json`), run);
  const verified = await store.read<T>(path(`sessions/${run.receipt.date}.json`));
  if (!verified || (await hashSeriesValue(verified)) !== (await hashSeriesValue(run)))
    throw new Error("Model immutable write readback mismatch");
  return { reused: false, run: verified };
}

/** All predecessor reads and the insert share one exclusive writer lease. */
export async function persistModelRun<T extends ModelJournalRun>(
  store: ImmutableModelStore,
  userId: string,
  series: FrozenModelSeries,
  run: T,
  previous: T | null,
) {
  return store.withSeriesLock(`${userId}:${series.bookId}`, () =>
    persistLockedModelRun(store, userId, series, run, previous),
  );
}
