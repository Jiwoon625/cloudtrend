export const APPROVED_SOURCE_HASH =
  "sha256:8c8f171d2b6bce3d722e39b8810148b5d7f8fc6e41493327f0b2bb4dd636f558";
export const COMPACTION_COMMAND = `/cloudtrend compact screening ${APPROVED_SOURCE_HASH}`;
export function compactionParameters(env) {
  if (
    !env.ACTOR ||
    !env.REPOSITORY_OWNER ||
    env.ACTOR !== env.REPOSITORY_OWNER ||
    env.REF !== "refs/heads/main"
  )
    throw new Error("Only the repository owner on main can request compaction");
  if (env.EVENT_NAME === "issue_comment") {
    if (
      env.ISSUE_NUMBER !== "16" ||
      env.COMMENT_BODY !== COMPACTION_COMMAND ||
      env.IS_PULL_REQUEST !== "false"
    )
      throw new Error("Only the exact approved command in control issue 16 can request compaction");
    return { mode: "apply", expectedSourceHash: APPROVED_SOURCE_HASH };
  }
  if (env.EVENT_NAME !== "workflow_dispatch") throw new Error("Compaction is manual only");
  if (
    !["prepare", "apply"].includes(env.INPUT_MODE) ||
    !/^sha256:[0-9a-f]{64}$/.test(env.INPUT_EXPECTED_HASH ?? "")
  )
    throw new Error("Invalid manual compaction parameters");
  return { mode: env.INPUT_MODE, expectedSourceHash: env.INPUT_EXPECTED_HASH };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = compactionParameters(process.env);
  console.log(`mode=${result.mode}`);
  console.log(`expected_source_hash=${result.expectedSourceHash}`);
}
