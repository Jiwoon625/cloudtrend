import { writeFile } from "node:fs/promises";
import { integratedAllocationRuntimeManifest } from "./integrated-allocation-code-manifest";
const result = await integratedAllocationRuntimeManifest();
await writeFile(
  "src/lib/integratedAllocationRuntime.generated.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(`Integrated allocation runtime: ${result.codeHash}`);
