import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

function usage(message) {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  node scripts/run-v8-research-batch.mjs --scripts <comma-separated> --source-manifest <path> --source-cache-dir <dir> --supabase-user-id <uuid> [--upload]",
    ].join("\n"),
  );
}

const options = {
  scripts: [],
  sourceManifest: "",
  sourceCacheDir: "",
  userId: process.env.SUPABASE_USER_ID ?? "",
  upload: false,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--scripts") {
    options.scripts = String(argv[++i] ?? usage("--scripts 값이 없습니다."))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } else if (arg === "--source-manifest") {
    options.sourceManifest = argv[++i] ?? usage("--source-manifest 값이 없습니다.");
  } else if (arg === "--source-cache-dir") {
    options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir 값이 없습니다.");
  } else if (arg === "--supabase-user-id") {
    options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
  } else if (arg === "--upload") {
    options.upload = true;
  } else {
    usage(`지원하지 않는 인자입니다: ${arg}`);
  }
}
if (!options.scripts.length) usage("실행할 연구 스크립트가 없습니다.");
if (!options.sourceManifest || !options.sourceCacheDir)
  usage("source manifest와 cache dir가 필요합니다.");
if (!/^[0-9a-f-]{36}$/i.test(options.userId))
  usage("유효한 Supabase user id가 필요합니다.");

for (const script of options.scripts) {
  const normalized = script.replace(/\\/g, "/");
  if (!/^scripts\/run-v8-[0-9a-z-]+\.ts$/i.test(normalized) || normalized.includes("..")) {
    throw new Error(`허용되지 않은 연구 스크립트 경로입니다: ${script}`);
  }
  await access(path.resolve(normalized));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed: ${command} ${args.join(" ")} (code=${code}, signal=${signal})`));
    });
  });
}

for (const script of options.scripts) {
  process.stdout.write(`\n===== CloudTrend research batch: ${script} =====\n`);
  const args = [
    "vite-node",
    script,
    "--source-manifest",
    options.sourceManifest,
    "--source-cache-dir",
    options.sourceCacheDir,
    "--supabase-user-id",
    options.userId,
  ];
  if (options.upload) args.push("--upload");
  await run("npx", args);
}

process.stdout.write(`\nCompleted ${options.scripts.length} research studies with one materialized source set.\n`);
