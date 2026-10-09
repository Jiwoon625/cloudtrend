import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import * as scoring from "../src/lib/engine/fullMarketAnalysis";
import {
  parseReplayArgs,
  runAdoptedFullPeriodBacktest,
} from "../scripts/run-adopted-kr-etf-backtest";

const hash = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function canonicalFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "adopted-cache-runner-"));
  const raw = getMockDataset();
  const instruments = ["KOSPI", "KOSDAQ", "ETF"].map((market) =>
    raw.instruments.find((i) => i.market === market)!,
  );
  const header = "date,symbol,name,market,type,open,high,low,close,volume,marketCap";
  const rows = instruments.flatMap((instrument) =>
    raw.bars[instrument.symbol]!.map((bar) =>
      [
        bar.tradeDate,
        instrument.symbol,
        instrument.name,
        instrument.market,
        instrument.instrumentType,
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
  const manifest = {
    version: "adopted-kr-etf-inputs-v1",
    sessions: raw.tradeDates,
    files: [{ path: "canonical.csv.gz", bytes: data.length, sha256: hash(data) }],
    startDate: raw.tradeDates.at(-6),
    limitations: ["Synthetic canonical cache integration fixture"],
  };
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, raw, manifest, manifestPath };
}

describe("resumable current-rule scoring runner", () => {
  it("parses explicit scoring-only/cache-input flags and refuses ambiguous modes", () => {
    const base = [
      "--market",
      "kr-etf",
      "--manifest",
      "/private/source.json",
      "--out",
      "/private/new",
    ];
    expect(parseReplayArgs([...base, "--scoring-only"])).toMatchObject({ scoringOnly: true });
    expect(parseReplayArgs(["--scoring-only", ...base])).toMatchObject({ scoringOnly: true });
    expect(parseReplayArgs([...base, "--cache-input", "/private/index.json"])).toMatchObject({
      cacheInput: "/private/index.json",
    });
    expect(() => parseReplayArgs([...base, "--scoring-only", "--scoring-only"])).toThrow(
      /Duplicate/,
    );
    expect(() =>
      parseReplayArgs([...base, "--scoring-only", "--cache-input", "/private/index.json"]),
    ).toThrow(/mutually exclusive/);
  });

  it("replays selected sessions once after validating earlier chunks, preserving all economics across moved manifests", async () => {
    const f = await canonicalFixture();
    const dates = f.raw.tradeDates.slice(-6);
    const start = dates[2]!;
    const through = dates.at(-1)!;
    const options = { market: "kr-etf" as const, manifest: f.manifestPath, start, through };
    const monolithic = await runAdoptedFullPeriodBacktest({
      ...options,
      out: path.join(f.dir, "monolithic"),
    });
    const scoringSpy = vi.spyOn(scoring, "runFullMarketAnalysis");
    const chunks = [];
    for (let i = 0; i < dates.length; i += 2) {
      const out = path.join(f.dir, `chunk-${i}`);
      const result = await runAdoptedFullPeriodBacktest({
        ...options,
        start: dates[i]!,
        through: dates[i + 1]!,
        out,
        scoringOnly: true,
      });
      expect(result.summary).toEqual({});
      expect(result.quality).toMatchObject({
        mode: "SCORING_ONLY",
        runStatus: "FINISHED",
        generatedScoringSessions: 2,
        retainedStockSnapshots: 0,
        portfolioExecutionPasses: { ETF_V02: 0, KR_COMBINED_ADOPTED: 0 },
      });
      expect(
        (await readdir(out)).some((name) => name.includes("daily-nav") || name.includes("trades")),
      ).toBe(false);
      expect((await stat(path.join(out, "signal-cache.jsonl.gz"))).mode & 0o777).toBe(0o600);
      const file = path.join(out, "signal-cache.manifest.json");
      const bytes = await readFile(file);
      chunks.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
    }
    expect(scoringSpy).toHaveBeenCalledTimes(6);
    scoringSpy.mockClear();
    const indexPath = path.join(f.dir, "index.json");
    await writeFile(
      indexPath,
      JSON.stringify({ version: "adopted-signal-cache-index-v1", chunks: chunks.reverse() }),
    );
    // Same ordered byte inputs/calendars in a freshly prepared manifest must retain
    // the economic source identity despite volatile preparation provenance changing.
    const movedManifest = path.join(f.dir, "reprepared.json");
    await writeFile(
      movedManifest,
      JSON.stringify({ ...f.manifest, localPath: "/another/job", elapsedSeconds: 99 }),
    );
    const cached = await runAdoptedFullPeriodBacktest({
      ...options,
      manifest: movedManifest,
      out: path.join(f.dir, "cached"),
      cacheInput: indexPath,
    });
    expect(scoringSpy).not.toHaveBeenCalled();
    scoringSpy.mockRestore();
    expect(cached.quality).toMatchObject({
      generatedScoringSessions: 0,
      scoringSessions: 4,
      signalCache: {
        chunks: 3,
        availableSessions: 6,
        selectedSessions: 4,
        allIndexedRowsValidatedBeforeExecution: true,
      },
      portfolioExecutionPasses: {
        ETF_V02: 1,
        KR_COMBINED_ADOPTED: 1,
        KOSPI_STANDALONE_DIAGNOSTIC: 1,
        KOSDAQ_STANDALONE_DIAGNOSTIC: 1,
      },
    });
    expect(cached.quality["sourceManifestHash"]).not.toEqual(
      monolithic.quality["sourceManifestHash"],
    );
    expect(cached.quality["sourceHash"]).toEqual(monolithic.quality["sourceHash"]);
    expect(cached.quality["signalReadiness"]).toEqual(monolithic.quality["signalReadiness"]);
    expect(cached.quality["signalQuality"]).toEqual(monolithic.quality["signalQuality"]);
    expect(cached.summary).toEqual(monolithic.summary);
    const files = await readdir(monolithic.out);
    expect(files.some((file) => file.startsWith("signal-cache"))).toBe(false);
    expect(await readdir(cached.out)).toEqual(files);
    for (const name of files.filter((name) =>
      /\.(daily-nav|trades|yearly-budgets|accounting|final-state|contract)\.jsonl?$/.test(name),
    )) {
      expect(await readFile(path.join(cached.out, name), "utf8"), name).toEqual(
        await readFile(path.join(monolithic.out, name), "utf8"),
      );
    }
    const lines = (
      await readFile(path.join(cached.out, "KR_COMBINED_ADOPTED.daily-nav.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(lines.map((row) => row.date)).toEqual(dates.slice(2));
  }, 120_000);
});
