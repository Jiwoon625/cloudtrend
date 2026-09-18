import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import yaml from "js-yaml";

for (const name of await readdir(".github/workflows")) {
  if (!name.endsWith(".yml")) continue;
  const source = await readFile(`.github/workflows/${name}`, "utf8");
  const workflow = yaml.load(source); // Duplicate mapping keys are rejected.
  assert.ok(workflow.on && Object.keys(workflow.on).length, `${name}: missing trigger`);
  assert.ok(workflow.jobs && Object.keys(workflow.jobs).length, `${name}: missing jobs`);
  if (source.includes("./.github/actions/backtest-source-cache")) {
    assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"), `${name}: missing manual trigger`);
    assert.ok(
      workflow.concurrency.group.includes("github.workflow"),
      `${name}: PR validation can cancel other workflows`,
    );
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const preparations =
        job.steps?.filter((step) => step.uses === "./.github/actions/backtest-source-cache") ?? [];
      if (preparations.length) {
        assert.equal(
          job.concurrency?.group,
          "cloudtrend-backtest-data",
          `${name}/${jobName}: serialize data jobs after conditions`,
        );
      }
      assert.ok(preparations.length <= 1, `${name}/${jobName}: duplicate source preparation`);
    }
  }
}
console.log("PASS: workflow triggers, unique jobs and independent PR validation groups");
