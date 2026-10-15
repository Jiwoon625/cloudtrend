/** Trusted native launcher. No project/configuration imports before public byte boundaries. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Finalize only after the reviewed generic guard merge, then independently re-review this file.
const PINNED_REVIEWED_MAIN_SHA = "5a11654bbefee30b2f5001867b8715b97d8f4dc7";
const PINNED_ACTIVATION_SCRIPT_SHA256 =
  "ffe1458c0a081c3ad0670dea2e1e8e31217c18a6754778956ae458610e63fd56";
const ACTIVATION_FILES = [
  ".github/workflows/shadow-private-activation.yml",
  "scripts/activate-approved-shadow.ts",
  "scripts/run-approved-shadow-activation.mjs",
  "tests/shadow-private-activation.test.ts",
];
function requireThat(condition) {
  if (!condition) throw new Error("LAUNCH_BOUNDARY_REJECTED");
}
function verifyPublicLaunchBoundary() {
  requireThat(/^[a-f0-9]{40}$/.test(PINNED_REVIEWED_MAIN_SHA));
  requireThat(/^[a-f0-9]{64}$/.test(PINNED_ACTIVATION_SCRIPT_SHA256));
  requireThat(process.env.GITHUB_ACTIONS === "true");
  requireThat(process.env.GITHUB_EVENT_NAME === "push");
  requireThat(process.env.GITHUB_REPOSITORY === "Jiwoon625/cloudtrend");
  requireThat(process.env.GITHUB_REF === "refs/heads/fix/shadow-private-activation-20261015");
  requireThat(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? ""));
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  const head = git("rev-parse", "HEAD");
  requireThat(head === process.env.GITHUB_SHA);
  requireThat(git("rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length === 2);
  requireThat(git("status", "--porcelain", "--untracked-files=all") === "");
  const actualDiff = git("diff", "--name-status", PINNED_REVIEWED_MAIN_SHA, head)
    .split("\n")
    .sort();
  requireThat(
    JSON.stringify(actualDiff) ===
      JSON.stringify(ACTIVATION_FILES.map((file) => `A\t${file}`).sort()),
  );
  const entries = git("ls-tree", "HEAD", "--", ...ACTIVATION_FILES).split("\n");
  const regularPaths = entries.map((entry) => entry.match(/^100644 blob [a-f0-9]{40}\t(.+)$/)?.[1]);
  requireThat(JSON.stringify(regularPaths.sort()) === JSON.stringify([...ACTIVATION_FILES].sort()));
  requireThat(
    createHash("sha256")
      .update(readFileSync("scripts/activate-approved-shadow.ts"))
      .digest("hex") === PINNED_ACTIVATION_SCRIPT_SHA256,
  );
  requireThat(
    git("ls-remote", "origin", "refs/heads/main") ===
      `${PINNED_REVIEWED_MAIN_SHA}\trefs/heads/main`,
  );
}

let server;
try {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--verify-runtime"))
    throw new Error("INVALID_LAUNCHER_ARGUMENT");
  if (process.argv[2] !== "--verify-runtime") {
    console.log(JSON.stringify({ stage: "PUBLIC_BOUNDARY_START" }));
    verifyPublicLaunchBoundary();
    console.log(JSON.stringify({ stage: "PUBLIC_BOUNDARY_VERIFIED" }));
  }
  // Only Node builtins run here. No inherited service credentials, Actions tokens, or NODE_OPTIONS.
  const verification = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/verify-kospi-shadow-runtime.ts"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  requireThat(verification.trim() === '{"stage":"KOSPI_RUNTIME_VERIFIED"}');
  console.log(JSON.stringify({ stage: "KOSPI_NATIVE_VERIFIED" }));
  if (process.argv[2] === "--verify-runtime") {
    // Verify only the KOSPI publication closure here. The actual activation checks all three
    // runtime identities after its public import boundary and before any private writes.
  } else {
    const [{ createServer }, { ViteNodeServer }, { ViteNodeRunner }] = await Promise.all([
      import("vite"),
      import("vite-node/server"),
      import("vite-node/client"),
    ]);
    server = await createServer({
      configFile: "scripts/kospi-shadow-runtime.config.ts",
      server: { preTransformRequests: false },
      appType: "custom",
    });
    await server.pluginContainer.buildStart({});
    const node = new ViteNodeServer(server);
    const runner = new ViteNodeRunner({
      root: server.config.root,
      base: server.config.base,
      fetchModule: (id) => node.fetchModule(id),
      resolveId: (id, importer) => node.resolveId(id, importer),
    });
    const module = await runner.executeFile("scripts/activate-approved-shadow.ts");
    const result = await module.runApprovedShadowActivationCli();
    if (result === null && process.exitCode === 1) {
      // The bounded CLI already reported its actual last safe stage. Preserve it.
    } else {
      if (
        !result ||
        Object.keys(result).sort().join(",") !==
          "capitalReset,date,kospiRetrospective,krBooks,originalsPreserved,sourceCollection,status" ||
        result.status !== "VERIFIED" ||
        result.date !== "2026-10-14" ||
        result.krBooks !== 5 ||
        result.kospiRetrospective !== true ||
        result.originalsPreserved !== true ||
        result.capitalReset !== false ||
        result.sourceCollection !== false
      )
        throw new Error("VERIFIED_RESULT_REQUIRED");
      console.log(JSON.stringify({ stage: "CLI_COMPLETE", status: "VERIFIED" }));
    }
  }
} catch {
  console.error(
    JSON.stringify({
      status: "STOPPED",
      stage: "LAUNCHER",
      code: "PRIVATE_VALIDATION_OR_WRITE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await server?.close();
}
