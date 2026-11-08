import { expect, test } from "vitest";
import reference from "../src/lib/engine/verifiedKrIndexMembership.generated.json";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import {
  projectUnchangedIndexRows,
  verifiedKrIndexChangeScope,
} from "../src/lib/krIndexCacheCompatibility";

test.each(["duplicate", "unordered", "invalid"])("rejects %s reference dates", (kind) => {
  const data = structuredClone(reference);
  if (kind === "duplicate") data.snapshots[2]!.asOfDate = data.snapshots[1]!.asOfDate;
  if (kind === "unordered") data.snapshots.reverse();
  if (kind === "invalid") data.snapshots[2]!.asOfDate = "2026-02-30";
  expect(verifiedKrIndexChangeScope(data)).toBeNull();
});

test.each(["count", "duplicate", "missing"])("rejects %s constituent evidence", (kind) => {
  const data = structuredClone(reference);
  const index = data.snapshots.at(-1)!.indexes[0]!;
  if (kind === "count") index.count++;
  if (kind === "duplicate") index.constituents[1] = structuredClone(index.constituents[0]!);
  if (kind === "missing") data.snapshots.at(-1)!.indexes.pop();
  expect(verifiedKrIndexChangeScope(data)).toBeNull();
});

const row = (symbol: string, memberships: string[], known = true) => ({
  instrument: {
    symbol,
    instrumentType: "STOCK",
    indexMemberships: memberships,
    indexMembershipsKnown: known,
    indexMembershipsProvenance: {
      source: "KRX_OFFICIAL_CONSTITUENTS",
      snapshotAsOfDate: "2026-10-08",
      evaluationAsOfDate: "2026-11-06",
    },
  },
});

test("saved-row membership proof catches differences absent from snapshot diff without mutation", () => {
  const analysis = {
    asOfDate: "2026-11-06",
    rows: [row("A005930", ["KOSPI200"]), row("000660", ["KOSPI200"]), row("035420", [], false)],
  } as unknown as AnalysisResult;
  const before = structuredClone(analysis);
  const result = projectUnchangedIndexRows(analysis, [], {
    "005930": ["KOSPI200"],
    "000660": ["KRX300"],
  });
  expect(result.analysis.rows.map((r) => r.instrument.symbol)).toEqual(["A005930"]);
  expect(result.hiddenSymbols).toEqual(["000660", "035420"]);
  expect(analysis).toEqual(before);
});
