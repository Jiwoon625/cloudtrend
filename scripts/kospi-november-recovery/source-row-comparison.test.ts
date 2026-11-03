import { expect, it } from "vitest";
import { sameSourceRows } from "./source-row-comparison";
const sql = "2026-11-03 01:05:34.360251+00";
const iso = "2026-11-03T01:05:34.360251+00:00";
const row = {
  id: "one",
  created_at: sql,
  updated_at: null,
  activated_at: sql,
  metadata: { created_at: sql },
  data_hash: "exact",
};
it.each([
  iso,
  "2026-11-03T01:05:34.360251Z",
  "2026-11-03T10:05:34.360251+09:00",
  "2026-11-02T23:35:34.360251-01:30",
])("accepts exact instant %s without mutating rows", (stamp) => {
  const before = JSON.stringify(row);
  expect(sameSourceRows([{ ...row, created_at: stamp, activated_at: stamp }], [row])).toBe(true);
  expect(JSON.stringify(row)).toBe(before);
});
it("accepts equivalent fractional zero padding and missing zero fractions", () => {
  expect(
    sameSourceRows(
      [{ created_at: "2026-11-03 01:05:34.63093+00" }],
      [{ created_at: "2026-11-03T01:05:34.630930+00:00" }],
    ),
  ).toBe(true);
  expect(
    sameSourceRows(
      [{ updated_at: "2026-11-03 01:05:34+00" }],
      [{ updated_at: "2026-11-03T01:05:34.000000Z" }],
    ),
  ).toBe(true);
});
it.each([
  "2026-11-03T01:05:34.360252Z",
  "2026-11-03T01:05:34.360250Z",
  "2026-11-03T01:05:34.360Z",
  "2026-11-03T01:05:35.360251Z",
  "2026-11-03T01:05:34.360251+09:00",
])("rejects changed instant %s", (stamp) => {
  expect(sameSourceRows([{ ...row, created_at: stamp }], [row])).toBe(false);
});
it.each([
  "2026-02-30T01:05:34Z",
  "2026-11-03T24:00:00Z",
  "2026-11-03T01:05:60Z",
  "2026-11-03T01:05:34.3602510Z",
  "2026-11-03T01:05:34+00:60",
  "2026-11-03T01:05:34",
  "2026-11-03T01:05:34+16:00",
  1793667934360,
  undefined,
])("rejects malformed timestamp %s", (stamp) => {
  expect(sameSourceRows([{ created_at: stamp }], [{ created_at: stamp }])).toBe(false);
});
it("preserves all other fields, nested timestamps, array order and null versus absence", () => {
  expect(sameSourceRows([{ ...row, metadata: { created_at: iso } }], [row])).toBe(false);
  expect(sameSourceRows([{ ...row, data_hash: "changed" }], [row])).toBe(false);
  expect(sameSourceRows([{ ...row, extra: null }], [row])).toBe(false);
  expect(sameSourceRows([{ created_at: null }], [{}])).toBe(false);
  expect(sameSourceRows([row, { ...row, id: "two" }], [{ ...row, id: "two" }, row])).toBe(false);
  expect(sameSourceRows([{ ...row, timestamp: iso }], [{ ...row, timestamp: sql }])).toBe(false);
});
