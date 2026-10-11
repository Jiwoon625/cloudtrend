import reference from "./verifiedKrIndexMembership.generated.json";
import { normalizeReviewedStockSymbol } from "./stockSectorMaster";
import type { Instrument } from "./types";

export const VERIFIED_KR_PRIORITY_INDEXES = ["KOSPI200", "KOSDAQ150", "KRX300"] as const;

type Membership = Pick<
  Instrument,
  "indexMemberships" | "indexMembershipsKnown" | "indexMembershipsProvenance"
>;

const snapshots = reference.snapshots
  .map((snapshot) => ({
    asOfDate: snapshot.asOfDate,
    indexes: snapshot.indexes.map((index) => ({
      indexCode: index.indexCode,
      sourceUrl: index.sourceUrl,
      members: new Set(index.constituents.map((member) => member.symbol)),
    })),
  }))
  .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/**
 * Last verified snapshot on/before the analysis date. Forward carry is explicit;
 * no current membership is backfilled into dates before the first evidence.
 * This is reference data, not point-in-time knowledge of when it was downloaded.
 */
export function resolveVerifiedKrIndexMembership(symbol: string, asOfDate: string): Membership {
  // KRX now also uses alphanumeric short codes (for example 0126Z0).
  const code = normalizeReviewedStockSymbol(symbol).replace(/^A(?=[0-9A-Z]{6}$)/, "");
  const snapshot = validDate(asOfDate)
    ? snapshots.filter((item) => item.asOfDate <= asOfDate).at(-1)
    : undefined;
  const complete =
    snapshot &&
    VERIFIED_KR_PRIORITY_INDEXES.every((indexCode) =>
      snapshot.indexes.some((index) => index.indexCode === indexCode),
    );
  const known = Boolean(complete && /^[0-9A-Z]{6}$/.test(code));
  return {
    indexMembershipsKnown: known,
    indexMemberships: known
      ? snapshot!.indexes.filter((index) => index.members.has(code)).map((index) => index.indexCode)
      : [],
    indexMembershipsProvenance: {
      source: "KRX_OFFICIAL_CONSTITUENTS",
      snapshotAsOfDate: known ? snapshot!.asOfDate : null,
      evaluationAsOfDate: asOfDate,
      sourceUrls: known ? snapshot!.indexes.map((index) => index.sourceUrl) : [],
    },
  };
}

/** Keep legacy/supplied/frozen metadata exact. Re-evaluate only our tagged lookup. */
export function resolveInstrumentMembershipAtDate(inst: Instrument, asOfDate: string): Instrument {
  if (inst.indexMembershipsProvenance?.source !== "KRX_OFFICIAL_CONSTITUENTS") return inst;
  return { ...inst, ...resolveVerifiedKrIndexMembership(inst.symbol, asOfDate) };
}
