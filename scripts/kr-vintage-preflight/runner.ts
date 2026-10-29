import { publicComputationPhase } from "./phases";
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { materializeCapsule, requireCheck } from "./transport";

export const publicStatuses = [
  "BLOCKED_BASELINE_NOT_REPRODUCED",
  "BASELINE_REPRODUCED_OVERLAY_PENDING",
  "EVIDENCE_COMPARED_INTEGRATED_REPLAY_INPUTS_PENDING",
  "PREFLIGHT_COMPARED_NO_OPERATIONAL_APPROVAL",
  "BLOCKED_INTEGRATED_BASELINE_NOT_REPRODUCED",
] as const;
/** Never serialize the report, diffs, strings, paths, hashes, symbols or caught error. */
export function publicSummary(report: any) {
  requireCheck(
    publicStatuses.includes(report?.status) &&
      report.operationalApproval === false &&
      report.counterfactual === true,
  );
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const count = (v: unknown) =>
    Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 1_000_000 ? Number(v) : null;
  return {
    mode: "READ_ONLY_COUNTERFACTUAL",
    status: report.status,
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    baselineEqual: bool(report.baselineEvidence?.equal),
    baselineSourceHashEqual: bool(report.baselineSourceHashMatches),
    candidateEqual: bool(report.candidateEvidence?.equal),
    changedEvidenceLeaves: count(report.candidateEvidence?.changedLeafCount),
    changedSnapshotLeaves: count(report.snapshotEntries?.changedLeafCount),
    integrated: ["O1", "S07"].map((kind) => ({
      kind,
      baselineEqual: bool(report.books?.[kind]?.baselineReproduced?.equal),
      candidateEqual: bool(report.books?.[kind]?.candidatePublication?.equal),
      sessionInputsEqualExceptSourceHash: bool(
        report.books?.[kind]?.sessionInputsEqualExceptSourceHash,
      ),
    })),
  };
}
export function pureEnvironment(temp: string) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: temp,
    HOME: temp,
    NODE_OPTIONS: "--max-old-space-size=8192",
  };
}
export function compute(directory: string, pureEntry: string) {
  // No service credentials, GitHub token, proxy or arbitrary NODE_OPTIONS reach computation.
  const output = path.join(directory, "result");
  const child = spawnSync(
    process.execPath,
    [pureEntry, path.join(directory, "input.json"), output],
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
      const value = JSON.parse(
        fs.readFileSync(path.join(directory, "failure-summary.json"), "utf8"),
      ).phase;
      phase = publicComputationPhase(value);
    } catch {
      /* No raw child error crosses the boundary. */
    }
    return {
      mode: "READ_ONLY_COUNTERFACTUAL",
      status: "PREFLIGHT_REJECTED",
      phase,
      operationalApproval: false,
    };
  }
  return publicSummary(JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8")));
}
export async function main(mode: string, revision: string, root: string) {
  requireCheck(path.isAbsolute(root) && /^[1-9]\d{0,2}$/.test(revision));
  const directory = path.join(root, "kr-vintage-preflight-private");
  if (mode === "materialize") {
    await materializeCapsule({
      origin: process.env.SUPABASE_URL ?? "",
      key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      owner: process.env.SUPABASE_USER_ID ?? "",
      revision,
      expectedCapsuleHash: process.env.EXPECTED_CAPSULE_HASH ?? "",
      directory,
    });
    return { mode: "READ_ONLY_COUNTERFACTUAL", status: "MATERIALIZED", operationalApproval: false };
  }
  requireCheck(mode === "compute");
  return compute(directory, path.join(root, "kr-vintage-preflight-code", "pure.mjs"));
}
