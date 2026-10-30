/** PLAN only: owner-private capture, credential-free computation, immutable evidence. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pureEnvironment } from "../kr-vintage-preflight/runner";
import { requireCheck } from "../kr-vintage-preflight/transport";
import {
  capture,
  readEvidence,
  appendEvidence,
  assertCaptureFresh,
  assertCaptureByteLength,
} from "./transport";
import { captureCanonicalChunks, captureCanonicalProof } from "./capture-codec";
// Public diagnostics contain fixed phase labels only, never exception text or private values.
let diagnosticPhase = "WORKFLOW_ADMISSION";
export function assertWorkflow(env = process.env) {
  requireCheck(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW === "KR final retrospective reviewed PLAN APPLY" &&
      env.RECOVERY_CONCURRENCY_GROUP === "kospi-prospective-shadow" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
  );
}
async function main() {
  assertWorkflow();
  const root = process.env.RUNNER_TEMP ?? "";
  requireCheck(path.isAbsolute(root));
  const dir = path.join(root, "kr-final-retrospective-private");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const mode = process.argv[2],
    requestHash = process.env.EXPECTED_REQUEST_HASH ?? "",
    code = process.env.GITHUB_SHA ?? "";
  const o = {
    origin: process.env.SUPABASE_URL ?? "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: process.env.SUPABASE_USER_ID ?? "",
  };
  if (mode === "materialize") {
    diagnosticPhase = "REQUEST_READ";
    const request = await readEvidence(o, "request", requestHash);
    diagnosticPhase = "PRIVATE_CAPTURE";
    const value = await capture(o, request, requestHash, code, (diagnostic) =>
      console.log(JSON.stringify(diagnostic)),
    );
    diagnosticPhase = "CAPTURE_SERIALIZATION";
    const proof = captureCanonicalProof(value);
    assertCaptureByteLength(proof.bytes);
    console.log(JSON.stringify({ status: "CAPTURE_JSON_BYTES", bytes: proof.bytes }));
    diagnosticPhase = "CAPTURE_FILE_WRITE";
    const file = path.join(dir, "capture.json");
    const fd = fs.openSync(file, "wx", 0o600),
      digest = createHash("sha256");
    let bytes = 0;
    try {
      for (const chunk of captureCanonicalChunks(value)) {
        bytes += chunk.byteLength;
        assertCaptureByteLength(bytes);
        fs.writeFileSync(fd, chunk);
        digest.update(chunk);
      }
      requireCheck(bytes === proof.bytes && "sha256:" + digest.digest("hex") === proof.hash);
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    return {
      status: "PRIVATE_CAPTURE_READY",
      captureBytes: proof.bytes,
      historicalAvailabilityClaim: false,
    };
  }
  const readCapture = () => {
    const captured = JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8"));
    requireCheck(
      captured.codeCommit === code && captured.captureManifest.requestHash === requestHash,
    );
    return captured;
  };
  if (mode === "compute") {
    diagnosticPhase = "CREDENTIAL_FREE_COMPUTE";
    const child = spawnSync(
      process.execPath,
      [
        path.join(root, "kr-final-retrospective-code/pure.mjs"),
        path.join(dir, "capture.json"),
        path.join(dir, "plan.json"),
        code,
        requestHash,
      ],
      {
        env: pureEnvironment(dir),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 60 * 60 * 1000,
      },
    );
    requireCheck(child.status === 0 && !child.error);
    // The child checks the same pins before calculation. Load the parent's copy
    // only after the child exits, avoiding two simultaneous full capture copies.
    const captured = readCapture();
    const p = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    requireCheck(p.captureHash === captureCanonicalProof(captured).hash);
    return {
      status: "PLAN_COMPUTED_REVIEW_REQUIRED",
      planHash: captureCanonicalProof(p).hash,
      historicalAvailabilityClaim: false,
    };
  }
  requireCheck(mode === "append");
  diagnosticPhase = "PLAN_EVIDENCE_FRESHNESS_AND_APPEND";
  const captured = readCapture();
  const p = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  requireCheck(
    p.version === "kr-final-retrospective-plan-v1" &&
      p.captureHash === captureCanonicalProof(captured).hash &&
      p.preparation.codeCommit === code &&
      p.operationalApproval === false &&
      p.historicalAvailabilityClaim === false,
  );
  await assertCaptureFresh(o, captured);
  const captureEvidence = await appendEvidence(o, "capture", captured);
  requireCheck(captureEvidence.hash === p.captureHash);
  await assertCaptureFresh(o, captured);
  return {
    status: "PLAN_PRIVATE_EVIDENCE_STORED_REVIEW_REQUIRED",
    ...(await appendEvidence(o, "plan", p)),
    captureHash: captureEvidence.hash,
    historicalAvailabilityClaim: false,
  };
}
main()
  .then((x) => console.log(JSON.stringify(x)))
  .catch(() => {
    console.log(
      JSON.stringify({ status: "FINAL_RETROSPECTIVE_PLAN_REJECTED", phase: diagnosticPhase }),
    );
    process.exitCode = 1;
  });
