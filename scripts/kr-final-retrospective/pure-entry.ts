/** No credentials, network imports, or write-capable repository adapters. */
import fs from "node:fs";
import { prepareFinalRetrospective } from "./core";
import { canonicalSeriesJson } from "../../src/lib/ledger/modelSeries";
async function main() {
  const capture = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
  const plan = await prepareFinalRetrospective(capture);
  fs.writeFileSync(process.argv[3]!, canonicalSeriesJson(plan), { mode: 0o600, flag: "wx" });
}
main().catch(() => {
  process.exitCode = 1;
});
