import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const commit =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  process.env.LOVABLE_GIT_COMMIT_SHA ??
  "dev";
const output = resolve(process.env.VERCEL ? ".vercel/output/static" : ".output/public");
const assetRoot = resolve(output, "assets", commit);
const assets = [];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.(?:js|css)$/.test(entry.name)) {
      const bytes = await readFile(path);
      assets.push({
        path: `/${relative(output, path).replaceAll("\\", "/")}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await scan(assetRoot);
if (
  !assets.some((asset) => asset.path.endsWith(".css")) ||
  !assets.some((asset) => asset.path.endsWith(".js"))
) {
  throw new Error("Build must contain JavaScript and CSS assets");
}
await writeFile(
  resolve(output, "deployment-manifest.json"),
  JSON.stringify({ commit, assets }, null, 2),
);
console.log(`Deployment manifest: ${commit}, ${assets.length} JS/CSS files`);
