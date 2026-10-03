import { writeFile } from "node:fs/promises";
import { shadowEngineManifest } from "./october-shadow-code-manifest";
const result = await shadowEngineManifest();
await writeFile(
  "src/lib/ledger/octoberShadowEngineManifest.generated.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  `October Shadow engine manifest: ${result.codeHash} (${Object.keys(result.manifest.files).length} calculation sources)`,
);
