import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
const out = path.join(process.env.RUNNER_TEMP ?? "/tmp", "integrated-gap-code");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ["scripts/integrated-gap-recovery/entry.ts"],
  outfile: path.join(out, "transport.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "silent",
});
const pure = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "integrated-gap-pure.ts",
    loader: "ts",
    contents: `
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {prepareGapPlan} from "./scripts/integrated-gap-recovery/core";
import {captureCanonicalChunks,captureCanonicalProof} from "./scripts/kr-final-retrospective/capture-codec";
const dir=process.argv[2],code=process.argv[3],requestHash=process.argv[4];
const read=(n)=>JSON.parse(fs.readFileSync(path.join(dir,n+".json"),"utf8"));
async function main(){
 globalThis.fetch=async()=>{throw Error("PURE_NO_NETWORK")};
 const capture=read("capture");
 if(capture.codeCommit!==code||capture.requestHash!==requestHash)throw Error("IDENTITY");
 const plan=await prepareGapPlan(capture,read("prior-capture"),read("prior-plan"));
 const proof=captureCanonicalProof(plan); if(proof.bytes<=0||proof.bytes>256*1024*1024)throw Error("SIZE");
 const file=path.join(dir,"plan.json"),fd=fs.openSync(file,"wx",0o600),hash=createHash("sha256");let bytes=0;
 try{for(const chunk of captureCanonicalChunks(plan)){bytes+=chunk.length;if(bytes>256*1024*1024)throw Error("SIZE");fs.writeFileSync(fd,chunk);hash.update(chunk);}
 if(bytes!==proof.bytes||"sha256:"+hash.digest("hex")!==proof.hash)throw Error("WRITE");}
 catch(e){fs.rmSync(file,{force:true});throw e;}finally{fs.closeSync(fd);}
}
main().catch(()=>{console.error("INTEGRATED_GAP_PURE_REJECTED");process.exitCode=1;});
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
  throw Error("GAP_PURE_BOUNDARY");
for (const o of Object.values(pure.metafile.outputs))
  for (const i of o.imports)
    if (/https?|net|tls|child_process|dns|worker_threads/.test(i.path))
      throw Error("GAP_PURE_IMPORT");
console.log("Integrated gap credential boundaries verified");
