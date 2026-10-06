import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  compactionParameters,
  APPROVED_SOURCE_HASH,
  COMPACTION_COMMAND,
} from "../scripts/parse-compaction-command.mjs";
const env = {
  ACTOR: "owner",
  REPOSITORY_OWNER: "owner",
  REF: "refs/heads/main",
  EVENT_NAME: "issue_comment",
  ISSUE_NUMBER: "16",
  IS_PULL_REQUEST: "false",
  COMMENT_BODY: COMPACTION_COMMAND,
};
test("exact owner command binds the approved snapshot", () =>
  assert.deepEqual(compactionParameters(env), {
    mode: "apply",
    expectedSourceHash: APPROVED_SOURCE_HASH,
  }));
test("reject all unrequested automation/actors/branches/PRs/issues/command suffixes", () => {
  for (const change of [
    { ACTOR: "other" },
    { REF: "refs/heads/feature" },
    { EVENT_NAME: "schedule" },
    { IS_PULL_REQUEST: "true" },
    { ISSUE_NUMBER: "17" },
    { COMMENT_BODY: COMPACTION_COMMAND + " --delete" },
    { COMMENT_BODY: "/cloudtrend compact screening" },
  ])
    assert.throws(() => compactionParameters({ ...env, ...change }));
});
test("manual parameters are strictly bounded", () => {
  assert.equal(
    compactionParameters({
      ...env,
      EVENT_NAME: "workflow_dispatch",
      INPUT_MODE: "prepare",
      INPUT_EXPECTED_HASH: APPROVED_SOURCE_HASH,
    }).mode,
    "prepare",
  );
  for (const change of [{ INPUT_MODE: "delete" }, { INPUT_EXPECTED_HASH: "$(curl bad)" }])
    assert.throws(() =>
      compactionParameters({
        ...env,
        EVENT_NAME: "workflow_dispatch",
        INPUT_MODE: "apply",
        INPUT_EXPECTED_HASH: APPROVED_SOURCE_HASH,
        ...change,
      }),
    );
});
test("workflow has scoped manual gates, no raw artifact export, and step-only existing secrets", () => {
  const yaml = readFileSync(
    new URL("../.github/workflows/screening-source-compaction.yml", import.meta.url),
    "utf8",
  );
  assert.match(yaml, /github.actor == github.repository_owner/);
  assert.match(yaml, /github.ref == 'refs\/heads\/main'/);
  assert.match(yaml, /github.event.issue.number == 16/);
  assert.doesNotMatch(yaml, /upload-artifact|pull_request:\s|schedule:\s/);
  assert.match(yaml, /--private-evidence --restore-private-evidence/);
  assert.match(yaml, /node --max-old-space-size=4096/);
  assert.ok(yaml.indexOf("npm ci --ignore-scripts") < yaml.indexOf("SUPABASE_SERVICE_ROLE_KEY:"));
});
