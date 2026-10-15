import { createHash } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Trusted native bootstrap: no application, manifest-generator, Vite or project-config imports.
// This checks reviewed source bytes before loading that graph; it is not a sandbox
// against modification of this bootstrap, the workflow or installed Node/package toolchain.
export function canonicalKospiBootstrapJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalKospiBootstrapJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalKospiBootstrapJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  throw new Error("Bootstrap provenance must contain plain finite JSON values");
}
const hash = (bytes: string | Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const requiredRoots = [
  "scripts/run-kospi-shadow.ts",
  "src/lib/kospiShadowSeries.ts",
  "src/lib/kospiShadowStore.ts",
  "scripts/kospi-shadow-runtime.config.ts",
  "scripts/verify-kospi-shadow-runtime.ts",
  "scripts/kospi-shadow-code-manifest.ts",
  "scripts/build-kospi-shadow-manifest.ts",
];
interface SavedManifest {
  manifest: { version: string; files: Record<string, string>; rawFiles: Record<string, string> };
  codeHash: string;
}

/** Native source-as-data verification. Safe to run before Vite or any project module evaluates. */
export async function verifyKospiShadowRuntimeManifest(root = process.cwd()) {
  const physicalRoot = await realpath(root);
  async function readRegularFile(relative: string) {
    const target = path.join(physicalRoot, relative);
    // Identical bytes behind a symlink can resolve relative imports from another graph.
    // Checking the resolved full path also rejects symlinked ancestor directories.
    if (!(await lstat(target)).isFile() || (await realpath(target)) !== target)
      throw new Error("Non-regular or redirected KOSPI Shadow publication source");
    return readFile(target);
  }
  const saved = JSON.parse(
    (await readRegularFile("src/lib/kospiShadowPublicationRuntime.generated.json")).toString(
      "utf8",
    ),
  ) as SavedManifest;
  if (
    !saved?.manifest ||
    saved.manifest.version !== "kospi-shadow-publication-runtime-v2" ||
    !hashPattern.test(saved.codeHash) ||
    hash(canonicalKospiBootstrapJson(saved.manifest)) !== saved.codeHash
  )
    throw new Error("Invalid KOSPI Shadow publication executable manifest");
  const { files, rawFiles } = saved.manifest;
  if (
    !files ||
    !rawFiles ||
    Array.isArray(files) ||
    Array.isArray(rawFiles) ||
    canonicalKospiBootstrapJson(Object.keys(files).sort()) !==
      canonicalKospiBootstrapJson(Object.keys(rawFiles).sort()) ||
    requiredRoots.some((file) => !Object.hasOwn(rawFiles, file))
  )
    throw new Error("Incomplete KOSPI Shadow publication executable manifest");
  const reviews = JSON.parse(
    (await readRegularFile("src/lib/kospiShadowRuntimeAdmissions.json")).toString("utf8"),
  ) as {
    version: string;
    admissions: Array<{ runtimeCodeHash: string; reviewId: string }>;
  };
  if (
    !reviews ||
    reviews.version !== "kospi-shadow-publication-runtime-admissions-v1" ||
    !Array.isArray(reviews.admissions)
  )
    throw new Error("Invalid KOSPI Shadow publication runtime admission contract");
  const seen = new Set<string>();
  for (const review of reviews.admissions) {
    if (
      !review ||
      !hashPattern.test(review.runtimeCodeHash) ||
      !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(review.reviewId) ||
      seen.has(review.runtimeCodeHash)
    )
      throw new Error("Invalid or ambiguous KOSPI Shadow publication runtime review");
    seen.add(review.runtimeCodeHash);
  }
  // A generated candidate is not an admission. Only a separately reviewed exact digest may run.
  if (!seen.has(saved.codeHash))
    throw new Error("Unreviewed KOSPI Shadow publication executable runtime");
  for (const [file, expected] of Object.entries(rawFiles)) {
    if (
      !/^(?:scripts|src)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|json|mjs)$/.test(file) ||
      file.split("/").some((part) => part === "." || part === "..") ||
      /\/kospiShadow(?:PublicationRuntime.generated|RuntimeAdmissions)\.json$/.test(file) ||
      !hashPattern.test(expected) ||
      !hashPattern.test(files[file] ?? "")
    )
      throw new Error("Unsafe KOSPI Shadow publication manifest source");
    if (hash(await readRegularFile(file)) !== expected)
      throw new Error("Stale KOSPI Shadow publication executable manifest");
  }
  return { kospiRuntimeCodeHash: saved.codeHash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    await verifyKospiShadowRuntimeManifest();
    const args = process.argv.slice(2);
    if (args.length) {
      if (args[0] !== "--launch" || args[1] !== "--")
        throw new Error("Invalid bootstrap arguments");
      const result = spawnSync(
        process.execPath,
        [
          "node_modules/vite-node/vite-node.mjs",
          "--config",
          "scripts/kospi-shadow-runtime.config.ts",
          "scripts/run-kospi-shadow.ts",
          "--",
          ...args.slice(2),
        ],
        { stdio: "inherit", env: process.env },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else console.log(JSON.stringify({ stage: "KOSPI_RUNTIME_VERIFIED" }));
  })().catch(() => {
    console.error("KOSPI publication runtime preflight failed before project/config evaluation.");
    process.exitCode = 1;
  });
}
