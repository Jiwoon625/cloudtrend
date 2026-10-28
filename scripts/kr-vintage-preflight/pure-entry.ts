import fs from "node:fs";
import path from "node:path";
import { runKrVintagePreflight, type PreflightPhase } from "../kr-vintage-preflight-core";
// No network modules or process launchers are admitted by the bundle dependency audit.
globalThis.fetch = async () => {
  throw new Error("NETWORK_DISABLED");
};
let phase: PreflightPhase = "INPUT_VALIDATION";
const output = process.argv[3] ?? "";
runKrVintagePreflight(process.argv[2] ?? "", output, (value) => {
  phase = value;
}).catch(() => {
  // Controlled enum only: never error.message, stack, private paths or input values.
  fs.writeFileSync(
    path.join(path.dirname(output), "failure-summary.json"),
    JSON.stringify({ phase }),
    { flag: "wx", mode: 0o600 },
  );
  process.exitCode = 1;
});
