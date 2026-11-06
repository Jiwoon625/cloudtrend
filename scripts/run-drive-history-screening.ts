import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadDriveHistory, hashBytes, KR_BASELINE_SHA, KR_OWNER } from "./drive-history-inputs";
import { installDriveReadOnlyNetwork } from "./drive-history-network";
import { recordFor } from "./source-registry-store";
import { validateSourceBytes, compareSourceRows } from "../src/lib/sourceData";
import {
  parseKrPublicationRequest,
  validateKrPublicationManifest,
} from "../src/lib/krScreeningPublication";
import { buildKrSourcePublication } from "../src/lib/krScreeningPublication.server";
import { runScreening } from "./run-screening";

export async function runDriveHistoryScreening(directory: string, publishDashboard = false) {
  // Never remove the old providedInputs + upload guard. A future publisher must verify web identity too.
  if (publishDashboard)
    throw new Error(
      "Dashboard publication is not enabled: live equivalence, web identity and distributed writer-lock verification are required",
    );
  if (process.env["SUPABASE_USER_ID"] !== KR_OWNER)
    throw new Error("Pinned baseline owner mismatch");
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const started = Date.now();
  const boundary = installDriveReadOnlyNetwork();
  const validations: Record<string, unknown>[] = [];
  const receipt: Record<string, unknown> = {
    version: "drive-history-execution-v1",
    history_backend: "drive",
    result_backend: "drive",
    publish_dashboard: false,
    baselineSha256: KR_BASELINE_SHA,
    status: "VALIDATING",
    queriedAt: new Date().toISOString(),
    network: boundary.receipt,
  };
  const save = () =>
    writeFile(path.join(root, "execution-receipt.json"), JSON.stringify(receipt, null, 2));
  try {
    const { inputs, evidence } = await loadDriveHistory(path.join(root, "baseline"), async (r) => {
      validations.push(r);
      await writeFile(
        path.join(root, "validation-receipt.json"),
        JSON.stringify(validations, null, 2),
      );
    });
    receipt["inputEvidence"] = evidence;
    let manifestText: string | null = null;
    try {
      manifestText = await readFile(path.join(root, "run-manifest.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (manifestText) {
      const m = JSON.parse(manifestText);
      const identity = JSON.parse(await readFile(path.join(root, "run-identity.json"), "utf8"));
      if (
        hashBytes(manifestText) !== identity.sha256 ||
        m.baselineSha256 !== KR_BASELINE_SHA ||
        m.parentManifestSha256 !== KR_BASELINE_SHA ||
        m.complete !== true ||
        m.correctionCount !== 0
      )
        throw new Error("Run integrity/parent/complete contract mismatch");
      const publication = parseKrPublicationRequest({
        version: "kr-screening-publication-v1",
        phase: m.krxPublicationEvidence?.phase,
        requestId: m.runId,
        manifestText,
        manifestSha256: `sha256:${identity.sha256}`,
      });
      validateKrPublicationManifest(publication, m.actualLatestPriceDate);
      if (
        new Set(m.deltaMembers.map((p: { name: string }) => p.name)).size !== m.deltaMembers.length
      )
        throw new Error("Duplicate delta parts");
      const latestSymbols = new Set<string>();
      const indexes = new Set<string>();
      const keys = new Set<string>();
      for (const part of m.deltaMembers) {
        if (
          typeof part.name !== "string" ||
          path.basename(part.name) !== part.name ||
          !part.name.endsWith(".csv")
        )
          throw new Error("Unsafe daily part");
        const bytes = new Uint8Array(await readFile(path.join(root, "delta", part.name)));
        if (hashBytes(bytes) !== part.sha256 || bytes.length !== part.bytes)
          throw new Error("Delta part changed");
        const validation = await validateSourceBytes({
          bytes,
          filename: part.name,
          streamingCsv: true,
        });
        if (
          !validation.valid ||
          !validation.stats.maxDate ||
          validation.stats.maxDate > m.actualLatestPriceDate
        )
          throw new Error("Delta source validation failed");
        const id = `drive-v7-${hashBytes(m.runId + part.sha256).slice(0, 32)}`;
        const source = recordFor({
          id,
          userId: KR_OWNER,
          sourceType: "screening",
          origin: "github_action",
          storagePath: `drive://${identity.fileId}/${part.name}`,
          validation,
          overlap: compareSourceRows([], []),
        });
        const sourceRecord = {
          ...source,
          storage_bucket: "google-drive",
          status: "active" as const,
          created_at: m.createdAt,
          activated_at: m.createdAt,
          updated_at: m.createdAt,
          superseded_by: null,
          validation_result: {
            ...source.validation_result,
            krPublication: buildKrSourcePublication(publication, source),
          },
        };
        // Validate canonical coverage without an alternate merge or deduplication policy.
        const { visitDelimitedRows } = await import("../src/lib/sourceData");
        visitDelimitedRows(validation.canonicalCsv, (row, index) => {
          if (index === 0) return;
          const key = `${row[0]}\u0000${row[4]}`;
          if (keys.has(key)) throw new Error("Duplicate delta symbol/date");
          keys.add(key);
          if (row[4] === m.actualLatestPriceDate && Number(row[8]) > 0) {
            if (["STOCK", "ETF"].includes(row[3] ?? "")) latestSymbols.add(row[0]!);
            else indexes.add(row[0]!);
          }
        });
        inputs.push({
          id,
          fileName: part.name,
          bytes: bytes.length,
          savedAt: m.createdAt,
          text: validation.canonicalCsv,
          fileHash: validation.fileHash,
          dataHash: validation.dataHash,
          schemaHash: validation.schemaHash,
          sourceRecord,
          validation: { ...validation, rows: [] },
        });
      }
      if (
        JSON.stringify([...latestSymbols].sort()) !==
          JSON.stringify([...m.requestedSymbols].sort()) ||
        !indexes.has("KOSPI") ||
        !indexes.has("KOSDAQ")
      )
        throw new Error("Target date universe/index coverage differs from manifest");
      receipt["runManifestSha256"] = identity.sha256;
      receipt["sourceAsOfDate"] = m.actualLatestPriceDate;
      receipt["missingPriceExcludedSymbols"] = m.missingPriceExcludedSymbols;
    }
    receipt["status"] = "CALCULATING";
    await save();
    const result = await runScreening(
      ["--supabase-user-id", KR_OWNER, "--output", path.join(root, "results"), "--force"],
      inputs,
      {
        kind: "VERIFIED_IMMUTABLE_DRIVE_HISTORY",
        ...evidence,
        runManifestSha256: receipt["runManifestSha256"] ?? null,
      },
    );
    receipt["status"] = "COMPLETED_CALCULATION_ONLY";
    receipt["result"] = result;
  } catch (e) {
    receipt["status"] = "FAILED";
    receipt["failureClass"] = e instanceof Error ? e.name : "Unknown";
    throw e;
  } finally {
    receipt["elapsedMs"] = Date.now() - started;
    receipt["peakRssBytes"] = process.resourceUsage().maxRSS * 1024;
    boundary.restore();
    await save();
  }
  return receipt;
}
if (
  !process.env["VITEST"] &&
  path.basename(process.argv[1] ?? "") === "run-drive-history-screening.ts"
)
  runDriveHistoryScreening(
    process.env["DRIVE_HISTORY_DIRECTORY"] ?? "drive-history-work",
    process.env["PUBLISH_DASHBOARD"] === "true",
  ).catch(() => {
    process.stderr.write(
      "Drive history execution failed; inspect validation receipt and server configuration.\n",
    );
    process.exitCode = 1;
  });
