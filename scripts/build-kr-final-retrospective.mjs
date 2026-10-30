import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
const out = path.join(process.env.RUNNER_TEMP ?? "/tmp", "kr-final-retrospective-code");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
for (const [file, name, server] of [
  ["entry", "transport", false],
  ["pure-entry", "pure", false],
  ["apply-entry", "apply", true],
]) {
  const r = await build({
    entryPoints: [`scripts/kr-final-retrospective/${file}.ts`],
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
    !server &&
    Object.keys(r.metafile.inputs).some(
      (p) =>
        p.endsWith(".server.ts") ||
        p.includes("@supabase/") ||
        p.includes("/integrations/supabase/"),
    )
  )
    throw Error("FINAL_RETROSPECTIVE_BOUNDARY");
  if (name === "pure")
    for (const o of Object.values(r.metafile.outputs))
      for (const i of o.imports)
        if (/https?|net|tls|child_process|dns|worker_threads/.test(i.path))
          throw Error("FINAL_RETROSPECTIVE_PURITY");
}
console.log("Final retrospective credential boundaries verified");
