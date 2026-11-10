import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadDriveHistory, KR_BASELINE_SHA, KR_OWNER } from "./drive-history-inputs";
import { installDriveReadOnlyNetwork } from "./drive-history-network";
import { runDriveScreening } from "./run-drive-screening";
import { runScreening } from "./run-screening";
import { prepareDriveCharts } from "./prepare-drive-result-charts";

/** A published dashboard is not a completed release while its charts are unavailable. */
export function driveHistoryExitCode(receipt: Record<string, unknown>) {
  return receipt["status"] === "COMPLETED_PUBLISHED_CHARTS_PENDING" ? 1 : 0;
}

/** Reuse the frozen engine and result publisher; never register or upload source CSV. */
export async function runDriveHistoryScreening(directory: string, publishDashboard = false) {
  if (process.env["SUPABASE_USER_ID"] !== KR_OWNER)
    throw new Error("Pinned baseline owner mismatch");
  // Branch-independent shared workflow serialization, not a claim of a distributed CAS lock.
  if (
    publishDashboard &&
    (process.env["GITHUB_ACTIONS"] !== "true" ||
      !process.env["GITHUB_WORKFLOW_REF"]?.includes(
        "/.github/workflows/drive-history-screening-v7.yml@",
      ))
  )
    throw new Error("V7 publication requires the shared screening-writer Actions workflow");
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const started = Date.now();
  const boundary = installDriveReadOnlyNetwork();
  const validations: Record<string, unknown>[] = [];
  const receipt: Record<string, unknown> = {
    version: "drive-history-execution-v1",
    history_backend: "drive",
    result_backend: "drive",
    publish_dashboard: publishDashboard,
    dashboardPublished: false,
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
    let prepared: { mode?: string } | undefined;
    try {
      prepared = JSON.parse(await readFile(path.join(root, "prepared/input.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    receipt["status"] = "CALCULATING";
    await save();
    if (prepared) {
      if (prepared.mode !== (publishDashboard ? "publish" : "drive"))
        throw new Error("Prepared run and publication option differ");
      if (publishDashboard) process.env["CT_PREPARE_CHARTS"] = "true";
      await runDriveScreening(path.join(root, "prepared"), false, {
        inputs,
        provenance: { kind: "VERIFIED_IMMUTABLE_DRIVE_HISTORY", ...evidence },
        beforePublish: (runId) => boundary.enableResultWrites(KR_OWNER, runId),
      });
      const result = JSON.parse(
        await readFile(path.join(root, "prepared/execution-receipt.json"), "utf8"),
      );
      receipt["result"] = result;
      receipt["dashboardPublished"] = result.dashboardPublished === true;
      receipt["phase"] = result.phase;
      receipt["status"] = publishDashboard ? "COMPLETED_PUBLISHED" : "COMPLETED_CALCULATION_ONLY";
      if (publishDashboard && result.dashboardPublished === true) {
        boundary.restore();
        receipt["status"] = "COMPLETED_PUBLISHED_CHARTS_PENDING";
        receipt["recentChartsPrepared"] = false;
        receipt["fullChartsPrepared"] = false;
        await save();
        try {
          await prepareDriveCharts(path.join(root, "prepared"));
          receipt["recentChartsPrepared"] = true;
          receipt["fullChartsPrepared"] = true;
          receipt["status"] = "COMPLETED_PUBLISHED";
        } catch (chartError) {
          process.stderr.write(
            `Chart preparation incomplete: ${chartError instanceof Error ? chartError.message : String(chartError)}\n`,
          );
          receipt["chartPreparationError"] =
            chartError instanceof Error ? chartError.message : String(chartError);
        }
      }
    } else {
      if (publishDashboard)
        throw new Error("Completed collection manifest required for publication");
      // Retain the original baseline-only comparison mode; it never publishes.
      receipt["result"] = await runScreening(
        ["--supabase-user-id", KR_OWNER, "--output", path.join(root, "results"), "--force"],
        inputs,
        { kind: "VERIFIED_IMMUTABLE_DRIVE_HISTORY", ...evidence },
      );
      receipt["status"] = "COMPLETED_CALCULATION_ONLY";
    }
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
if (!process.env["VITEST"])
  runDriveHistoryScreening(
    process.env["DRIVE_HISTORY_DIRECTORY"] ?? "drive-history-work",
    process.env["PUBLISH_DASHBOARD"] === "true",
  )
    .then((receipt) => {
      process.exitCode = driveHistoryExitCode(receipt);
    })
    .catch((e) => {
      process.stderr.write(
        `Drive history execution failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exitCode = 1;
    });
