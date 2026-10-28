import fs from "node:fs";
import path from "node:path";
import { runKrVintagePreflight, type PreflightPhase } from "../kr-vintage-preflight-core";
import { prepareRecovery } from "./prepare";
let phase: PreflightPhase = "INPUT_VALIDATION";
const output = process.argv[3] ?? "";
globalThis.fetch = async () => {
  throw new Error("NETWORK_DISABLED");
};
runKrVintagePreflight(
  process.argv[2] ?? "",
  output,
  (v) => {
    phase = v;
  },
  async (context) => {
    const receipt = await prepareRecovery(context);
    fs.writeFileSync(path.join(output, "preparation.json"), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
  },
).catch(() => {
  fs.writeFileSync(
    path.join(path.dirname(output), "failure-summary.json"),
    JSON.stringify({ phase }),
    { flag: "wx", mode: 0o600 },
  );
  process.exitCode = 1;
});
