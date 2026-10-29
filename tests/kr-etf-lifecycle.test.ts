import { expect, test } from "vitest";
import {
  KR_ETF_LIFECYCLE_EVENTS as events,
  parseKrEtfLifecyclePlan,
  validateKrEtfLifecycleRows,
  buildKrLifecycle,
} from "../src/lib/krEtfLifecycle";
import { validateSourceText } from "../src/lib/sourceData";
const symbols = ["005930", ...events.map((e) => e.symbol)];
const plan = (dates = ["2026-10-27", "2026-10-28", "2026-10-29"]) => {
  const activeEvents = events.filter((e) => dates.at(-1)! >= e.tradingHaltDate);
  return {
    version: "kr-etf-lifecycle-v1",
    sourceUniverseSymbols: symbols,
    requestedCollectionDates: dates,
    events: activeEvents,
    requestedSymbols: dates[0]! < "2026-10-28" ? symbols : ["005930"],
    latestExpectedSymbols: activeEvents.length ? ["005930"] : symbols,
  };
};
const csv = (dates = ["2026-10-27", "2026-10-28", "2026-10-29"]) =>
  [
    "symbol,name,market,type,date,open,high,low,close,volume",
    ...dates.flatMap((d) => [
      `KOSPI,KOSPI,INDEX,INDEX,${d},10,10,10,10,100`,
      `KOSDAQ,KOSDAQ,INDEX,INDEX,${d},10,10,10,10,100`,
      `005930,Test,KOSPI,STOCK,${d},10,10,10,10,100`,
      ...events
        .filter((e) => d < e.tradingHaltDate)
        .map((e) => `${e.symbol},${e.name},ETF,ETF,${d},10,10,10,10,100`),
    ]),
  ].join("\n");
const rows = async (dates?: string[]) => (await validateSourceText(csv(dates), "test.csv")).rows;
test("mixed range preserves pre-halt keys and requires all healthy latest observations", async () => {
  expect(validateKrEtfLifecycleRows(plan(), await rows())).toEqual(plan());
});
test.each([["2026-10-27"], ["2026-10-28"], ["2026-10-29"]])(
  "exact cessation boundary %s",
  async (d) => {
    const dates = [d];
    expect(validateKrEtfLifecycleRows(plan(dates), await rows(dates))).toEqual(plan(dates));
  },
);
test.each(["sourceUrl", "tradingHaltDate", "delistingDate", "name", "symbol"])(
  "rejects changed official event %s",
  (key) => {
    const p = structuredClone(plan());
    (p.events[0] as unknown as Record<string, string>)[key] = "forged";
    expect(() => parseKrEtfLifecyclePlan(p)).toThrow();
  },
);
test("rejects unknown exclusions, duplicate/invalid/unsorted dates and extra plan authority", () => {
  for (const change of [
    { latestExpectedSymbols: [] },
    { requestedSymbols: [] },
    { events: [] },
    { approval: true },
    { requestedCollectionDates: ["2026-10-29", "2026-10-27"] },
    { requestedCollectionDates: ["2026-10-29", "2026-10-29"] },
    { requestedCollectionDates: ["2026-02-30"] },
  ])
    expect(() => parseKrEtfLifecyclePlan({ ...plan(), ...change })).toThrow();
});
test("rejects current fabricated ceased prices, missing historical keys, or healthy latest gaps", async () => {
  const base = await rows();
  expect(() =>
    validateKrEtfLifecycleRows(
      plan(),
      base.filter((r) => r.symbol !== "261920"),
    ),
  ).toThrow();
  expect(() =>
    validateKrEtfLifecycleRows(
      plan(),
      base.filter((r) => r.symbol !== "005930" || r.date !== "2026-10-29"),
    ),
  ).toThrow();
  expect(() =>
    validateKrEtfLifecycleRows(plan(), [
      ...base,
      { ...base.find((r) => r.symbol === "261920")!, date: "2026-10-29" },
    ]),
  ).toThrow();
  expect(() =>
    validateKrEtfLifecycleRows(
      plan(),
      base.filter((r) => r.date !== "2026-10-28"),
    ),
  ).toThrow();
});
test("keeps old lookback observations, but refuses index/identity substitutions", async () => {
  const base = await rows();
  expect(validateKrEtfLifecycleRows(plan(), [...(await rows(["2026-10-26"])), ...base])).toEqual(
    plan(),
  );
  expect(() =>
    validateKrEtfLifecycleRows(
      plan(),
      base.filter((r) => r.symbol !== "KOSDAQ"),
    ),
  ).toThrow();
  expect(() =>
    validateKrEtfLifecycleRows(
      plan(),
      base.map((r) => (r.symbol === "261920" ? { ...r, type: "STOCK" as const } : r)),
    ),
  ).toThrow();
});
test("source identity is bound without changing original rows", async () => {
  const base = await rows(),
    original = structuredClone(base),
    hash = `sha256:${"a".repeat(64)}`;
  const result = buildKrLifecycle(plan(), base, {
    max_date: "2026-10-29",
    file_hash: hash,
    data_hash: hash,
    schema_hash: hash,
  });
  expect(result.sourceFileHash).toBe(hash);
  expect(base).toEqual(original);
  expect(() =>
    buildKrLifecycle(plan(), base, {
      max_date: "2026-10-28",
      file_hash: hash,
      data_hash: hash,
      schema_hash: hash,
    }),
  ).toThrow();
});
