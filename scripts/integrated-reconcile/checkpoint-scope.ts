/** Dependency planning only. Caller must first cryptographically validate both books.
 * This helper never substitutes metadata for a payload hash and performs no writes.
 */
import type { GenerationProbe, StrongGeneration } from "./generation-cache";
export interface VerifiedCheckpointBook {
  head: { stateHash: string; receipt: { date: string } } | null;
  ledger: {
    markets: Record<"K" | "E" | "U", { sessions: string[]; lastSessionDate: string | null }>;
  } | null;
}
export interface CheckpointScope {
  readonly checkpointHashes: Readonly<{ O1: string; S07: string }>;
  readonly pendingDates: readonly string[];
  readonly fullKrDates: readonly string[];
  readonly fullUsDates: readonly string[];
  readonly metadataOnlyUsDates: readonly string[];
}
const HASH = /^sha256:[a-f0-9]{64}$/;
export function checkpointScope(input: {
  books: { O1: VerifiedCheckpointBook; S07: VerifiedCheckpointBook };
  calendars: { KR: string[]; US: string[] };
  throughDate: string;
}): CheckpointScope | null {
  const all = [...new Set([...input.calendars.KR, ...input.calendars.US])]
    .filter((d) => d >= "2026-10-12" && d <= input.throughDate)
    .sort();
  const headDates: string[] = [];
  const priorUs: string[] = [];
  for (const kind of ["O1", "S07"] as const) {
    const book = input.books[kind];
    if (!book.head || !book.ledger) return null;
    const head = book.head.receipt.date;
    if (!HASH.test(book.head.stateHash) || !all.includes(head))
      throw Error("Invalid verified checkpoint head");
    for (const market of ["K", "E", "U"] as const) {
      const expected = input.calendars[market === "U" ? "US" : "KR"].filter(
        (d) => d >= "2026-10-12" && d <= head,
      );
      const state = book.ledger.markets[market];
      if (
        !state ||
        JSON.stringify(state.sessions) !== JSON.stringify(expected) ||
        state.lastSessionDate !== (expected.at(-1) ?? null)
      )
        throw Error("Checkpoint market session grid mismatch");
    }
    if (!book.ledger.markets.U.lastSessionDate) return null;
    priorUs.push(book.ledger.markets.U.lastSessionDate);
    headDates.push(head);
  }
  const floor = headDates.sort()[0];
  const pending = all.filter((d) => d > floor);
  if (!pending.length) return null; // quick no-op is separate; otherwise use full historical audit.
  const usFloor = priorUs.sort()[0];
  return Object.freeze({
    checkpointHashes: Object.freeze({
      O1: input.books.O1.head!.stateHash,
      S07: input.books.S07.head!.stateHash,
    }),
    pendingDates: Object.freeze(pending),
    fullKrDates: Object.freeze(
      input.calendars.KR.filter((d) => d >= "2026-10-12" && d <= input.throughDate),
    ),
    fullUsDates: Object.freeze(
      input.calendars.US.filter((d) => d >= usFloor && d <= input.throughDate),
    ),
    metadataOnlyUsDates: Object.freeze(
      input.calendars.US.filter((d) => d >= "2026-10-12" && d < usFloor),
    ),
  });
}
/** null requires FULL historical inspection, including outbox search. Operational errors propagate.
 * Repeat on each inspection; include returned exact generations in its fingerprint.
 */
export async function checkpointHistoricGenerations(
  scope: CheckpointScope,
  uid: string,
  probe: (path: string) => Promise<GenerationProbe>,
): Promise<Record<string, StrongGeneration> | null> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw Error("Verified owner required");
  const result: Record<string, StrongGeneration> = {};
  for (const date of scope.metadataOnlyUsDates) {
    const g = await probe(`${uid}/staging/integrated-allocation-inputs/v1/US/${date}.json`);
    if (
      !g ||
      g.kind !== "strong" ||
      ![g.objectId, g.version, g.etag].every((v) => typeof v === "string" && v.trim().length > 0) ||
      !Number.isSafeInteger(g.size) ||
      g.size <= 0
    )
      return null;
    result[`US:${date}`] = { ...g };
  }
  return result;
}
