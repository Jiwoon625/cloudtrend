import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  adoptedDatasetAsOf,
  selectBacktestSessions,
} from "../src/lib/research/adoptedBacktestInput";
import {
  runAdoptedFullPeriodBacktest,
  parseReplayArgs,
} from "../scripts/run-adopted-kr-etf-backtest";

const hash = (data: string | Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "adopted-runner-"));
  const dataset = structuredClone(getMockDataset());
  dataset.observedBars = dataset.bars;
  const text = JSON.stringify(dataset);
  await writeFile(path.join(dir, "dataset.json"), text);
  const manifest = {
    version: "adopted-kr-etf-inputs-v1",
    sessions: dataset.tradeDates,
    dataset: { path: "dataset.json", bytes: Buffer.byteLength(text), sha256: hash(text) },
    sourceHash: hash(text),
    startDate: dataset.tradeDates.at(-20),
    limitations: ["Synthetic integration fixture only"],
  };
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, dataset, manifest, manifestPath };
}

describe("local adopted-rule replay inputs", () => {
  it("uses a separately derived final code alias without numerically interpreting an alphanumeric ticker", () => {
    const csv =
      "symbol,name,market,securityType,date,open,high,low,close,volume,code\n" +
      "1.88E+02,Synthetic ETF,KOSPI,ETF,2020-01-02,100,100,100,100,100,0188E0";
    const result = parseManualMarketData(csv, { allowIncompleteIndex: true });
    expect(result.dataset.instruments[0]!.symbol).toBe("0188E0");
    expect(result.dataset.observedBars!["0188E0"]).toHaveLength(1);
    expect(result.dataset.observedBars!["000188"]).toBeUndefined();
  });

  it("parses lazy record-boundary chunks with the same later-nonempty merge", () => {
    const header =
      "symbol,name,market,securityType,date,open,high,low,close,volume,tradingValue,marketCap";
    const rows = [
      "KOSPI,Index,INDEX,INDEX,2020-01-02,100,100,100,100,1,1,1",
      '005930,"quoted, name",KOSPI,STOCK,2020-01-02,90,110,80,100,10,1000,100000',
      "005930,,KOSPI,STOCK,2020-01-02,,,,101,0,,",
      "005930,,KOSPI,STOCK,2020-01-02,,,,,,0,",
      "KOSPI,Index,INDEX,INDEX,2020-01-03,101,101,101,101,1,1,1",
      "005930,Stock,KOSPI,STOCK,2020-01-03,101,102,100,102,10,1020,102000",
    ];
    let consumed = 0;
    function* chunks() {
      for (const row of rows) {
        consumed++;
        yield header + "\n" + row;
      }
    }
    const expected = parseManualMarketData(header + "\n" + rows.join("\n"), {
      allowIncompleteIndex: true,
    });
    expect(parseManualMarketData(chunks(), { allowIncompleteIndex: true })).toEqual(expected);
    expect(consumed).toBe(rows.length);
    const bar = expected.dataset.observedBars!["005930"][0];
    expect(bar.close).toBe(101);
    expect(bar.volume).toBe(0);
    expect(bar.tradingValue).toBe(0);
  });

  it("keeps full warmup and clips every future-bearing field without mutating source", () => {
    const raw = structuredClone(getMockDataset());
    raw.observedBars = raw.bars;
    const date = raw.tradeDates.at(-2)!;
    raw.liquidSymbolCountsByDate = { [date]: 5, [raw.asOfDate]: 99 };
    raw.kospiPriceInputIssues = { [date]: ["low"], [raw.asOfDate]: ["future"] };
    raw.financials["FUTURE"] = { ...Object.values(raw.financials)[0]!, sourceDate: raw.asOfDate };
    raw.vkospiObservations = [
      { date, value: 12, source: "VKOSPI" },
      { date: raw.asOfDate, value: 999, source: "VKOSPI" },
    ];
    const before = JSON.stringify(raw);
    const sliced = adoptedDatasetAsOf(raw, date);
    expect(sliced.tradeDates.length).toBe(299);
    expect(
      Object.values(sliced.bars).every((rows) => rows.every((row) => row.tradeDate <= date)),
    ).toBe(true);
    expect(
      Object.values(sliced.observedBars!).every((rows) =>
        rows.every((row) => row.tradeDate <= date),
      ),
    ).toBe(true);
    expect(
      sliced.indexSeries.every((series) => series.bars.every((row) => row.tradeDate <= date)),
    ).toBe(true);
    expect(sliced.financials["FUTURE"]).toBeUndefined();
    expect(sliced.etfFacts).toEqual({});
    expect(sliced.vkospiSeries).toEqual([12]);
    expect(sliced.liquidSymbolCountsByDate).toEqual({ [date]: 5 });
    expect(sliced.kospiPriceInputIssues).toEqual({ [date]: ["low"] });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("rejects absent inputs, modified bytes, unsupported flags and insufficient smoke", async () => {
    expect(() => parseReplayArgs(["--publish", "true"])).toThrow(/Invalid/);
    expect(() => selectBacktestSessions(["2020-01-02"], "2020-01-02", "2020-01-02", 20)).toThrow(
      /Not enough/,
    );
    expect(() => selectBacktestSessions(["2020-01-02"], "2020-01-02", "2020-01-02", 2)).toThrow(
      /20 through 60/,
    );
    const f = await fixture();
    await expect(
      runAdoptedFullPeriodBacktest({
        market: "kr",
        manifest: path.join(f.dir, "absent.json"),
        out: path.join(f.dir, "absent-output"),
        smokeSessions: 20,
      }),
    ).rejects.toThrow();
    await writeFile(path.join(f.dir, "dataset.json"), " ");
    await expect(
      runAdoptedFullPeriodBacktest({
        market: "kr",
        manifest: f.manifestPath,
        out: path.join(f.dir, "bad-output"),
        smokeSessions: 20,
      }),
    ).rejects.toThrow(/byte mismatch/);
    await expect(stat(path.join(f.dir, "bad-output"))).rejects.toThrow();
  });

  it("runs one real scoring pass for KR three books plus ETF and withholds smoke metrics", async () => {
    const f = await fixture();
    const inputBefore = await readFile(path.join(f.dir, "dataset.json"));
    const out = path.join(f.dir, "smoke-output");
    const result = await runAdoptedFullPeriodBacktest({
      market: "kr-etf",
      manifest: f.manifestPath,
      out,
      smokeSessions: 20,
    });
    execFileSync("python", ["scripts/verify-adopted-kr-etf-results.py", "--results", out]);
    expect(Object.keys(result.summary)).toEqual([
      "ETF_V02",
      "KR_COMBINED_ADOPTED",
      "KOSPI_STANDALONE_DIAGNOSTIC",
      "KOSDAQ_STANDALONE_DIAGNOSTIC",
    ]);
    for (const summary of Object.values(result.summary))
      expect(summary).toMatchObject({
        status: "SAMPLE_INCOMPLETE",
        cumulativeReturn: null,
        cagr: null,
        mdd: null,
        observations: 20,
      });
    expect(result.quality).toMatchObject({
      runStatus: "FINISHED",
      mode: "SAMPLE_INCOMPLETE",
      warmupSessions: 280,
      scoringSessions: 20,
      syntheticFixture: true,
      featureWarmupLowerBounds: {
        KR: f.dataset.tradeDates[251],
        ETF: f.dataset.tradeDates[119],
        definition: "EARLIEST_POSSIBLE_REQUIRED_PRICE_FEATURE_NOT_GUARANTEED_SIGNAL",
      },
    });
    expect(result.quality["signalReadiness"]).toMatchObject({
      scope: "SELECTED_SCORING_SESSIONS_ONLY_NOT_EARLIEST_SOURCE_HISTORY",
      firstAnyValidScoreDate: { KOSPI: f.manifest.startDate, KOSDAQ: f.manifest.startDate },
    });
    expect((await stat(out)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(out, "summary.json"))).mode & 0o777).toBe(0o600);
    expect(
      (await readFile(path.join(out, "KR_COMBINED_ADOPTED.daily-nav.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(20);
    expect(await readFile(path.join(f.dir, "dataset.json"))).toEqual(inputBefore);
    await expect(
      runAdoptedFullPeriodBacktest({
        market: "kr",
        manifest: f.manifestPath,
        out: path.join(f.dir, "full-fixture"),
      }),
    ).rejects.toThrow(/smoke-only/);
  }, 120_000);

  it("accepts hashed canonical gzip CSV and publishes only a complete selected range", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "adopted-csv-runner-"));
    const raw = getMockDataset();
    const header = "date,symbol,name,market,type,open,high,low,close,volume,marketCap";
    const instruments = [
      raw.instruments.find((row) => row.market === "KOSPI")!,
      raw.instruments.find((row) => row.market === "KOSDAQ")!,
    ];
    const rows = instruments.flatMap((instrument) =>
      raw.bars[instrument.symbol]!.map((bar) =>
        [
          bar.tradeDate,
          instrument.symbol,
          instrument.name,
          instrument.market,
          "STOCK",
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.marketCap,
        ].join(","),
      ),
    );
    rows.push(
      ...raw.indexSeries.flatMap((series) =>
        series.bars.map((bar) =>
          [
            bar.tradeDate,
            series.indexCode,
            series.indexCode,
            "INDEX",
            "INDEX",
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            "",
          ].join(","),
        ),
      ),
    );
    const data = gzipSync([header, ...rows].join("\n"));
    await writeFile(path.join(dir, "canonical.csv.gz"), data);
    const manifestPath = path.join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: "adopted-kr-etf-inputs-v1",
        sessions: raw.tradeDates,
        files: [{ path: "canonical.csv.gz", bytes: data.length, sha256: hash(data) }],
        startDate: raw.tradeDates.at(-2),
        limitations: ["Synthetic CSV integration test"],
      }),
    );
    const result = await runAdoptedFullPeriodBacktest({
      market: "kr",
      manifest: manifestPath,
      out: path.join(dir, "result"),
    });
    execFileSync("python", [
      "scripts/verify-adopted-kr-etf-results.py",
      "--results",
      path.join(dir, "result"),
    ]);
    expect(result.quality).toMatchObject({
      mode: "SELECTED_RANGE_REPLAY",
      warmupSessions: 298,
      scoringSessions: 2,
    });
    expect(result.summary["KR_COMBINED_ADOPTED"]).toMatchObject({
      status: "COMPLETE",
      observations: 2,
      annualization: "ACTUAL_DAYS_365_2425",
    });
    expect(await readFile(path.join(dir, "canonical.csv.gz"))).toEqual(data);
  }, 120_000);
});
