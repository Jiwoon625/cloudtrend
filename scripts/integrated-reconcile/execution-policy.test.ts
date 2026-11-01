import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { reconciliationBudget } from "./execution-policy";
const workflow = readFileSync(".github/workflows/integrated-reconciliation.yml", "utf8");
const upstream = readFileSync(".github/workflows/us-prospective-screening.yml", "utf8");
const gate = workflow.match(/ {4}if: >-\n([\s\S]*?)\n {4}runs-on:/)![1].trim();
const title = upstream.match(/run-name: \$\{\{ (.*) \}\}/)![1];
const repo = "Jiwoon625/cloudtrend";
function allowed(overrides: Record<string, unknown> = {}, root: Record<string, unknown> = {}) {
  return runInNewContext(gate, {
    github: {
      repository: repo,
      event_name: "workflow_run",
      sha: "same-reviewed-commit",
      ref: "refs/heads/main",
      event: {
        workflow_run: {
          name: "US Prospective Screening",
          display_title: "US ordinary screening",
          conclusion: "success",
          head_branch: "main",
          event: "workflow_dispatch",
          head_sha: "same-reviewed-commit",
          head_repository: { full_name: repo },
          ...overrides,
        },
      },
      ...root,
    },
    inputs: {},
  });
}
it.each([false, true])(
  "normal US dispatch label is eligible independent of replay_apply=%s (upstream validates illegal flags)",
  (apply) => {
    const display_title = runInNewContext(title, {
      github: { event_name: "workflow_dispatch" },
      inputs: { replay_manifest_path: "", replay_apply: apply },
    });
    expect(display_title).toBe("US ordinary screening");
    expect(allowed({ display_title })).toBe(true);
  },
);
it.each([false, true])("all manifest recovery modes excluded even successful apply=%s", (apply) => {
  const display_title = runInNewContext(title, {
    github: { event_name: "workflow_dispatch" },
    inputs: { replay_manifest_path: "private/manifest.json", replay_apply: apply },
  });
  expect(allowed({ display_title })).toBe(false);
});
it.each(["push", "pull_request", "issue_comment"])("non-dispatch %s cannot auto-write", (event) => {
  expect(allowed({ event })).toBe(false);
  const display_title = runInNewContext(title, { github: { event_name: event }, inputs: {} });
  expect(allowed({ display_title })).toBe(false);
});
it.each([
  { conclusion: "failure" },
  { conclusion: "cancelled" },
  { head_branch: "feature" },
  { head_sha: "old-or-unreviewed-commit" },
  { head_repository: { full_name: "fork/cloudtrend" } },
  { name: "Other workflow" },
  { display_title: "US Prospective Screening" },
])("untrusted, stale or ineligible completion is fail-closed: %j", (override) =>
  expect(allowed(override)).toBe(false),
);
it("normal KR upload dispatch eligible; comments and push validation excluded", () => {
  expect(allowed({ name: "CloudTrend screening", display_title: "arbitrary dispatch title" })).toBe(
    true,
  );
  expect(allowed({ name: "CloudTrend screening", event: "issue_comment" })).toBe(false);
  expect(allowed({}, { repository: "fork/cloudtrend" })).toBe(false);
});
it("manual execution only on own main", () => {
  expect(allowed({}, { event_name: "workflow_dispatch" })).toBe(true);
  expect(allowed({}, { event_name: "workflow_dispatch", ref: "refs/heads/feature" })).toBe(false);
});
it("readonly acceptance defaults 8MiB; full inspection explicit; apply stays 256MiB", () => {
  expect(reconciliationBudget("false")).toBe(8 * 1024 ** 2);
  expect(reconciliationBudget("false", "256")).toBe(256 * 1024 ** 2);
  expect(reconciliationBudget("true")).toBe(256 * 1024 ** 2);
  expect(() => reconciliationBudget("yes")).toThrow();
  expect(() => reconciliationBudget("false", "9000")).toThrow();
  expect(workflow).toContain("RECONCILE_INSPECTION_BUDGET_MIB:");
});
