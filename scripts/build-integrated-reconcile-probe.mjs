import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const dir = path.join(process.env.RUNNER_TEMP ?? "/tmp", "integrated-reconcile-probe-code");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ["scripts/integrated-reconcile/probe-entry.ts"],
  outfile: path.join(dir, "probe.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "silent",
});
console.log("Bounded read-only probe built; no network or storage action performed");
