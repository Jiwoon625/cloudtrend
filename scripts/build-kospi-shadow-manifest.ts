import { writeFile } from "node:fs/promises";
import { kospiShadowPublicationManifest } from "./kospi-shadow-code-manifest";

// Generation records executable bytes; it never adds or changes a reviewed admission.
const result = await kospiShadowPublicationManifest();
await writeFile(
  "src/lib/kospiShadowPublicationRuntime.generated.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(`KOSPI Shadow publication runtime: ${result.codeHash}`);
