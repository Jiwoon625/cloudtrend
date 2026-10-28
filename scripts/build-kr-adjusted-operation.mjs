import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
const out = path.join(process.env.RUNNER_TEMP ?? "/tmp", "kr-adjusted-operation-code");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
for (const [file, name, allowServer] of [
  ["operation-entry", "transport", false],
  ["operation-pure-entry", "pure", false],
  ["operation-apply-entry", "apply", true],
  ["recovery-model-plan.selftest", "model-tests", false],
]) {
  const result = await build({
    entryPoints: [`scripts/kr-adjusted-recovery/${file}.ts`],
    outfile: path.join(out, name + ".mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
    ignoreAnnotations: true,
    logLevel: "silent",
  });
  if (
    !allowServer &&
    Object.keys(result.metafile.inputs).some(
      (p) =>
        p.endsWith(".server.ts") ||
        p.includes("@supabase/") ||
        p.includes("/integrations/supabase/"),
    )
  )
    throw new Error("OPERATION_PURITY_REJECTED");
  if (name === "pure")
    for (const o of Object.values(result.metafile.outputs))
      for (const i of o.imports)
        if (/https?|net|tls|child_process|dns|worker_threads/.test(i.path))
          throw new Error("OPERATION_PURE_IMPORT_REJECTED");
}
console.log("Operation credential boundaries verified");
