import type { AnalysisResult } from "./engine/pipeline";
import type referenceData from "./engine/verifiedKrIndexMembership.generated.json";
import { SCREENING_CACHE_VERSION } from "./screeningCacheContract";

export const PREVIOUS_KR_INDEX_CACHE_VERSION = "screening-cache-v9-current-price-20261104-v1";
export const KR_INDEX_COMPATIBLE_TARGET =
  "screening-cache-v9-current-price-verified-kr-index-20261106-v1";

/** This version pair certifies an index-reference-only release, never engine changes. */
export async function verifiedKrIndexCacheCompatibility() {
  if (SCREENING_CACHE_VERSION !== KR_INDEX_COMPATIBLE_TARGET) return null;
  const { default: reference } = await import("./engine/verifiedKrIndexMembership.generated.json");
  // Preserve the exact historical lookup already certified for this cache version pair.
  const bytes = new TextEncoder().encode(JSON.stringify(reference.snapshots.slice(0, 2)));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== "5cfe6c2b629869f32010f279bee006c8bc5ae068a46e05acd5f828ac89c2ce66") return null;
  return verifiedKrIndexChangeScope(reference);
}

/** Membership changes affect each symbol's priority, but not market/sector inputs.
 * The caller must separately prove identical source/config identity and result digest.
 * Never infer this scope from a general source registry fingerprint mismatch.
 */
export function verifiedKrIndexChangeScope(reference: typeof referenceData) {
  const dates = reference.snapshots.map((s) => s.asOfDate);
  if (
    dates.some(
      (d) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ||
        new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d,
    ) ||
    new Set(dates).size !== dates.length ||
    dates.some((d, i) => i > 0 && d <= dates[i - 1]!)
  )
    return null;
  const previous = reference.snapshots.find((s) => s.asOfDate === "2026-10-30");
  const latest = reference.snapshots.at(-1);
  if (!previous || !latest || latest.asOfDate < previous.asOfDate) return null;
  const codes = ["KOSPI200", "KOSDAQ150", "KRX300"];
  const memberships = (snapshot: typeof previous) => {
    if (snapshot.indexes.length !== codes.length) return null;
    const result = new Map<string, string[]>();
    for (const code of codes) {
      const matches = snapshot.indexes.filter((i) => i.indexCode === code);
      if (matches.length !== 1) return null;
      const index = matches[0]!;
      const symbols = index.constituents.map((m) => m.symbol);
      if (
        index.count !== symbols.length ||
        new Set(symbols).size !== symbols.length ||
        symbols.some((s) => !/^[0-9A-Z]{6}$/.test(s))
      )
        return null;
      for (const symbol of symbols) result.set(symbol, [...(result.get(symbol) ?? []), code]);
    }
    return result;
  };
  const before = memberships(previous);
  const after = memberships(latest);
  if (!before || !after) return null;
  const excludedSymbols = [...new Set([...before.keys(), ...after.keys()])]
    .filter((s) => JSON.stringify(before.get(s) ?? []) !== JSON.stringify(after.get(s) ?? []))
    .sort();
  return {
    excludedSymbols,
    referenceDate: latest.asOfDate,
    latestMemberships: Object.fromEntries(after),
  };
}

export function sameVerifiedKrIndexConstituents(reference: typeof referenceData) {
  return verifiedKrIndexChangeScope(reference)?.excludedSymbols.length === 0;
}

/** Saved rows lacking a known official membership cannot establish non-impact. */
export function projectUnchangedIndexRows(
  analysis: AnalysisResult,
  changed: string[],
  latestMemberships: Record<string, string[]>,
) {
  const excluded = new Set(changed);
  const hidden = new Set<string>();
  const rows = analysis.rows.filter((row) => {
    const inst = row.instrument;
    const symbol = inst.symbol.replace(/^A(?=[0-9A-Z]{6}$)/, "");
    const known =
      inst.instrumentType !== "STOCK" ||
      (inst.indexMembershipsKnown === true &&
        inst.indexMembershipsProvenance?.source === "KRX_OFFICIAL_CONSTITUENTS" &&
        Boolean(inst.indexMembershipsProvenance.snapshotAsOfDate) &&
        inst.indexMembershipsProvenance.evaluationAsOfDate === analysis.asOfDate);
    const membershipChanged =
      inst.instrumentType === "STOCK" &&
      JSON.stringify(
        inst.indexMemberships.filter((c) => ["KOSPI200", "KOSDAQ150", "KRX300"].includes(c)).sort(),
      ) !== JSON.stringify([...(latestMemberships[symbol] ?? [])].sort());
    if (excluded.has(symbol) || !known || membershipChanged) {
      hidden.add(symbol);
      return false;
    }
    return true;
  });
  return { analysis: { ...analysis, rows }, hiddenSymbols: [...hidden].sort() };
}
