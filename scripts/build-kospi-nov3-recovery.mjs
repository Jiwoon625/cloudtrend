import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const out = path.join(process.env.RUNNER_TEMP ?? "/tmp", "kospi-nov3-code");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const transport = await build({
  entryPoints: ["scripts/kospi-nov3-recovery/entry.ts"],
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
const krTransport = await build({
  entryPoints: ["scripts/kr-nov3-recovery/transport.ts"],
  outfile: path.join(out, "kr-transport.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  metafile: true,
  ignoreAnnotations: true,
  logLevel: "silent",
  banner: {
    js: 'import { createRequire as __krNov3Require } from "node:module"; const require = __krNov3Require(import.meta.url);',
  },
});
const krPure = await build({
  entryPoints: ["scripts/kr-nov3-recovery/entry.ts"],
  outfile: path.join(out, "kr-pure.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  metafile: true,
  ignoreAnnotations: true,
  logLevel: "silent",
});
const pure = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "kospi-nov3-pure.ts",
    loader: "ts",
    contents: `
import fs from "node:fs";
import path from "node:path";
import {prepareNov3Recovery} from "./scripts/kospi-nov3-recovery/core";
import {captureCanonicalProof} from "./scripts/kr-final-retrospective/capture-codec";
const dir=process.argv[2];
async function main(){
 if(!dir||!path.isAbsolute(dir))throw Error("DIRECTORY");
 globalThis.fetch=async()=>{throw Error("PURE_NO_NETWORK")};
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,"receipt.json"),"utf8"));
 if(receipt.version!=="kospi-nov3-recovery-preparation-v1"||receipt.operationalApproval!==false||receipt.historicalAvailabilityClaim!==false)throw Error("RECEIPT");
 const computed=await prepareNov3Recovery(receipt.input);
 if(computed.status!=="PROVEN_NOV3_RETROSPECTIVE_CONTINUATION"||captureCanonicalProof(computed).hash!==captureCanonicalProof(receipt.result).hash)throw Error("REPRODUCTION");
 fs.writeFileSync(path.join(dir,"proof.json"),JSON.stringify({status:"REPRODUCED",receiptHash:captureCanonicalProof(receipt).hash}),{mode:0o600,flag:"wx"});
}
main().catch(()=>{console.error("KOSPI_NOV3_PURE_REJECTED");process.exitCode=1;});
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
const capturePure = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "kospi-nov3-capture-pure.ts",
    loader: "ts",
    contents: `
import fs from "node:fs";
import path from "node:path";
import {computeNov3Capture,savePrivate} from "./scripts/kospi-nov3-recovery/capture-compute";
async function main(){
 const dir=process.argv[2];if(!dir||!path.isAbsolute(dir))throw Error("DIRECTORY");
 globalThis.fetch=async()=>{throw Error("PURE_NO_NETWORK")};
 const status=await computeNov3Capture(dir);savePrivate(path.join(dir,"capture-status.json"),status);
}
main().catch(()=>{console.error("KOSPI_NOV3_CAPTURE_PURE_REJECTED");process.exitCode=1;});
`,
  },
  outfile: path.join(out, "capture-pure.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  metafile: true,
  ignoreAnnotations: true,
  logLevel: "silent",
});
for (const pureBuild of [pure, capturePure, krPure]) {
  if (
    Object.keys(pureBuild.metafile.inputs).some(
      (p) =>
        p.endsWith(".server.ts") ||
        p.includes("@supabase/") ||
        p.includes("/integrations/supabase/"),
    )
  )
    throw Error("NOV3_PURE_BOUNDARY");
  for (const o of Object.values(pureBuild.metafile.outputs))
    for (const i of o.imports)
      if (/https?|net|tls|child_process|dns|worker_threads/.test(i.path))
        throw Error("NOV3_PURE_IMPORT");
}
if (
  Object.keys(pure.metafile.inputs).some(
    (p) =>
      p.endsWith(".server.ts") || p.includes("@supabase/") || p.includes("/integrations/supabase/"),
  )
)
  throw Error("NOV3_PURE_BOUNDARY");
for (const o of Object.values(pure.metafile.outputs))
  for (const i of o.imports)
    if (/https?|net|tls|child_process|dns|worker_threads/.test(i.path))
      throw Error("NOV3_PURE_IMPORT");
const files = {};
for (const p of [
  ...new Set([
    ...Object.keys(transport.metafile.inputs),
    ...Object.keys(krTransport.metafile.inputs),
    ...Object.keys(krPure.metafile.inputs),
    ...Object.keys(pure.metafile.inputs),
    ...Object.keys(capturePure.metafile.inputs),
    "scripts/build-kospi-nov3-recovery.mjs",
    ".github/workflows/kospi-nov3-recovery.yml",
    ".github/workflows/kr-nov3-recovery.yml",
    "package-lock.json",
  ]),
].sort()) {
  if (
    p === "kospi-nov3-pure.ts" ||
    p === "kospi-nov3-capture-pure.ts" ||
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
const manifest = { version: "kospi-nov3-writer-v1", files };
manifest.hash = "sha256:" + createHash("sha256").update(canonical(manifest)).digest("hex");
fs.writeFileSync(path.join(out, "writer-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
console.log(
  JSON.stringify({
    status: "NOV3_RECOVERY_BUILT",
    writerRuntimeHash: manifest.hash,
    pureBoundaryVerified: true,
  }),
);
