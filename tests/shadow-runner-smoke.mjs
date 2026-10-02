import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const env = { ...process.env };
for (const key of [
  "GITHUB_ACTIONS",
  "GITHUB_WORKFLOW",
  "GITHUB_REF",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_USER_ID",
])
  delete env[key];
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vite-node/vite-node.mjs",
    "--config",
    "scripts/kospi-shadow-runtime.config.ts",
    "scripts/run-kospi-shadow.ts",
  ],
  { env, encoding: "utf8", timeout: 20_000 },
);
assert.equal(result.error, undefined, `Runner failed to reach its guard: ${result.error?.message}`);
assert.equal(result.status, 1, `Unexpected runner status: ${result.status}`);
assert.match(result.stderr, /publication is restricted to its serialized main-branch workflow/);
assert.doesNotMatch(result.stderr, /SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY is required/);
console.log(
  "Shadow runner reaches and enforces publication guard without credentials or external writes.",
);
