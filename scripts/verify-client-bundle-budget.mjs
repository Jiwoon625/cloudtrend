import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const commit =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  process.env.LOVABLE_GIT_COMMIT_SHA ??
  "dev";
const publicRoot = resolve(process.env.VERCEL ? ".vercel/output/static" : ".output/public");
const assetRoot = resolve(publicRoot, "assets", commit);
// Nitro's Vercel preset moves the server output into a function directory;
// the .output/server directory may be absent or stale in Vercel builds.
const serverRoot = resolve(
  process.env.VERCEL ? ".vercel/output/functions/__server.func" : ".output/server",
);
const maxGzipBytes = Number(process.env.CLIENT_INITIAL_GZIP_BUDGET_BYTES ?? 320 * 1024);

async function findManifest() {
  const names = (await readdir(serverRoot)).filter((name) =>
    /^_tanstack-start-manifest.*\.mjs$/.test(name),
  );
  if (names.length !== 1)
    throw new Error(`Expected one TanStack Start manifest, found ${names.length}`);
  return resolve(serverRoot, names[0]);
}

async function collectCssFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectCssFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".css")) files.push(path);
  }
  return files;
}

const { tsrStartManifest } = await import(pathToFileURL(await findManifest()).href);
const routes = tsrStartManifest()?.routes;
const rootPreloads = routes?.__root__?.preloads;
const homePreloads = routes?.["/"]?.preloads;
if (!Array.isArray(rootPreloads) || !Array.isArray(homePreloads))
  throw new Error("TanStack Start manifest is missing root or home route preloads");

const referenced = new Set([...rootPreloads, ...homePreloads]);
const files = [];
for (const assetUrl of referenced) {
  const pathname = new URL(assetUrl, "https://cloudtrend.invalid").pathname;
  const path = resolve(publicRoot, `.${pathname}`);
  const withinAssetRoot = relative(assetRoot, path);
  if (withinAssetRoot.startsWith(`..${sep}`) || withinAssetRoot === "..")
    throw new Error(`Initial route asset is outside this build: ${assetUrl}`);
  if (!(await stat(path).catch(() => null)))
    throw new Error(`Initial route asset is missing: ${assetUrl}`);
  files.push(path);
}

// Tailwind currently emits a single global stylesheet; include emitted CSS so the
// initial-route budget covers the styles needed by both the shell and dashboard.
files.push(...(await collectCssFiles(assetRoot)));
const uniqueFiles = [...new Set(files)];
let rawBytes = 0;
let gzipBytes = 0;
for (const path of uniqueFiles) {
  const bytes = await readFile(path);
  rawBytes += bytes.byteLength;
  gzipBytes += gzipSync(bytes, { level: 9 }).byteLength;
}

console.log(
  `Initial dashboard JS/CSS: ${(rawBytes / 1024).toFixed(1)} KiB raw, ` +
    `${(gzipBytes / 1024).toFixed(1)} KiB gzip across ${uniqueFiles.length} files ` +
    `(budget ${(maxGzipBytes / 1024).toFixed(0)} KiB gzip)`,
);
if (!Number.isFinite(maxGzipBytes) || maxGzipBytes <= 0)
  throw new Error("CLIENT_INITIAL_GZIP_BUDGET_BYTES must be a positive number");
if (gzipBytes > maxGzipBytes)
  throw new Error(
    `Initial dashboard bundle exceeds the gzip budget by ${gzipBytes - maxGzipBytes} bytes`,
  );
