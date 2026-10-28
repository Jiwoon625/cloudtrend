import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  materializePreparation,
  appendPreparation,
  diagnosePreparationMetadata,
} from "./transport";
import { verifyPreparationPayload } from "./verify";
import { pureEnvironment } from "../kr-vintage-preflight/runner";
import { requireCheck } from "../kr-vintage-preflight/transport";
let failurePhase = "ENTRY_VALIDATION";
async function main() {
  const root = process.env.RUNNER_TEMP ?? "",
    planHash = process.env.EXPECTED_PLAN_HASH ?? "",
    capsuleHash = process.env.EXPECTED_CAPSULE_HASH ?? "";
  requireCheck(path.isAbsolute(root));
  const directory = path.join(root, "kr-adjusted-recovery-private"),
    mode = process.argv[2];
  const authority = {
    origin: process.env.SUPABASE_URL ?? "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: process.env.SUPABASE_USER_ID ?? "",
  };
  if (mode === "diagnose" || mode === "diagnose-bytes") {
    failurePhase = "METADATA_DIAGNOSTIC";
    return diagnosePreparationMetadata({
      ...authority,
      capsuleHash,
      planHash,
      includeBytes: mode === "diagnose-bytes",
    });
  }
  if (mode === "materialize") {
    await materializePreparation({
      ...authority,
      capsuleHash,
      planHash,
      directory,
      codeVersion: process.env.GITHUB_SHA ?? "",
      onPhase: (phase) => {
        failurePhase = phase;
      },
    });
    return { status: "PREPARATION_MATERIALIZED", operationalApproval: false };
  }
  if (mode === "compute") {
    failurePhase = "COMPUTE_VALIDATION";
    const output = path.join(directory, "result");
    const child = spawnSync(
      process.execPath,
      [
        path.join(root, "kr-adjusted-recovery-code", "pure.mjs"),
        path.join(directory, "preparation-input.json"),
        output,
      ],
      {
        env: pureEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 40 * 60 * 1000,
      },
    );
    if (child.status !== 0 || child.error) {
      let phase = "CHILD_EXECUTION";
      try {
        const v = JSON.parse(
          fs.readFileSync(path.join(directory, "failure-summary.json"), "utf8"),
        ).phase;
        if (
          [
            "INPUT_VALIDATION",
            "SOURCE_VALIDATION",
            "BASELINE_REPRODUCTION",
            "CAPTURE_VALIDATION",
            "OVERLAY_DERIVATION",
            "CANDIDATE_COMPARISON",
            "INTEGRATED_COMPARISON",
            "OUTPUT_VALIDATION",
          ].includes(v)
        )
          phase = v;
      } catch {
        /* Never expose private child diagnostics. */
      }
      return { status: "PREPARATION_REJECTED", phase, operationalApproval: false };
    }
    const payload = JSON.parse(fs.readFileSync(path.join(output, "preparation.json"), "utf8"));
    const hash = await verifyPreparationPayload(payload, planHash, capsuleHash);
    fs.writeFileSync(
      path.join(directory, "verified-preparation.json"),
      JSON.stringify({ hash, payload }),
      { flag: "wx", mode: 0o600 },
    );
    return {
      status: "PREPARATION_COMPUTED",
      hash,
      changedArchivePairs: payload.archivePairs.length,
      historyCorrectionRows: payload.candidate.historyCorrection.rowCount,
      kospiPrepared: payload.kospi.result.plan !== null,
      operationalApproval: false,
    };
  }
  requireCheck(mode === "append");
  failurePhase = "APPEND_VALIDATION";
  const saved = JSON.parse(
    fs.readFileSync(path.join(directory, "verified-preparation.json"), "utf8"),
  );
  requireCheck(
    saved.hash === (await verifyPreparationPayload(saved.payload, planHash, capsuleHash)),
  );
  const result = await appendPreparation({
    ...authority,
    payload: saved.payload,
    expectedPlanHash: planHash,
    expectedCapsuleHash: capsuleHash,
  });
  return { status: "PREPARATION_EVIDENCE_APPENDED", ...result, operationalApproval: false };
}
main()
  .then((summary) => {
    console.log(JSON.stringify(summary));
    if (summary.status === "PREPARATION_REJECTED") process.exitCode = 1;
  })
  .catch(() => {
    console.log(
      JSON.stringify({
        status: "PREPARATION_REJECTED",
        phase: failurePhase,
        operationalApproval: false,
      }),
    );
    process.exitCode = 1;
  });
