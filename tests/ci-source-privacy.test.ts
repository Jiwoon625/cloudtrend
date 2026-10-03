import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/v8-production-etf-pl-validation.yml", import.meta.url),
  "utf8",
);
const [pullRequestChecks, manualChecks] = workflow.split("  manual_source:\n");
const readWorkflow = (name: string) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

describe("public PR validation source privacy", () => {
  it("keeps PR validation synthetic and does not give it production credentials", () => {
    expect(pullRequestChecks).toContain("Targeted V8 policy tests");
    expect(pullRequestChecks).toContain("Build production app");
    expect(pullRequestChecks).not.toMatch(/secrets\.|SUPABASE_|screening:run|source-hash\.ts/);
    expect(pullRequestChecks).not.toContain("validate-v8-production-pl-policy.ts");
  });

  it("requires explicit manual dispatch for every live-source check", () => {
    expect(manualChecks).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(manualChecks).toContain("needs: validate");
    expect(manualChecks).toContain("secrets.SUPABASE_SERVICE_ROLE_KEY");
    expect(manualChecks).toContain("scripts/diagnose-screening-source-hash.ts");
    expect(manualChecks).toContain("scripts/validate-v8-production-pl-policy.ts");
    expect(manualChecks).toContain(
      "--output analysis-runs > analysis-runs/screening-smoke.log 2>&1",
    );
    expect(manualChecks).not.toContain("--upload");
  });

  it("does not publish broad artifacts or stream private source diagnostics", () => {
    expect(workflow).not.toContain("actions/upload-artifact");
    for (const log of ["source-diagnostic", "policy-validation", "screening-smoke"])
      expect(manualChecks).toContain(`> analysis-runs/${log}.log 2>&1`);
    expect(manualChecks?.match(/private source details were not published/g)).toHaveLength(3);
  });

  it("removes the legacy branch exception and keeps live memory regression manual-only", () => {
    const memory = readWorkflow("screening-memory-regression.yml");
    const [checks, manual] = memory.split("  manual_source:\n");
    expect(checks).toContain("workflow_dispatch:");
    expect(checks).toContain("vitest.screening-memory.config.ts");
    expect(checks).not.toMatch(/secrets\.|SUPABASE_|--upload|--force|github\.head_ref/);
    expect(manual).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(manual).toContain("needs: validate");
    expect(manual).toContain("--upload --force > analysis-runs/manual-screening.log 2>&1");
    expect(memory).not.toContain("actions/upload-artifact");
  });

  it.each([
    "ledger-foundation-check.yml",
    "october-shadow-check.yml",
    "retention-check.yml",
    "dashboard-operations-check.yml",
    "screening-cache-contract-check.yml",
    "kospi-operational-strategy.yml",
  ])("keeps %s PR validation free of production credentials", (name) => {
    expect(readWorkflow(name)).not.toMatch(/secrets\.SUPABASE|secrets\.SUPABASE_USER_ID/);
  });

  it("keeps existing US screening and KOSPI advancement outside pull requests", () => {
    const [usValidate, usScreen] = readWorkflow("us-prospective-screening.yml").split(
      "  screen:\n",
    );
    expect(usValidate).not.toContain("secrets.SUPABASE");
    expect(usScreen).toContain("if: github.event_name == 'workflow_dispatch'");
    const [kospiVerify, kospiAdvance] = readWorkflow("kospi-shadow.yml").split("  advance:\n");
    expect(kospiVerify).not.toContain("secrets.SUPABASE");
    expect(kospiAdvance).toContain("github.event_name == 'workflow_dispatch'");
    expect(kospiAdvance).toContain("github.event_name == 'workflow_run'");
    expect(kospiAdvance).toContain("github.event.workflow_run.event != 'pull_request'");
  });

  it("keeps ETF research downloads and production persistence push-only", () => {
    const etf = readWorkflow("etf-v01-implementation.yml");
    const steps = etf.split(/^ {6}- /m).slice(1);
    for (const step of steps) {
      if (/secrets\.SUPABASE|actions\/download-artifact|build-etf-v01-parity-fixture/.test(step))
        expect(step).toContain("if: github.event_name == 'push'");
    }
    expect(etf).toContain("--outputFile=etf-validation/unit-tests.json");
  });
});
