import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
const root = process.cwd();
const out = path.join(process.env.RUNNER_TEMP ?? "/tmp", "kr-vintage-preflight-code");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
// Compare the copied pure helper to the AST source, without evaluating/importing the server.
const source = fs.readFileSync("src/lib/shadowReplay.server.ts", "utf8");
const ast = ts.createSourceFile("shadowReplay.server.ts", source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === "currentDateEvidence",
);
if (functions.length !== 1) throw new Error("PREFLIGHT_BUILD_REJECTED");
const copied = fs.readFileSync("scripts/kr-vintage-preflight-dated-evidence.ts", "utf8");
const copiedAst = ts.createSourceFile("helper.ts", copied, ts.ScriptTarget.Latest, true);
const helper = copiedAst.statements.filter(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === "currentDateEvidence",
);
const printer = ts.createPrinter({ removeComments: true });
const normalize = (node, file) =>
  printer
    .printNode(ts.EmitHint.Unspecified, node, file)
    .replace(/^export\s+/, "")
    .replace(/\s+/g, "");
if (helper.length !== 1 || normalize(functions[0], ast) !== normalize(helper[0], copiedAst))
  throw new Error("PREFLIGHT_HELPER_CHANGED");
for (const [entry, name, pure] of [
  ["scripts/kr-vintage-preflight/entry.ts", "transport", false],
  ["scripts/kr-vintage-preflight/pure-entry.ts", "pure", true],
]) {
  const result = await build({
    entryPoints: [entry],
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
    Object.keys(result.metafile.inputs).some(
      (p) =>
        p.endsWith(".server.ts") ||
        p.includes("@supabase/") ||
        p.includes("/integrations/supabase/"),
    )
  )
    throw new Error("PREFLIGHT_DEPENDENCY_REJECTED");
  if (pure)
    for (const output of Object.values(result.metafile.outputs))
      for (const imp of output.imports)
        if (
          ![
            "node:fs",
            "node:path",
            "node:crypto",
            "node:zlib",
            "node:assert/strict",
            "crypto",
            "stream",
            "buffer",
            "util",
            "events",
            "fs",
            "string_decoder",
            "path",
            "constants",
            "assert",
            "zlib",
            "os",
          ].includes(imp.path)
        )
          throw new Error("PREFLIGHT_EXTERNAL_REJECTED");
}
console.log("Read-only preflight bundles verified");
