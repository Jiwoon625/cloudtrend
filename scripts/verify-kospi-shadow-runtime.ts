import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { kospiShadowPublicationManifest } from "./kospi-shadow-code-manifest";
import { canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import {
  reviewedKospiShadowRuntime,
  type KospiShadowRuntimeAdmissions,
} from "../src/lib/kospiShadowRuntimeAdmission";

/** Recompute actual publication code before any private reads or external mutations. */
export async function verifyKospiShadowRuntimeManifest(root = process.cwd()) {
  const actual = await kospiShadowPublicationManifest(root);
  const saved = JSON.parse(
    await readFile(path.join(root, "src/lib/kospiShadowPublicationRuntime.generated.json"), "utf8"),
  );
  if (canonicalSeriesJson(saved) !== canonicalSeriesJson(actual))
    throw new Error("Stale KOSPI Shadow publication executable manifest");
  const reviews = JSON.parse(
    await readFile(path.join(root, "src/lib/kospiShadowRuntimeAdmissions.json"), "utf8"),
  ) as KospiShadowRuntimeAdmissions;
  reviewedKospiShadowRuntime(actual.codeHash, reviews);
  return { kospiRuntimeCodeHash: actual.codeHash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  verifyKospiShadowRuntimeManifest().catch(() => {
    console.error("KOSPI publication runtime preflight failed; no private inputs were accessed.");
    process.exitCode = 1;
  });
