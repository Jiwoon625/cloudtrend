/** Physical source activation/order is separate from logical collection evidence. */
export interface SourceTimingRecord {
  id?: string;
  min_date?: string | null;
  max_date?: string | null;
  activated_at?: string | null;
  created_at?: string;
  savedAt?: string;
  validation_result?: unknown;
}

interface OriginalSourceTimingEvidence {
  id: string;
  min_date: string | null;
  max_date: string | null;
  activated_at: string | null;
  created_at: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) &&
    dateKey(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * Compaction receipts contain the original source ranges and collection times,
 * flattened by the atomic database operation, including across repeat compactions.
 * Never substitute the newly activated physical candidate for missing/bad lineage.
 * Do not use this helper for source loading order or physical cache fingerprints.
 */
export function sourceTimingEvidence(record: SourceTimingRecord): SourceTimingRecord[] {
  const validation = record.validation_result;
  if (validation === undefined || validation === null) return [record];
  const fail = (reason: string): never => {
    throw new Error(
      `Invalid screening compaction timing evidence (${record.id ?? "source"}): ${reason}`,
    );
  };
  if (!object(validation)) return fail("validation_result must be an object");
  if (!Object.hasOwn(validation, "screeningCompaction")) return [record];
  const receipt = validation["screeningCompaction"];
  if (!object(receipt)) return fail("screeningCompaction must be an object");
  const evidence = receipt["original_source_evidence"];
  if (!Array.isArray(evidence) || !evidence.length)
    return fail("original_source_evidence must be a nonempty array");

  const origins = new Map<string, OriginalSourceTimingEvidence>();
  const keys = ["id", "min_date", "max_date", "activated_at", "created_at"];
  for (const item of evidence) {
    if (
      !object(item) ||
      Object.keys(item).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(item, key))
    )
      return fail("each origin must contain exactly the original timing fields");
    const id = item["id"];
    const min = item["min_date"];
    const max = item["max_date"];
    const activated = item["activated_at"];
    const created = item["created_at"];
    if (typeof id !== "string" || !id.trim() || id !== id.trim())
      return fail("original source id is invalid");
    if ((min !== null && !dateKey(min)) || (max !== null && !dateKey(max)))
      return fail("original source date range is invalid");
    if (min !== null && max !== null && min > max)
      return fail("original source date range is reversed");
    if ((activated !== null && !timestamp(activated)) || !timestamp(created))
      return fail("original source collection timestamp is invalid");
    const origin: OriginalSourceTimingEvidence = {
      id,
      min_date: min,
      max_date: max,
      activated_at: activated,
      created_at: created,
    };
    const previous = origins.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(origin))
      return fail("conflicting timing evidence for one original source");
    origins.set(id, origin);
  }
  return [...origins.values()];
}
