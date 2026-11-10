import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadDriveHistory, KR_OWNER } from "./drive-history-inputs";
import { liveRegistryInput } from "./live-registry-timestamp";
import { downloadJson, trustedSupabaseClient } from "./analysis-run-store";
import { inputFingerprint } from "./web-screening-cache-store";
import type { LoadedSourceInput, SourceRecord } from "./source-registry-store";
import { validateSourceBytes } from "../src/lib/sourceData";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import {
  currentDriveGeneration,
  type DriveResultPublication,
} from "../src/lib/driveResultPublication";
import { savedOperationalIdentity } from "../src/lib/screeningInputIdentity";
import { loadOperationalIndex } from "../src/lib/operationalUnderlyingIndex.server";
import { restoreChartContext, warmRecentCharts } from "../src/lib/instrumentChartStore.server";
import { warmFullInstrumentCharts } from "../src/lib/fullInstrumentCharts.server";
import { etfInstrumentChartSeries } from "../src/lib/engine/etfInstrumentChart";
import { etfPartialEvidence } from "../src/lib/etfPartialEvidence";
import { buildFullUniverseSectorDataset } from "../src/lib/engine/sectorRotationFullUniverse";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { ScoringConfig } from "../src/lib/engine/scoring";

interface RepairRequest {
  version: string;
  mode: "diagnose" | "repair";
  inputFingerprint: string;
  resultDigest: string;
  includeStocks?: boolean;
}
interface Head {
  version: "drive-input-head-v1";
  publicationId: string;
  inputFingerprint: string;
  resultDigest: string;
  drivePublication: DriveResultPublication;
}
interface Saved {
  version: string;
  publicationId: string;
  inputFingerprint: string;
  resultDigest: string;
  payload: { analysis: AnalysisResult; source: { drivePublication: DriveResultPublication } };
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (analysis: AnalysisResult) => hash(stableCacheJson(deterministicAnalysis(analysis)));

/** Enforced write allowlist, not a statement that this script is read-only.
 * Writes can only reach this owner's immutable chart revision after verification.
 */
export function installChartRepairBoundary(owner: string, request: RepairRequest) {
  if (
    owner !== KR_OWNER ||
    !/^[a-f0-9]{64}$/.test(request.inputFingerprint) ||
    !/^[a-f0-9]{64}$/.test(request.resultDigest)
  )
    throw new Error("Invalid chart repair target");
  const original = globalThis.fetch;
  let writesEnabled = false;
  const network = { sourceGETs: 0, chartWrites: 0, denied: 0, reads: 0 };
  const suffix = `/${request.inputFingerprint}/${request.resultDigest}/`;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req?.url ?? String(input));
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    if (url.hostname.endsWith(".supabase.co")) {
      const target = decodeURIComponent(url.pathname);
      const historical = /\/source\/(screening|us-screening)\//.test(target);
      const list = method === "POST" && target.startsWith("/storage/v1/object/list/");
      const write = !["GET", "HEAD"].includes(method) && !list;
      const chart =
        target.startsWith(`/storage/v1/object/cloudtrend-data/${owner}/cache/charts/`) &&
        target.includes(suffix) &&
        target.endsWith(".json.gz") &&
        !target.includes("..");
      if (
        url.hostname !== "ahbvrtugugwnbrfnbxzp.supabase.co" ||
        historical ||
        (write && !(writesEnabled && chart && ["POST", "PUT"].includes(method)))
      ) {
        network.denied++;
        throw new Error(
          "Chart repair blocked a non-chart write or historical Supabase source read",
        );
      }
      if (write) network.chartWrites++;
      else network.reads++;
    }
    return original(input, init);
  };
  return {
    network,
    enable: () => {
      if (request.mode !== "repair") throw new Error("Diagnosis cannot write");
      writesEnabled = true;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export async function repairDriveCharts(directory = "drive-chart-work") {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const request = JSON.parse(
    await readFile(path.join(root, "request.json"), "utf8"),
  ) as RepairRequest;
  if (
    request.version !== "drive-chart-restoration-v1" ||
    !["repair", "diagnose"].includes(request.mode)
  )
    throw new Error("Unreviewed repair request");
  const owner = process.env["SUPABASE_USER_ID"] ?? "";
  const boundary = installChartRepairBoundary(owner, request);
  const started = Date.now();
  const report: Record<string, unknown> = {
    version: "drive-chart-repair-report-v1",
    status: "VERIFYING",
    sourceBackend: "GOOGLE_DRIVE",
    sourceUploads: 0,
    financialHistoryWrites: 0,
    request,
    network: boundary.network,
  };
  const save = () =>
    writeFile(path.join(root, "repair-report.json"), JSON.stringify(report, null, 2));
  const stage = async (name: string, detail: Record<string, unknown> = {}) => {
    report["stage"] = name;
    report["elapsedMs"] = Date.now() - started;
    Object.assign(report, detail);
    await save();
    console.log(JSON.stringify({ stage: name, elapsedMs: Date.now() - started }));
  };
  try {
    const client = trustedSupabaseClient();
    const localHead = JSON.parse(await readFile(path.join(root, "head.json"), "utf8")) as Head;
    const headPath = `${owner}/results/drive-screening/input-head/latest.json`;
    const cachePath = `${owner}/cache/screening/latest.json`;
    const saved = await downloadJson<Saved>(client, cachePath);
    const assertCurrent = async () => {
      const head = await downloadJson<Head>(client, headPath);
      if (
        stableCacheJson(head) !== stableCacheJson(localHead) ||
        !currentDriveGeneration(head, {
          ...saved,
          drivePublication: saved.payload.source.drivePublication,
        })
      )
        throw new Error("Published Drive generation changed during chart repair");
    };
    if (
      saved.version !== SCREENING_CACHE_VERSION ||
      saved.inputFingerprint !== request.inputFingerprint ||
      saved.resultDigest !== request.resultDigest ||
      digest(saved.payload.analysis) !== request.resultDigest
    )
      throw new Error("Saved screening identity does not match reviewed repair");
    await assertCurrent();
    const latest = await downloadJson<{ resultPath: string }>(
      client,
      `${owner}/results/screening/latest.json`,
    );
    if (
      !latest.resultPath.startsWith(`${owner}/results/screening/`) ||
      !/\/[A-Za-z0-9_-]+\.json$/.test(latest.resultPath)
    )
      throw new Error("Invalid saved screening bundle path");
    const bundle = await downloadJson<{ result: AnalysisResult; config: ScoringConfig }>(
      client,
      latest.resultPath,
    );
    if (digest(bundle.result) !== saved.resultDigest)
      throw new Error("Saved calculation and web result differ");
    const metadata = savedOperationalIdentity(bundle.result);
    await stage("saved-generation-verified", { asOfDate: bundle.result.asOfDate });

    const history = await loadDriveHistory(path.join(root, "baseline"));
    // Match the publisher's lossless psql-to-ISO timestamp normalization.
    // File/data/schema hashes and raw Drive bytes are unchanged.
    const inputs = history.inputs.map(liveRegistryInput);
    if (
      inputFingerprint(inputs, bundle.config, metadata) !==
      localHead.drivePublication.baseFingerprint
    )
      throw new Error("Drive baseline/config differs from saved publication");
    const index = JSON.parse(await readFile(path.join(root, "parents/index.json"), "utf8")) as {
      parents: string[];
    };
    let ordinal = 0;
    for (const parent of index.parents) {
      if (!/^parent-\d{3}$/.test(parent)) throw new Error("Invalid parent path");
      const parentRoot = path.join(root, "parents", parent);
      const spec = JSON.parse(await readFile(path.join(parentRoot, "input.json"), "utf8")) as {
        archiveFileId: string;
        archiveSha256: string;
        parts: Array<{ path: string; sha256: string }>;
      };
      for (const part of spec.parts) {
        if (path.basename(part.path) !== part.path || !part.path.endsWith(".csv"))
          throw new Error("Unsafe source path");
        const source = localHead.drivePublication.sources[ordinal++];
        if (
          !source ||
          source.archiveFileId !== spec.archiveFileId ||
          source.archiveSha256 !== spec.archiveSha256 ||
          source.csvFile !== part.path
        )
          throw new Error("Drive parent order or identity changed");
        const bytes = new Uint8Array(await readFile(path.join(parentRoot, part.path)));
        if (hash(bytes) !== part.sha256 || source.record.file_hash !== `sha256:${part.sha256}`)
          throw new Error("Drive source bytes changed");
        const validation = await validateSourceBytes({
          bytes,
          filename: part.path,
          contentType: "text/csv",
          streamingCsv: true,
        });
        if (
          !validation.valid ||
          validation.fileHash !== source.record.file_hash ||
          validation.dataHash !== source.record.data_hash ||
          validation.schemaHash !== source.record.schema_hash
        )
          throw new Error("Drive source canonical validation differs");
        const input: LoadedSourceInput = {
          id: source.record.id,
          fileName: part.path,
          bytes: bytes.byteLength,
          savedAt: source.record.activated_at ?? source.record.created_at,
          text: validation.canonicalCsv,
          fileHash: validation.fileHash,
          dataHash: validation.dataHash,
          schemaHash: validation.schemaHash,
          sourceRecord: source.record as unknown as SourceRecord,
          validation: { ...validation, rows: [] },
        };
        inputs.push(input);
      }
    }
    if (
      ordinal !== localHead.drivePublication.sources.length ||
      inputFingerprint(inputs, bundle.config, metadata) !== saved.inputFingerprint
    )
      throw new Error("Reconstructed Drive inputs differ from the saved screening fingerprint");
    await stage("all-drive-sources-verified", {
      sourceCount: inputs.length,
      baselineSources: 52,
      deltaSources: ordinal,
    });
    const { dataset } = parseManualMarketDataWithReferences(inputs.map((input) => input.text));
    inputs.forEach((input) => {
      input.text = "";
      input.validation.canonicalCsv = "";
      input.validation.rows = [];
    });
    const provider = metadata
      ? await loadOperationalIndex(
          client,
          owner,
          dataset,
          new Date().toISOString(),
          false,
          metadata,
        )
      : undefined;
    if (
      metadata &&
      (!provider ||
        provider.artifactSha256 !== metadata.artifactSha256 ||
        provider.version !== metadata.version ||
        provider.asOfDate !== metadata.asOfDate ||
        provider.availableFrom !== metadata.availableFrom)
    )
      throw new Error("Saved underlying-index identity differs");
    const ctx = restoreChartContext(
      dataset,
      bundle.result,
      bundle.config,
      saved.resultDigest,
      provider,
    );
    const members = new Set(ctx.dataset.instruments.map((instrument) => instrument.symbol));
    const excluded = dataset.instruments
      .filter((instrument) => !members.has(instrument.symbol))
      .map((instrument) => instrument.symbol);
    const old = buildFullUniverseSectorDataset(dataset);
    const samples = ["0127R0", "218420", "360750"].flatMap((symbol) => {
      const row = bundle.result.rows.find((item) => item.instrument.symbol === symbol);
      if (!row) return [];
      return [
        {
          symbol,
          savedM0: etfPartialEvidence(row, bundle.result.asOfDate).score,
          beforeM0: etfInstrumentChartSeries(old, symbol).chart.at(-1)?.m0Score ?? null,
          restoredM0: etfInstrumentChartSeries(ctx.dataset, symbol).chart.at(-1)?.m0Score ?? null,
        },
      ];
    });
    await stage("saved-peer-universe-restored", {
      rawUniverse: dataset.instruments.length,
      savedUniverse: members.size,
      excluded,
      samples,
    });
    if (request.mode === "diagnose") {
      report["status"] = "VERIFIED_READ_ONLY";
      return report;
    }
    await assertCurrent();
    boundary.enable();
    await warmRecentCharts(client, owner, saved, ctx);
    await stage("recent-charts-ready");
    const coverage = await warmFullInstrumentCharts(client, owner, saved, ctx, {
      includeStocks: request.includeStocks === true,
      progress: async (completed, total) => {
        if (completed % 64 === 0 || completed === total) {
          await assertCurrent();
          await stage("full-history-charts", { completed, total });
        }
      },
    });
    await assertCurrent();
    const after = await downloadJson<Saved>(client, cachePath);
    if (
      after.inputFingerprint !== saved.inputFingerprint ||
      digest(after.payload.analysis) !== saved.resultDigest
    )
      throw new Error("Screening changed during repair");
    report["status"] = "COMPLETED_VERIFIED";
    report["coverage"] = coverage;
    report["etfCharts"] = coverage.filter((item) => item.kind === "ETF").length;
    report["stockCharts"] = coverage.filter((item) => item.kind === "STOCK").length;
    report["scoreObservations"] = coverage.reduce(
      (sum, item) => sum + (item.m0Observations ?? 0),
      0,
    );
    report["screeningDigestUnchanged"] = true;
    await stage("complete");
    return report;
  } catch (error) {
    report["status"] = "FAILED";
    report["error"] = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report["elapsedMs"] = Date.now() - started;
    report["peakRssBytes"] = process.resourceUsage().maxRSS * 1024;
    boundary.restore();
    await save();
  }
}

if (!process.env["VITEST"])
  repairDriveCharts().catch((error) => {
    console.error(error instanceof Error ? error.message : "Drive chart repair failed");
    process.exitCode = 1;
  });
