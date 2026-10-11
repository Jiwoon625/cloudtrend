import { expect, it } from "vitest";
import reference from "./verifiedKrIndexMembership.generated.json";
import {
  resolveInstrumentMembershipAtDate,
  resolveVerifiedKrIndexMembership,
} from "./verifiedKrIndexMembership";
import { parseManualMarketData } from "./manualDataset";
import { getMockDataset } from "./mockProvider";
import { runAnalysis } from "./pipeline";
import { priorityScore } from "./scoring";
import type { IndicatorSnapshot } from "./indicators";
import { shadowDatasetAsOf } from "./kospiShadowDataset";

const snapshot = reference.snapshots[0]!;
const indexes = snapshot.indexes;
const sets = indexes.map((index) => new Set(index.constituents.map((member) => member.symbol)));
const base = getMockDataset().instruments.find((inst) => inst.instrumentType === "STOCK")!;
const emptyIndicators = {
  foreignNet20d: null,
  distanceFrom52wHigh: null,
  dayReturn: null,
} as IndicatorSnapshot;
const score = (symbol: string, date: string) =>
  priorityScore(
    {
      ...base,
      symbol,
      ...resolveVerifiedKrIndexMembership(symbol, date),
      valueUpMembershipKnown: false,
    },
    emptyIndicators,
    undefined,
    null,
    null,
  );

it("retains the complete official 201/150/301 lists, provenance, uniqueness and exact overlaps", () => {
  expect(snapshot.asOfDate).toBe("2026-10-08");
  const dates = reference.snapshots.map((item) => item.asOfDate);
  expect(new Set(dates).size).toBe(dates.length);
  expect(dates).toEqual([...dates].sort());
  expect(indexes.map((index) => index.indexCode)).toEqual(["KOSPI200", "KOSDAQ150", "KRX300"]);
  expect(snapshot.dateEvidence).toContain("no date column");
  expect(indexes.map((index) => index.count)).toEqual([201, 150, 301]);
  indexes.forEach((index, i) => {
    expect(index.constituents).toHaveLength(index.count);
    expect(sets[i]!.size).toBe(index.count);
    expect(index.sourceUrl).toMatch(/^https:\/\/index\.krx\.co\.kr\//);
    expect(index.sourceCsvSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const member of index.constituents) {
      expect(Object.keys(member)).toEqual(["symbol", "name"]);
      expect(member.symbol).toMatch(/^[0-9A-Z]{6}$/);
    }
  });
  const overlap = (a: number, b: number) =>
    [...sets[a]!].filter((code) => sets[b]!.has(code)).length;
  expect([overlap(0, 1), overlap(0, 2), overlap(1, 2)]).toEqual([0, 177, 91]);
  expect(new Set(sets.flatMap((set) => [...set])).size).toBe(384);
  expect([...sets[0]!].filter((code) => sets[1]!.has(code) && sets[2]!.has(code))).toHaveLength(0);
});

it("gives exactly +2 once for every constituent, even overlapping memberships", () => {
  for (const symbol of new Set(sets.flatMap((set) => [...set]))) {
    expect(score(symbol, "2026-10-08").rows[0]).toMatchObject({ status: "PASS", points: 2 });
  }
  const allThree = priorityScore(
    { ...base, indexMemberships: ["KOSPI200", "KOSDAQ150", "KRX300"] },
    emptyIndicators,
    undefined,
    null,
    null,
  );
  expect(allThree.rows[0]).toMatchObject({ status: "PASS", points: 2 });
});

it("distinguishes known 033340 non-membership from unknown earlier dates", () => {
  for (const set of sets) expect(set.has("033340")).toBe(false);
  expect(score("033340", "2026-10-08").rows[0]).toMatchObject({ status: "FAIL", points: 0 });
  expect(score("033340", "2026-10-07").rows[0]).toMatchObject({ status: "NO_DATA", points: 0 });
  expect(score("005930", "2026-10-07").rows[0]).toMatchObject({ status: "NO_DATA", points: 0 });
  expect(score("033340", "2026-10-08").availableMaxPoints).toBe(2);
  expect(score("033340", "2026-10-07").availableMaxPoints).toBe(0);
});

it.each(["", "not-a-date", "2026-02-30", "2026-13-10"])(
  "rejects invalid evaluation date %s as unknown",
  (date) => {
    expect(resolveVerifiedKrIndexMembership("005930", date).indexMembershipsKnown).toBe(false);
  },
);

it("normalizes stock codes and explicitly displays checked date and forward carry", () => {
  expect(resolveVerifiedKrIndexMembership("A005930", "2026-10-08").indexMemberships).toEqual([
    "KOSPI200",
    "KRX300",
  ]);
  expect(
    resolveVerifiedKrIndexMembership("5930.0", "2026-10-12").indexMembershipsProvenance
      ?.snapshotAsOfDate,
  ).toBe("2026-10-08");
  expect(score("005930", "2026-10-12").rows[0]!.actual).toContain(
    "KRX 공식 2026-10-08 확인 (최신 확인본 이월)",
  );
  expect(score("005930", "2026-10-08").rows[0]!.actual).not.toContain("이월");
  expect(resolveVerifiedKrIndexMembership("NOT_A_CODE", "2026-10-08").indexMembershipsKnown).toBe(
    false,
  );
});

it("does not infer Value-Up membership from the three verified priority indexes", () => {
  const row = score("005930", "2026-10-08").rows.find(
    (item) => item.rule === "코리아 밸류업 지수 편입",
  );
  expect(row).toMatchObject({ actual: "데이터 없음", status: "NO_DATA", points: 0 });
});

it("connects manual price rows by analysis date, without inventing index inclusion", () => {
  const csv =
    "symbol,name,market,securityType,date,open,high,low,close,volume,tradingValue\n033340,좋은사람들,KOSDAQ,STOCK,2026-10-08,460,470,450,460,100,46000\n005930,삼성전자,KOSPI,STOCK,2026-10-08,100,110,90,100,100,10000";
  const dataset = parseManualMarketData(csv, { allowIncompleteIndex: true }).dataset;
  expect(dataset.asOfDate).toBe("2026-10-08");
  expect(dataset.instruments.find((i) => i.symbol === "033340")).toMatchObject({
    indexMembershipsKnown: true,
    indexMemberships: [],
  });
  expect(dataset.instruments.find((i) => i.symbol === "005930")).toMatchObject({
    indexMembershipsKnown: true,
    indexMemberships: ["KOSPI200", "KRX300"],
  });
  const early = parseManualMarketData(csv.replaceAll("2026-10-08", "2026-10-07"), {
    allowIncompleteIndex: true,
  }).dataset;
  expect(
    early.instruments.every(
      (i) => i.indexMembershipsKnown === false && i.indexMemberships.length === 0,
    ),
  ).toBe(true);
});

it("re-resolves tagged snapshots after a historical slice, preserving explicit untagged inputs", () => {
  const ds = structuredClone(getMockDataset());
  const source = ds.instruments.find((inst) => inst.symbol === "005930")!;
  Object.assign(source, resolveVerifiedKrIndexMembership(source.symbol, "2026-10-08"));
  const sliced = shadowDatasetAsOf(ds, ds.asOfDate);
  const row = runAnalysis(sliced).rows.find((item) => item.instrument.symbol === source.symbol)!;
  expect(row.priority.rows[0]).toMatchObject({ status: "NO_DATA", points: 0 });
  expect(row.instrument.indexMembershipsProvenance?.snapshotAsOfDate).toBeNull();
  expect(source.indexMembershipsKnown).toBe(true); // no mutation of the source
  const explicit = { ...base, indexMemberships: ["KOSPI200", "KRX300"] };
  expect(resolveInstrumentMembershipAtDate(explicit, "2026-08-28")).toBe(explicit);
  expect(priorityScore(explicit, emptyIndicators, undefined, null, null).rows[0]).toMatchObject({
    status: "PASS",
    points: 2,
    actual: "KOSPI200, KRX300",
  });
});

it("keeps official alphanumeric codes and their A-prefixed inputs", () => {
  for (const symbol of ["0126Z0", "0220W0", "0009K0"]) {
    expect(score(symbol, "2026-10-08").rows[0]).toMatchObject({ status: "PASS", points: 2 });
    expect(resolveVerifiedKrIndexMembership(`A${symbol}`, "2026-10-08").indexMemberships).toEqual(
      resolveVerifiedKrIndexMembership(symbol, "2026-10-08").indexMemberships,
    );
  }
});

it("allows separately supplied Value-Up evidence without claiming priority-index coverage", () => {
  const result = priorityScore(
    {
      ...base,
      indexMemberships: ["KOREA_VALUEUP"],
      indexMembershipsKnown: false,
      valueUpMembershipKnown: true,
    },
    emptyIndicators,
    undefined,
    null,
    null,
  );
  expect(result.rows[0]).toMatchObject({ status: "NO_DATA", points: 0 });
  expect(result.rows.find((row) => row.rule === "코리아 밸류업 지수 편입")).toMatchObject({
    status: "PASS",
    points: 0,
  });
});
