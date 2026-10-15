import { shadowEngineManifest } from "./october-shadow-code-manifest";

/** Publication identity only. This does not redefine any frozen economic series. */
export const KOSPI_SHADOW_PUBLICATION_ROOTS = [
  "scripts/run-kospi-shadow.ts",
  "src/lib/kospiShadowSeries.ts",
  "src/lib/kospiShadowStore.ts",
] as const;
export function kospiShadowPublicationManifest(root = process.cwd()) {
  return shadowEngineManifest(
    root,
    KOSPI_SHADOW_PUBLICATION_ROOTS,
    "kospi-shadow-publication-runtime-v1",
    ["/kospiShadowPublicationRuntime.generated.json", "/kospiShadowRuntimeAdmissions.json"],
  );
}
