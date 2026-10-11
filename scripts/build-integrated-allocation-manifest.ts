import { writeFile } from "node:fs/promises";
import { shadowEngineManifest } from "./october-shadow-code-manifest";
export const INTEGRATED_ALLOCATION_ROOTS = [
  "src/lib/integratedAllocationShadow.ts",
  "src/lib/integratedAllocationReplayAdapter.ts",
  "src/lib/integratedAllocationPublication.ts",
  "src/lib/integratedAllocationReplay.server.ts",
  "src/lib/shadowReplay.server.ts",
] as const;
const result = await shadowEngineManifest(
  process.cwd(),
  INTEGRATED_ALLOCATION_ROOTS,
  "integrated-allocation-runtime-v1",
  ["/integratedAllocationRuntime.generated.json"],
);
await writeFile(
  "src/lib/integratedAllocationRuntime.generated.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(`Integrated allocation runtime: ${result.codeHash}`);
