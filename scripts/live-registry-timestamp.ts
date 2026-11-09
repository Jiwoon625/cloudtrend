import type { LoadedSourceInput } from "./source-registry-store";

/**
 * The frozen Drive baseline stores registry timestamps in psql text form
 * (`2026-10-06 21:13:10.879416+00`) while the live registry answers with ISO form
 * (`2026-10-06T21:13:10.879416+00:00`). Both name the same instant, but the input
 * fingerprint hashes the strings, so a record read back from storage must be
 * normalized to the live form before it is compared with a live read.
 */
export function liveRegistryTimestamp(value: string | null | undefined): string | null | undefined {
  if (typeof value !== "string") return value;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::(\d{2}))?$/.exec(
    value,
  );
  return match ? `${match[1]}T${match[2]}${match[3]}:${match[4] ?? "00"}` : value;
}

/** Same record and hashes, with timestamps in the form a live registry read returns. */
export function liveRegistryInput(input: LoadedSourceInput): LoadedSourceInput {
  const record = input.sourceRecord;
  if (!record) return input;
  const activated_at = liveRegistryTimestamp(record.activated_at) ?? null;
  const created_at = liveRegistryTimestamp(record.created_at) ?? record.created_at;
  if (activated_at === record.activated_at && created_at === record.created_at) return input;
  return { ...input, sourceRecord: { ...record, activated_at, created_at } };
}
