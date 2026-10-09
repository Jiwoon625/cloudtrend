import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseReplayArgs,
  runAdoptedUsFullPeriodBacktest,
  type ReplayOptions,
} from "../scripts/run-adopted-us-full-period-backtest";
import {
  assertOrderedSessions,
  selectBacktestSessions,
} from "../src/lib/research/adoptedBacktestSessions";

const hash = (data: string | Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const dates = [
  "2017-12-27",
  "2017-12-28",
  "2017-12-29",
  "2018-01-02",
  "2018-01-03",
  "2018-01-04",
  "2018-01-05",
  "2018-01-08",
  "2018-01-09",
  "2018-01-10",
  "2018-01-11",
  "2018-01-12",
  "2018-01-16",
  "2018-01-17",
  "2018-01-18",
  "2018-01-19",
  "2018-01-22",
  "2018-01-23",
  "2018-01-24",
  "2018-01-25",
  "2018-01-26",
];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(mode: "normal" | "stale" | "missing-spy" = "normal") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "adopted-us-only-"));
  directories.push(dir);
  const raw = "date,symbol,open,high,low,close,volume\n2017-01-03,SPY,100,101,99,100,1000000\n";
  await writeFile(path.join(dir, "raw.csv"), raw);
  const source = {
    path: "raw.csv",
    bytes: Buffer.byteLength(raw),
    sha256: hash(raw),
  };
  const sectorMap = "symbol,sector\nSPY,INDEX\nT00,TECH\n";
  await writeFile(path.join(dir, "sectors.csv"), sectorMap);
  const header =
    "date,symbol,name,open,close,ret120,ret252,beta60_spy,ichimoku_tk_gap,relvol1_20,adv20_usd,amihud20,active20,toss_tradable,is_common_share";
  const files = [];
  for (const [stage, date] of dates.entries()) {
    const rows = Array.from({ length: 21 }, (_, i) => {
      const symbol = `T${String(i).padStart(2, "0")}`;
      const rank = i === 0 && stage > 0 ? 30 : i;
      const beta = i === 0 ? (stage >= 3 ? -1 : 30) : i;
      return `${date},${symbol},${symbol},100,100,${rank},${rank},${beta},${i === 0 ? 30 : i},${i},500000,0.001,true,true,true`;
    }).filter((_, i) => !(mode === "stale" && stage === 3 && i === 0));
    if (!(mode === "missing-spy" && stage === 3))
      rows.push(`${date},SPY,SPY,100,100,0,0,1,1,1,1000000,0.001,true,false,false`);
    const text = [header, ...rows, ""].join("\n");
    await writeFile(path.join(dir, `${date}.csv`), text);
    files.push({
      date,
      file: `${date}.csv`,
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
      rows: rows.length,
    });
  }
  const featureSource = "collectors/lite_r3/runtime/us_feature_core.py";
  const manifest = {
    version: "adopted-us-atomic-inputs-v1",
    sessions: dates,
    featureWarmup: {
      requiredPriorSessions: 252,
      canonicalSourceStart: "2017-01-03",
      earliestEvaluationDate: dates[0],
      firstOutputDate: dates[0],
      priorSessionsBeforeFirstOutput: 252,
      completeRowsOnFirstOutput: 21,
    },
    files,
    featureSource,
    featureCodeHash: hash(await readFile(path.resolve(featureSource))),
    canonical: [{ ...source, firstDate: "2017-01-03", lastDate: dates.at(-1) }],
    benchmark: source,
    master: source,
    sectorMap: { path: "sectors.csv", sha256: hash(sectorMap) },
    limitations: ["Synthetic feature rows test integration only"],
  };
  const manifestPath = path.join(dir, "manifest.json");
  const save = () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { dir, manifest, manifestPath, save, sectorMap };
}
const run = (f: Awaited<ReturnType<typeof fixture>>, options: Partial<ReplayOptions> = {}) =>
  runAdoptedUsFullPeriodBacktest({
    market: "us",
    manifest: f.manifestPath,
    out: path.join(f.dir, "result"),
    ...options,
  });
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const readLines = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// No real research inputs or full-period runs are used by these integration fixtures.
describe("isolated local US A0 runner", () => {
  it("accepts only the existing US CLI contract and rejects other markets/flags", async () => {
    expect(
      parseReplayArgs([
        "--run-adopted-backtest",
        "--market",
        "us",
        "--manifest",
        "/input.json",
        "--out",
        "/new",
      ]),
    ).toEqual({ market: "us", manifest: "/input.json", out: "/new" });
    for (const market of ["kr", "etf", "kr-etf", ""])
      expect(() =>
        parseReplayArgs(["--market", market, "--manifest", "/input", "--out", "/out"]),
      ).toThrow();
    for (const args of [["--publish", "true"], ["--out", "a", "--out", "b"], ["--manifest"]])
      expect(() => parseReplayArgs(args)).toThrow(/Invalid/);
    await expect(
      runAdoptedUsFullPeriodBacktest({
        market: "kr" as "us",
        manifest: "/absent",
        out: "/absent",
      }),
    ).rejects.toThrow(/US-only/);
  });

  it("rejects full results without genuine feature warmup evidence", async () => {
    const f = await fixture();
    f.manifest.featureWarmup.priorSessionsBeforeFirstOutput = 20;
    await f.save();
    await expect(run(f)).rejects.toThrow(/252-session/);
  });

  it("retains exact calendar and 20–60 session smoke validation", () => {
    for (const invalid of [
      [],
      ["2026-02-30"],
      ["2018-01-02", "2018-01-02"],
      ["2018-01-03", "2018-01-02"],
      [12],
    ])
      expect(() => assertOrderedSessions(invalid)).toThrow(/unique, increasing actual sessions/);
    expect(selectBacktestSessions(dates, dates[0]!, dates.at(-1)!, 20)).toEqual(dates.slice(0, 20));
    for (const n of [0, 19, 20.5, 61, NaN])
      expect(() => selectBacktestSessions(dates, dates[0]!, dates.at(-1)!, n)).toThrow(
        /20 through 60/,
      );
    expect(() => selectBacktestSessions(dates, dates[1]!, dates[2]!, 20)).toThrow(/Not enough/);
    expect(() => selectBacktestSessions(dates, "2017-12-30", dates.at(-1)!)).toThrow(
      /covered actual/,
    );
  });

  it("streams the same A0 fills across year/quarter boundaries and publishes only US files", async () => {
    const f = await fixture();
    const before = await Promise.all(
      (await readdir(f.dir)).map(async (name) => [
        name,
        hash(await readFile(path.join(f.dir, name))),
      ]),
    );
    const result = await run(f);
    expect(Object.keys(result.summary)).toEqual(["US_A0"]);
    expect(result.summary["US_A0"]).toMatchObject({
      status: "COMPLETE",
      observations: 21,
      annualization: "ACTUAL_DAYS_365_2425",
      initialCapital: "74671.44",
      terminalValuation: "LAST_SESSION_CLOSE_NO_FORCED_LIQUIDATION",
    });
    expect(result.quality).toMatchObject({
      runStatus: "FINISHED",
      mode: "SELECTED_RANGE_REPLAY",
      market: "us",
      parsedRows: 462,
      symbolCount: 22,
      staleNavSessions: 0,
      terminalPositionsLiquidated: false,
      independentOutOfSample: false,
      originalSourceFilesModified: false,
    });
    for (const key of ["elapsedSeconds", "maxRssKiB", "heapUsedBytes"])
      expect(Number.isFinite(result.quality[key])).toBe(true);
    const trades = await readLines(path.join(result.out, "US_A0.trades.jsonl"));
    expect(trades.find((t) => t.side === "BUY" && t.status === "EXECUTED")).toMatchObject({
      executionDate: "2017-12-29",
      modelShares: 37,
      modelPrice: 100,
      feeUsd: 5.55,
    });
    expect(trades.find((t) => t.side === "SELL" && t.status === "EXECUTED")).toMatchObject({
      signalDate: "2018-01-04",
      executionDate: "2018-01-05",
      modelShares: 37,
      feeUsd: 5.55,
    });
    expect(trades.some((t) => t.side.startsWith("REBALANCE"))).toBe(false);
    expect((await readJson(path.join(result.out, "US_A0.final-state.json"))).modelCashExact).toBe(
      "74660.34",
    );
    expect(await readJson(path.join(result.out, "US_A0.yearly-budgets.json"))).toEqual({
      policy: "FIXED_INITIAL_CAPITAL_DIV_20_NO_REBALANCE",
      initialCapital: "74671.44",
      yearlyReset: false,
    });
    expect((await readdir(result.out)).sort()).toEqual([
      "US_A0.contract.json",
      "US_A0.daily-nav.jsonl",
      "US_A0.final-state.json",
      "US_A0.trades.jsonl",
      "US_A0.yearly-budgets.json",
      "provenance.json",
      "quality.json",
      "report.md",
      "summary.json",
    ]);
    expect((await stat(result.out)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(result.out))
      expect((await stat(path.join(result.out, name))).mode & 0o777).toBe(0o600);
    for (const [name, digest] of before)
      expect(hash(await readFile(path.join(f.dir, name!)))).toBe(digest);
    const provenance = await readJson(path.join(result.out, "provenance.json"));
    expect(provenance.sourceManifestHash).toBe(hash(await readFile(f.manifestPath)));
    expect(provenance.code.files).toContainEqual({
      path: "scripts/run-adopted-us-full-period-backtest.ts",
      sha256: hash(await readFile("scripts/run-adopted-us-full-period-backtest.ts")),
    });
    expect(
      provenance.code.files.some(
        (file: { path: string }) => file.path === "src/lib/research/adoptedBacktestSessions.ts",
      ),
    ).toBe(true);
    await expect(run(f)).rejects.toThrow(/EEXIST/);
  });

  it("withholds every return metric for a valid smoke run", async () => {
    const f = await fixture();
    const result = await run(f, { smokeSessions: 20 });
    expect(result.summary["US_A0"]).toMatchObject({
      status: "SAMPLE_INCOMPLETE",
      observations: 20,
      cumulativeReturn: null,
      cagr: null,
      mdd: null,
    });
    expect(result.quality).toMatchObject({
      sourceSessions: 21,
      sessions: 20,
      evaluatedThrough: dates[19],
    });
  });

  it("withholds every return metric when even one session has a stale held-position mark", async () => {
    const f = await fixture("stale");
    const result = await run(f);
    expect(result.summary["US_A0"]).toMatchObject({
      status: "INCOMPLETE",
      cumulativeReturn: null,
      cagr: null,
      mdd: null,
      staleValuationCount: 1,
    });
    const nav = await readLines(path.join(result.out, "US_A0.daily-nav.jsonl"));
    expect(nav[3]).toMatchObject({
      valuationStatus: "STALE",
      staleMarkSymbols: ["T00"],
    });
  });

  it("withholds metrics for an insufficient single-session range", async () => {
    const f = await fixture();
    const result = await run(f, { through: dates[0]! });
    expect(result.summary["US_A0"]).toMatchObject({
      status: "INCOMPLETE",
      observations: 1,
      cumulativeReturn: null,
      cagr: null,
      mdd: null,
    });
  });

  it("fails with a nonpublishable failure record when a session lacks SPY", async () => {
    const f = await fixture("missing-spy");
    await expect(run(f)).rejects.toThrow(/current SPY close/);
    expect(await readJson(path.join(f.dir, "result", "FAILED.json"))).toMatchObject({
      status: "INCOMPLETE",
      summaryMetricsPublishable: false,
    });
    expect(await readdir(path.join(f.dir, "result"))).toEqual(["FAILED.json", "provenance.json"]);
  });

  it("preflights corrupt future files even outside the selected smoke range", async () => {
    const f = await fixture();
    const last = f.manifest.files.at(-1)!;
    await writeFile(path.join(f.dir, last.file), "x".repeat(last.bytes));
    await expect(run(f, { smokeSessions: 20 })).rejects.toThrow(/SHA mismatch/);
    await expect(stat(path.join(f.dir, "result"))).rejects.toThrow();
  });

  it("rejects source byte changes and separate sector-map SHA changes before output creation", async () => {
    const f = await fixture();
    await writeFile(path.join(f.dir, "raw.csv"), "changed");
    await expect(run(f)).rejects.toThrow(/byte mismatch/);
    const other = await fixture();
    await writeFile(path.join(other.dir, "sectors.csv"), "changed");
    await expect(run(other)).rejects.toThrow(/SHA mismatch/);
    for (const x of [f, other]) await expect(stat(path.join(x.dir, "result"))).rejects.toThrow();
  });

  it("rejects an unrecognized manifest and production feature mismatch", async () => {
    const f = await fixture();
    f.manifest.version = "adopted-kr-etf-inputs-v1";
    await f.save();
    await expect(run(f)).rejects.toThrow(/prepare-adopted-us/);
    f.manifest.version = "adopted-us-atomic-inputs-v1";
    f.manifest.featureCodeHash = hash("changed");
    await f.save();
    await expect(run(f)).rejects.toThrow(/production feature function/);
  });

  it("rejects calendar/date mismatch and missing canonical pre-start smoke history", async () => {
    const f = await fixture();
    f.manifest.files[0]!.date = "2017-12-26";
    await f.save();
    await expect(run(f)).rejects.toThrow(/file calendar mismatch/);
    f.manifest.files[0]!.date = dates[0]!;
    f.manifest.canonical[0]!.firstDate = dates[0]!;
    await f.save();
    await expect(run(f, { smokeSessions: 20 })).rejects.toThrow(/genuine canonical history/);
  });

  it("validates parsed row counts and records post-preflight failure without metrics", async () => {
    const f = await fixture();
    f.manifest.files[3]!.rows++;
    await f.save();
    await expect(run(f)).rejects.toThrow(/row count\/date mismatch/);
    expect(
      (await readJson(path.join(f.dir, "result", "FAILED.json"))).summaryMetricsPublishable,
    ).toBe(false);
    await expect(stat(path.join(f.dir, "result", "summary.json"))).rejects.toThrow();
  });

  it("rejects invalid daily paths, byte counts, row counts and nonlocal source URLs", async () => {
    for (const mutation of [
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.manifest.files[0]!.file = "../outside.csv";
      },
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.manifest.files[0]!.bytes = -1;
      },
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.manifest.files[0]!.rows = 0;
      },
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.manifest.canonical[0]!.path = "https://example.com/raw.csv";
      },
    ]) {
      const f = await fixture();
      mutation(f);
      await f.save();
      await expect(run(f)).rejects.toThrow();
      await expect(stat(path.join(f.dir, "result"))).rejects.toThrow();
    }
  });
});

async function expandedFixture() {
  const f = await fixture("stale");
  const featureSource = "research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_closeadj_features.py";
  const normalizerSource = "research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_prepare_comparison.py";
  const sourceClocks = dates.map((date) => ({ date, openAt: `${date}T14:30:00Z`, closeAvailableAt: `${date}T21:15:00Z` }));
  const calendar = JSON.stringify(sourceClocks);
  await writeFile(path.join(f.dir, "calendar.json"), calendar);
  for (const file of f.manifest.files) {
    const raw = (await readFile(path.join(f.dir, file.file), "utf8")).trim().split("\n");
    const data = gzipSync(Buffer.from(raw.map((line, i) => `${line},${i === 0 ? "volume" : "1000000"}`).join("\n")+"\n"));
    file.file += ".gz";
    file.bytes = data.length; file.sha256 = hash(data);
    Object.assign(file, {marketDataComplete: true});
    await writeFile(path.join(f.dir, file.file), data);
  }
  Object.assign(f.manifest, { version: "adopted-us-cm-expanded-inputs-v1", featureSource,
    featureCodeHash: hash(await readFile(path.resolve(featureSource))), normalizerSource,
    normalizerCodeHash: hash(await readFile(path.resolve(normalizerSource))),
    calendar: {path:"calendar.json", bytes:Buffer.byteLength(calendar), sha256:hash(calendar)},
    sourceCoverageEndDate: dates.at(-1), sourceClocks,
    annualBudgetPolicyId:"US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1",
    tradePricePolicyId:"US_A0_COMPARISON_PRICE_8DP_LEDGER_V1",
    missingClosePolicyId:"US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1"});
  await f.save(); return f;
}

describe("expanded CM source adapter and proxy integration", () => {
  it("reads compressed exact rows and recognizes missing-close proxy on the missing session only", async () => {
    const f=await expandedFixture();const result=await run(f);
    expect(result.summary["US_A0"]).toMatchObject({status:"COMPLETE",staleValuationCount:0});
    const trades=await readLines(path.join(result.out,"US_A0.trades.jsonl"));
    const proxy=trades.find(t=>t.reason==="US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1");
    expect(proxy).toMatchObject({symbol:"T00",executionDate:"2018-01-02",side:"SELL",modelPrice:100,modelShares:37});
    expect(proxy.detail).toMatchObject({reference_price_date:"2017-12-29",retroactive_nav_rewrite:false,corporate_actions_modeled:false});
    const contract=await readJson(path.join(result.out,"US_A0.contract.json"));
    expect(contract.missingClosePolicy.sessionClocks).toHaveLength(21);
  });
  it("refuses a declared incomplete source session", async () => {
    const f=await expandedFixture();Object.assign(f.manifest.files[3]!,{marketDataComplete:false});await f.save();
    await expect(run(f)).rejects.toThrow(/Incomplete market source/);
  });
  it("refuses any session after the final verified source date", async () => {
    const f=await expandedFixture();Object.assign(f.manifest,{sourceCoverageEndDate:dates[19]});await f.save();
    await expect(run(f)).rejects.toThrow(/within source coverage/);
  });
  it("smoke truncates only the replay clocks and never publishes sample CAGR", async () => {
    const f=await expandedFixture();const result=await run(f,{smokeSessions:20});
    expect(result.summary["US_A0"]).toMatchObject({status:"SAMPLE_INCOMPLETE",cagr:null,mdd:null});
    const contract=await readJson(path.join(result.out,"US_A0.contract.json"));
    expect(contract.missingClosePolicy.sessionClocks).toHaveLength(20);
  });
});
