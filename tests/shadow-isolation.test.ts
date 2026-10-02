import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
describe("Shadow persistence and source integration boundaries", () => {
  it("has no primary/actual ledger writes or reused US model IDs", () => {
    for (const file of [
      "scripts/run-kospi-shadow.ts",
      "src/lib/kospiShadowStore.ts",
      "src/lib/engine/kospiShadow.ts",
    ]) {
      expect(read(file)).not.toMatch(
        /\.from\(["'](?:portfolio|us_portfolio|us_strategy|screening_history|analysis_runs)/,
      );
      expect(read(file)).not.toContain("actual_shares");
      expect(read(file)).not.toContain("A2_QUARTER_SHADOW");
    }
  });
  it("does not export Shadow as an operational entry signal", () => {
    for (const file of [
      "src/lib/engine/operationalStrategy.ts",
      "src/lib/portfolioStoreCore.ts",
      "src/lib/dashboardOperations.ts",
    ]) {
      expect(read(file)).not.toMatch(/kospiShadow|KOSPI_CONFIRM1_BEAR_RSACCEL_SHADOW/);
    }
  });
  it("reads existing US data without rewriting or migrating it", () => {
    expect(read("src/components/UsPortfolioView.tsx")).not.toMatch(
      /\.upsert|\.insert|\.update|\.delete|writeObject/,
    );
    expect(read("src/lib/usProspectiveCloud.ts")).toContain('"A2_QUARTER_SHADOW"');
    expect(read("src/lib/usProspectiveCloud.ts")).toContain('"B3_BETA_SHADOW"');
  });
  it("blocks local publishing and historical repair from newer undated metadata", () => {
    const runner = read("scripts/run-kospi-shadow.ts");
    expect(runner).toContain('process.env["GITHUB_WORKFLOW"] !== "KOSPI prospective Shadow"');
    expect(runner).toContain('process.env["GITHUB_REF"] !== "refs/heads/main"');
    expect(runner).toContain("!dryRun && date !== dataset.asOfDate");
  });
  it("publishes only via serial main-branch jobs after successful collection, without raw datasets", () => {
    const w = read(".github/workflows/kospi-shadow.yml");
    expect(w).toContain("cancel-in-progress: false");
    expect(w).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(w).toContain("github.event.workflow_run.event != 'pull_request'");
    expect(w).not.toContain("pull_request_target");
  });
});
