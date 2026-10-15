import { shadowEngineManifest } from "./october-shadow-code-manifest";
export const INTEGRATED_ALLOCATION_ROOTS = [
  "src/lib/integratedAllocationShadow.ts",
  "src/lib/integratedAllocationReplayAdapter.ts",
  "src/lib/integratedAllocationPublication.ts",
  "src/lib/integratedAllocationReplay.server.ts",
  "src/lib/shadowReplay.server.ts",
] as const;
export function integratedAllocationRuntimeManifest(root = process.cwd()) {
  return shadowEngineManifest(
    root,
    INTEGRATED_ALLOCATION_ROOTS,
    "integrated-allocation-runtime-v1",
    ["/integratedAllocationRuntime.generated.json", "/integratedAllocationRuntimeAdmissions.json"],
  );
}
