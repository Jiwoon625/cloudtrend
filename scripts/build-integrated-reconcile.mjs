import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const dir = path.join(process.env.RUNNER_TEMP ?? "/tmp", "integrated-reconcile-code");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ["scripts/integrated-reconcile/entry.ts"],
  outfile: path.join(dir, "entry-module.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // The unchanged runtime-manifest verifier imports TypeScript's CommonJS system.
  // Supply Node primitives explicitly when that dependency is bundled into ESM.
  banner: {
    js: 'import { createRequire as __nodeCreateRequire } from "node:module"; import { fileURLToPath as __nodeFileURLToPath } from "node:url"; import { dirname as __nodeDirname } from "node:path"; const require = __nodeCreateRequire(import.meta.url); const __filename = __nodeFileURLToPath(import.meta.url); const __dirname = __nodeDirname(__filename);',
  },
  logLevel: "silent",
});
// Keep the imported verifier's direct-CLI footer inactive: its module URL must
// differ from argv[1]. entry.main still awaits the original verifier before IO.
fs.writeFileSync(path.join(dir, "run.mjs"), 'import "./entry-module.mjs";\n', { mode: 0o600 });
console.log("Integrated reconciliation executable built; no network or database action performed");
