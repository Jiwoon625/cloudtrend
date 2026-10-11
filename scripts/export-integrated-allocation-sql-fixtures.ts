import { createIntegratedAllocationShadow } from "../src/lib/integratedAllocationShadow";
import { canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import { integratedRegistry } from "../src/lib/integratedAllocationPublication";
import { writeFile } from "node:fs/promises";
const out: Record<string, unknown> = {};
for (const kind of ["O1", "S07"] as const) {
  const { stateHash, ...body } = await createIntegratedAllocationShadow(kind, {
    codeHash: `sha256:${"0".repeat(64)}`,
  });
  out[kind] = {
    contract: canonicalSeriesJson(body.contract),
    initial: canonicalSeriesJson(body),
    contractHash: body.contractHash,
    sourceHash: (await integratedRegistry(kind, `sha256:${"0".repeat(64)}`)).sourceHash,
  };
}
await writeFile(
  "scripts/integrated-allocation-contract-templates.generated.json",
  JSON.stringify(out),
);
