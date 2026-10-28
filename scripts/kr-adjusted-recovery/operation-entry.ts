import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pureEnvironment } from "../kr-vintage-preflight/runner";
import { requireCheck } from "../kr-vintage-preflight/transport";
import { materializeOperation, appendOperationPlan } from "./operation-transport";
import { verifyFullRecoveryPlan } from "./operation-schema";
async function main() {
  const root = process.env.RUNNER_TEMP ?? "";
  requireCheck(path.isAbsolute(root));
  const directory = path.join(root, "kr-adjusted-operation-private"),
    mode = process.argv[2],
    manifestHash = process.env.EXPECTED_OPERATION_HASH ?? "";
  const connection = {
    origin: process.env.SUPABASE_URL ?? "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: process.env.SUPABASE_USER_ID ?? "",
  };
  if (mode === "materialize") {
    await materializeOperation({
      ...connection,
      manifestHash,
      directory,
      codeVersion: process.env.GITHUB_SHA ?? "",
    });
    return { status: "OPERATION_INPUTS_MATERIALIZED", operationalApproval: false };
  }
  const input = JSON.parse(fs.readFileSync(path.join(directory, "operation-input.json"), "utf8")),
    read = (ref: { path: string }) => JSON.parse(fs.readFileSync(ref.path, "utf8"));
  const manifest = read(input.operation.manifest),
    preparation = read(input.operation.preparation);
  if (mode === "compute") {
    const child = spawnSync(
      process.execPath,
      [
        path.join(root, "kr-adjusted-operation-code/pure.mjs"),
        path.join(directory, "operation-input.json"),
        path.join(directory, "result"),
      ],
      {
        env: pureEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 60 * 60 * 1000,
      },
    );
    requireCheck(child.status === 0 && !child.error);
    const value = JSON.parse(
      fs.readFileSync(path.join(directory, "result/full-plan.json"), "utf8"),
    );
    await verifyFullRecoveryPlan(value.payload, value.hash, manifest, manifestHash);
    return {
      status: "FULL_PLAN_COMPUTED_REVIEW_REQUIRED",
      hash: value.hash,
      newModelSessions: 12,
      operationalApproval: false,
    };
  }
  requireCheck(mode === "append");
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "result/full-plan.json"), "utf8"));
  await verifyFullRecoveryPlan(saved.payload, saved.hash, manifest, manifestHash);
  return {
    status: "FULL_PLAN_PRIVATE_EVIDENCE_APPENDED",
    ...(await appendOperationPlan({
      ...connection,
      manifestHash,
      manifest,
      preparation,
      payload: saved.payload,
    })),
    operationalApproval: false,
  };
}
main()
  .then((x) => console.log(JSON.stringify(x)))
  .catch(() => {
    console.log(JSON.stringify({ status: "OPERATION_PLAN_REJECTED", operationalApproval: false }));
    process.exitCode = 1;
  });
