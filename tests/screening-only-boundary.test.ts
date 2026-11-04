import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it.each([
  "scripts/run-screening.ts",
  "scripts/run-us-screening.ts",
  "src/lib/webScreening.functions.ts",
  "src/lib/krSignalJournal.server.ts",
  "src/lib/usSignalJournal.server.ts",
])("%s has no daily financial writer", (path) => {
  const source = readFileSync(path, "utf8");
  for (const writer of [
    "replayKrShadow(",
    "replayUsShadow(",
    "recordWebOctoberShadow(",
    "refreshPortfolioAfterScreening(",
    "publishAllocatedPerformanceHistory(",
    "stepUsProspectiveOperatingPortfolio(",
    '.from("us_portfolio_snapshots")',
    '.from("us_portfolio_trades")',
  ])
    expect(source).not.toContain(writer);
});
