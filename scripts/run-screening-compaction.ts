import {
  runCompaction,
  retryCompactionCutover,
  restorePrivateCompactionEvidence,
} from "./compact-screening-sources";
import { compactionExecutionMode } from "./screening-compaction-core";
const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const userId = value("--user-id") ?? process.env["SUPABASE_USER_ID"];
const output = value("--output");
if (!userId || !output)
  throw new Error(
    "Usage: vite-node --config vitest.compaction.config.ts scripts/run-screening-compaction.ts -- --user-id <uuid> --output <private-directory> [--apply | --retry-cutover]",
  );
const expectedSourceHash = value("--expected-source-hash");
const persistPrivateEvidence = args.includes("--private-evidence");
let restoredArgs = false;
if (args.includes("--restore-private-evidence")) {
  if (!expectedSourceHash)
    throw new Error("Expected source-set hash is required for private evidence restore");
  restoredArgs = await restorePrivateCompactionEvidence({ userId, output, expectedSourceHash });
}
const options = {
  userId,
  output,
  ...(expectedSourceHash ? { expectedSourceHash } : {}),
  persistPrivateEvidence,
};
const mode = compactionExecutionMode(args, restoredArgs);
if (mode === "retry") await retryCompactionCutover(options);
else await runCompaction({ ...options, apply: mode === "apply" });
