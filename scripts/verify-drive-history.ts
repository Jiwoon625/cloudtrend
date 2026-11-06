/** No credentials required: differential harness executes the OLD loader with a captured transport.
 * This is not a live Supabase E2E or an installed operational-index comparison. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAnalysisSourceInputs } from "./source-registry-store";
import { loadDriveHistory, KR_OWNER, hashBytes } from "./drive-history-inputs";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import { runCurrentScreening } from "../src/lib/currentScreening";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { stableCacheJson, deterministicAnalysis } from "../src/lib/screeningCacheContract";
import { datasetDigest } from "../src/lib/underlyingIndexDiagnostics.server";
import { verifyKrScreeningPublication } from "../src/lib/krScreeningPublication.server";

async function main() {
  const directory = path.resolve(process.argv[2] ?? ".");
  const output = path.resolve(process.argv[3] ?? "drive-history-verification");
  await mkdir(output, { recursive: true });
  const started = Date.now();
  const sources: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    status: "RUNNING",
    comparison: "CAPTURED_TRANSPORT_OLD_LOADER_VS_DRIVE",
    liveSupabaseSourceGETs: 0,
    liveSupabaseE2E: false,
    sourceValidation: sources,
    queriedAt: new Date().toISOString(),
    operationalIndex: "NOT_COMPARED",
    configuration: "REPOSITORY_DEFAULT",
  };
  const save = () =>
    writeFile(path.join(output, "equivalence.json"), JSON.stringify(report, null, 2));
  try {
    const drive = await loadDriveHistory(directory, async (r) => {
      sources.push(r);
      await save();
    });
    const records = drive.manifest.sources.map((s) => s.sourceRecord);
    let reads = 0;
    const query: any = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      in() {
        return this;
      },
      order() {
        return this;
      },
      then(resolve: any) {
        resolve({ data: records, error: null });
      },
    };
    const client = {
      from: () => query,
      storage: {
        from: () => ({
          download: async (objectPath: string) => {
            const source = drive.manifest.sources.find(
              (s) => s.sourceRecord.storage_path === objectPath,
            );
            if (!source) throw new Error("Unexpected old-loader read");
            reads++;
            const b = await readFile(path.join(directory, source.member));
            return { data: new Blob([b]), error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    // Run one full parser/engine at a time; retain only fingerprints and small diagnostics.
    async function describe(inputs: typeof drive.inputs) {
      const parsed = parseManualMarketDataWithReferences(inputs.map((i) => i.text));
      const digest = datasetDigest(parsed.dataset);
      const counts: Record<string, number> = {};
      const fieldHashes: Record<string, string> = {};
      for (const [symbol, bars] of Object.entries(parsed.dataset.bars)) {
        fieldHashes[symbol] = hashBytes(
          stableCacheJson({
            bars,
            observed: parsed.dataset.observedBars?.[symbol],
            references: parsed.dataset.krxReviewObservations?.[symbol],
            financials: parsed.dataset.financials[symbol],
            etfFacts: parsed.dataset.etfFacts[symbol],
          }),
        );
        for (const bar of bars) {
          const market =
            parsed.dataset.instruments.find((i) => i.symbol === symbol)?.market ?? "INDEX";
          for (const k of [`symbol:${symbol}`, `date:${bar.tradeDate}`, `market:${market}`])
            counts[k] = (counts[k] ?? 0) + 1;
        }
      }
      const analysis = runCurrentScreening(parsed.dataset, DEFAULT_SCORING_CONFIG).analysis;
      const publication = await verifyKrScreeningPublication(
        client,
        KR_OWNER,
        records,
        inputs.map((i) => i.text),
      );
      return {
        ordered: inputs.map((i) => ({
          id: i.id,
          fileHash: i.fileHash,
          dataHash: i.dataHash,
          schemaHash: i.schemaHash,
          canonicalSha256: hashBytes(i.text),
        })),
        datasetDigest: digest,
        stats: parsed.stats,
        counts,
        fieldHashes,
        analysisDigest: hashBytes(stableCacheJson(deterministicAnalysis(analysis))),
        rows: analysis.rows.length,
        publication,
      };
    }
    report["drive"] = await describe(drive.inputs);
    for (const i of drive.inputs) {
      i.text = "";
      i.validation.canonicalCsv = "";
    }
    const old = await loadAnalysisSourceInputs(client, KR_OWNER, "screening", { compact: true });
    report["oldLoader"] = await describe(old);
    report["capturedOldLoaderReads"] = reads;
    report["equal"] = stableCacheJson(report["drive"]) === stableCacheJson(report["oldLoader"]);
    if (!report["equal"]) throw new Error("Differential comparison failed");
    report["status"] = "PASSED_CAPTURED_TRANSPORT";
  } catch (e) {
    report["status"] = "FAILED";
    report["error"] = e instanceof Error ? e.message : "Verification failed";
    process.exitCode = 1;
  }
  report["elapsedMs"] = Date.now() - started;
  report["peakRssBytes"] = process.resourceUsage().maxRSS * 1024;
  await save();
  console.log(
    JSON.stringify({
      status: report["status"],
      elapsedMs: report["elapsedMs"],
      peakRssBytes: report["peakRssBytes"],
      error: report["error"],
    }),
  );
}
main();
