import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const out = path.join(process.env.RUNNER_TEMP ?? "/tmp", "kospi-november-code");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const transport = await build({
  entryPoints: ["scripts/kospi-november-recovery/entry.ts"],
  outfile: path.join(out, "transport.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  metafile: true,
  ignoreAnnotations: true,
  logLevel: "silent",
  banner: {
    js: 'import { createRequire as __novCreateRequire } from "node:module"; const require = __novCreateRequire(import.meta.url);',
  },
});
const pure = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "kospi-november-pure.ts",
    loader: "ts",
    contents: `
import fs from "node:fs";
import path from "node:path";
import {prepareNovemberRecovery} from "./scripts/kospi-november-recovery/core";
import {captureCanonicalProof} from "./scripts/kr-final-retrospective/capture-codec";
const dir=process.argv[2];
async function main(){
 if(!dir||!path.isAbsolute(dir))throw Error("DIRECTORY");
 globalThis.fetch=async()=>{throw Error("PURE_NO_NETWORK")};
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,"receipt.json"),"utf8"));
 if(receipt.version!=="kospi-november-recovery-preparation-v1"||receipt.operationalApproval!==false||receipt.historicalAvailabilityClaim!==false)throw Error("RECEIPT");
 const computed=await prepareNovemberRecovery(receipt.input);
 if(computed.status!=="PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION"||captureCanonicalProof(computed).hash!==captureCanonicalProof(receipt.result).hash)throw Error("REPRODUCTION");
 fs.writeFileSync(path.join(dir,"proof.json"),JSON.stringify({status:"REPRODUCED",receiptHash:captureCanonicalProof(receipt).hash}),{mode:0o600,flag:"wx"});
}
main().catch(()=>{console.error("KOSPI_NOVEMBER_PURE_REJECTED");process.exitCode=1;});
`,
  },
  outfile: path.join(out, "pure.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  metafile: true,
  ignoreAnnotations: true,
  logLevel: "silent",
});
if (
  Object.keys(pure.metafile.inputs).some(
    (p) =>
      p.endsWith(".server.ts") || p.includes("@supabase/") || p.includes("/integrations/supabase/"),
  )
)
  throw Error("NOVEMBER_PURE_BOUNDARY");
for (const o of Object.values(pure.metafile.outputs))
  for (const i of o.imports)
    if (/https?|net|tls|child_process|dns|worker_threads/.test(i.path))
      throw Error("NOVEMBER_PURE_IMPORT");
const files = {};
for (const p of [
  ...new Set([
    ...Object.keys(transport.metafile.inputs),
    ...Object.keys(pure.metafile.inputs),
    "scripts/build-kospi-november-recovery.mjs",
    ".github/workflows/kospi-november-recovery.yml",
    "package-lock.json",
  ]),
].sort()) {
  if (
    p === "kospi-november-pure.ts" ||
    p.startsWith("node_modules/") ||
    p.includes("/node_modules/")
  )
    continue;
  if (p.startsWith("/") || p.split("/").includes("..")) throw Error("WRITER_PATH");
  files[p] = "sha256:" + createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}";
const manifest = { version: "kospi-november-writer-v1", files };
manifest.hash = "sha256:" + createHash("sha256").update(canonical(manifest)).digest("hex");
fs.writeFileSync(path.join(out, "writer-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
console.log(
  JSON.stringify({
    status: "NOVEMBER_RECOVERY_BUILT",
    writerRuntimeHash: manifest.hash,
    pureBoundaryVerified: true,
  }),
);
