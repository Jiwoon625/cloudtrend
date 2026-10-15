import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { shadowEngineManifest } from "./october-shadow-code-manifest";
import { hashSeriesValue } from "../src/lib/ledger/modelSeries";

/** Publication identity only. This does not redefine any frozen economic series. */
export const KOSPI_SHADOW_PUBLICATION_ROOTS = [
  "scripts/run-kospi-shadow.ts",
  "src/lib/kospiShadowSeries.ts",
  "src/lib/kospiShadowStore.ts",
  "scripts/kospi-shadow-runtime.config.ts",
  "scripts/kospi-shadow-code-manifest.ts",
  "scripts/build-kospi-shadow-manifest.ts",
] as const;
export async function kospiShadowPublicationManifest(root = process.cwd()) {
  const semantic = await shadowEngineManifest(
    root,
    KOSPI_SHADOW_PUBLICATION_ROOTS,
    "kospi-shadow-publication-runtime-v2",
    ["/kospiShadowPublicationRuntime.generated.json", "/kospiShadowRuntimeAdmissions.json"],
  );
  // Raw source binding lets a Node-only bootstrap verify before importing any project code.
  // Formatting intentionally changes this separate publication identity, not economic hashes.
  const rawFiles = Object.fromEntries(
    await Promise.all(
      Object.keys(semantic.manifest.files).map(async (file) => [
        file,
        `sha256:${createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex")}`,
      ]),
    ),
  );
  const manifest = { ...semantic.manifest, rawFiles };
  return { manifest, codeHash: await hashSeriesValue(manifest) };
}
