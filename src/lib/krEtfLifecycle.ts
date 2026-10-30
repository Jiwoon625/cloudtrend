import type { CanonicalSourceRow } from "./sourceData";

export const KR_ETF_LIFECYCLE_VERSION = "kr-etf-lifecycle-v1" as const;
const sourceUrl = "https://www.aceetf.co.kr/cs/notice/7022";
export const KR_ETF_LIFECYCLE_EVENTS = [
  {
    symbol: "261920",
    name: "ACE MSCI필리핀(합성)",
    tradingHaltDate: "2026-10-28",
    delistingDate: "2026-10-29",
    sourceUrl,
  },
  {
    symbol: "280320",
    name: "ACE 미국IT인터넷(합성H)",
    tradingHaltDate: "2026-10-28",
    delistingDate: "2026-10-29",
    sourceUrl,
  },
  {
    symbol: "465620",
    name: "ACE 미국빅테크TOP7 Plus인버스(합성)",
    tradingHaltDate: "2026-10-28",
    delistingDate: "2026-10-29",
    sourceUrl,
  },
] as const;
export interface KrEtfLifecyclePlan {
  version: typeof KR_ETF_LIFECYCLE_VERSION;
  sourceUniverseSymbols: string[];
  requestedCollectionDates: string[];
  events: Array<(typeof KR_ETF_LIFECYCLE_EVENTS)[number]>;
  requestedSymbols: string[];
  latestExpectedSymbols: string[];
}
const fail = (reason: string): never => {
  throw new Error(`KR lifecycle: ${reason}`);
};
function sortedStrings(value: unknown, pattern: RegExp): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((v) => typeof v !== "string" || !pattern.test(v)) ||
    value.some((v, i) => i > 0 && value[i - 1] >= v)
  )
    fail("invalid sorted unique list");
  return value as string[];
}
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    );
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aa = a as Record<string, unknown>,
      bb = b as Record<string, unknown>;
    return (
      Object.keys(aa).length === Object.keys(bb).length &&
      Object.keys(aa).every((k) => Object.hasOwn(bb, k) && exact(aa[k], bb[k]))
    );
  }
  return a === b;
}
/** No caller-defined exemptions: only these published securities and exact dates. */
export function parseKrEtfLifecyclePlan(value: unknown): KrEtfLifecyclePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("missing plan");
  const v = value as Record<string, unknown>;
  const symbols = sortedStrings(v["sourceUniverseSymbols"], /^[0-9A-Z]{6}$/);
  if (symbols.some((s) => s.length !== 6)) fail("invalid source symbol length");
  const dates = sortedStrings(v["requestedCollectionDates"], /^\d{4}-\d{2}-\d{2}$/);
  if (
    dates.some(
      (d) => !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d,
    )
  )
    fail("invalid session date");
  const target = dates.at(-1)!;
  const events = KR_ETF_LIFECYCLE_EVENTS.filter(
    (e) => symbols.includes(e.symbol) && target >= e.tradingHaltDate,
  );
  const affected = new Map<string, (typeof events)[number]>(events.map((e) => [e.symbol, e]));
  const expected: KrEtfLifecyclePlan = {
    version: KR_ETF_LIFECYCLE_VERSION,
    sourceUniverseSymbols: symbols,
    requestedCollectionDates: dates,
    events: [...events],
    requestedSymbols: symbols.filter(
      (s) => !affected.has(s) || dates[0]! < affected.get(s)!.tradingHaltDate,
    ),
    latestExpectedSymbols: symbols.filter((s) => !affected.has(s)),
  };
  if (!exact(v, expected)) fail("unreviewed event or expected universe changed");
  return expected;
}
const equalSet = (a: Iterable<string>, b: Iterable<string>) => {
  const aa = new Set(a),
    bb = new Set(b);
  return aa.size === bb.size && [...aa].every((v) => bb.has(v));
};
/** Validate canonical CSV observations before any upload/registration. No synthetic rows. */
export function validateKrEtfLifecycleRows(value: unknown, rows: readonly CanonicalSourceRow[]) {
  const plan = parseKrEtfLifecyclePlan(value),
    target = plan.requestedCollectionDates.at(-1)!;
  const indices = ["KOSPI", "KOSDAQ"];
  const days = [...new Set(rows.map((r) => r.date))].sort();
  if (new Set(rows.map((r) => `${r.symbol}\0${r.date}`)).size !== rows.length)
    fail("duplicate source keys");
  if (
    !equalSet(
      days.filter((d) => d >= plan.requestedCollectionDates[0]!),
      plan.requestedCollectionDates,
    )
  )
    fail("requested calendar does not match observed market sessions");
  if (days.at(-1) !== target || plan.requestedCollectionDates.some((d) => !days.includes(d)))
    fail("requested sessions missing from source");
  // Lookback may retain ceased instruments that are not requested after their halt.
  // Keep all observations within the original universe, but require exact coverage
  // only for the requested window. The event checks below still reject halt-day rows.
  const sourceSymbols = new Set([...plan.sourceUniverseSymbols, ...indices]);
  if (rows.some((r) => !sourceSymbols.has(r.symbol))) fail("collected universe mismatch");
  if (
    !equalSet(
      rows.filter((r) => r.date >= plan.requestedCollectionDates[0]!).map((r) => r.symbol),
      [...plan.requestedSymbols, ...indices],
    )
  )
    fail("collected universe mismatch");
  if (
    !equalSet(
      rows.filter((r) => r.date === target).map((r) => r.symbol),
      [...plan.latestExpectedSymbols, ...indices],
    )
  )
    fail("latest active symbols missing");
  for (const day of days) {
    if (
      !equalSet(
        rows.filter((r) => r.date === day && r.type === "INDEX").map((r) => r.symbol),
        indices,
      )
    )
      fail("market indices missing");
  }
  for (const event of plan.events) {
    const observed = rows.filter((r) => r.symbol === event.symbol);
    if (
      observed.some(
        (r) => r.type !== "ETF" || r.name.replace(/\s/g, "") !== event.name.replace(/\s/g, ""),
      )
    )
      fail("official ETF identity mismatch");
    if (observed.some((r) => r.date >= event.tradingHaltDate)) fail("non-trading-date row");
    const dates = new Set(observed.map((r) => r.date));
    if (plan.requestedCollectionDates.some((d) => d < event.tradingHaltDate && !dates.has(d)))
      fail("pre-halt requested history missing");
  }
  return plan;
}

export function buildKrLifecycle(
  value: unknown,
  rows: readonly CanonicalSourceRow[],
  source: {
    max_date: string | null;
    file_hash: string;
    data_hash: string;
    schema_hash: string;
  },
) {
  const plan = validateKrEtfLifecycleRows(value, rows);
  if (
    source.max_date !== plan.requestedCollectionDates.at(-1) ||
    [source.file_hash, source.data_hash, source.schema_hash].some(
      (h) => !/^sha256:[0-9a-f]{64}$/.test(h),
    )
  )
    fail("source identity mismatch");
  return {
    ...plan,
    asOfDate: source.max_date,
    sourceFileHash: source.file_hash,
    sourceDataHash: source.data_hash,
    sourceSchemaHash: source.schema_hash,
  };
}
