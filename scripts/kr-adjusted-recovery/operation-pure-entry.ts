import fs from "node:fs";
import path from "node:path";
import { runKrVintagePreflight, type PreflightPhase } from "../kr-vintage-preflight-core";
import { prepareFullRecoveryPlan } from "./operation-plan";
let phase: PreflightPhase = "INPUT_VALIDATION";
const output = process.argv[3] ?? "";
globalThis.fetch = async () => {
  throw new Error("NETWORK_DISABLED");
};
runKrVintagePreflight(
  process.argv[2] ?? "",
  output,
  (p) => {
    phase = p;
  },
  async (context) => {
    const result = await prepareFullRecoveryPlan(context);
    fs.writeFileSync(path.join(output, "full-plan.json"), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
  },
).catch(() => {
  fs.writeFileSync(
    path.join(path.dirname(output), "operation-failure.json"),
    JSON.stringify({ phase }),
    { flag: "wx", mode: 0o600 },
  );
  process.exitCode = 1;
});
