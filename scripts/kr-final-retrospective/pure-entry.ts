/** No credentials, network imports, or write-capable repository adapters. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { prepareFinalRetrospectiveOutcome } from "./core";
import { captureCanonicalChunks, captureCanonicalProof } from "./capture-codec";
import { classifyFinalComputeFailure, type FinalComputeStage } from "./contracts";
let stage: FinalComputeStage = "CAPTURE_READ";
function emitStage(next: FinalComputeStage) {
  stage = next;
  console.error(JSON.stringify({ kind: "STAGE", stage }));
}
async function main() {
  emitStage("CAPTURE_READ");
  const capture = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
  emitStage("IDENTITY");
  const code = process.argv[4] ?? "",
    requestHash = process.argv[5] ?? "";
  if (
    !/^[a-f0-9]{40}$/.test(code) ||
    !/^sha256:[a-f0-9]{64}$/.test(requestHash) ||
    capture.codeCommit !== code ||
    capture.captureManifest.requestHash !== requestHash
  )
    throw Error("PURE_CAPTURE_IDENTITY_REJECTED");
  const plan = await prepareFinalRetrospectiveOutcome(capture, emitStage);
  emitStage("PLAN_WRITE");
  const proof = captureCanonicalProof(plan),
    limit = 256 * 1024 * 1024;
  if (proof.bytes <= 0 || proof.bytes > limit) throw Error("PLAN_SIZE_REJECTED");
  const file = process.argv[3]!,
    fd = fs.openSync(file, "wx", 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for (const chunk of captureCanonicalChunks(plan)) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw Error("PLAN_SIZE_REJECTED");
      fs.writeFileSync(fd, chunk);
      digest.update(chunk);
    }
    if (bytes !== proof.bytes || "sha256:" + digest.digest("hex") !== proof.hash)
      throw Error("PLAN_WRITE_REJECTED");
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  emitStage("DONE");
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ kind: "FAILURE", stage, ...classifyFinalComputeFailure(error) }));
  process.exitCode = 1;
});
