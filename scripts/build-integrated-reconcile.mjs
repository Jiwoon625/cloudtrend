import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const dir = path.join(process.env.RUNNER_TEMP ?? "/tmp", "integrated-reconcile-code");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ["scripts/integrated-reconcile/entry.ts"],
  outfile: path.join(dir, "run.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "silent",
});
console.log("Integrated reconciliation executable built; no network or database action performed");
