import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/portfolio-screening-refresh.test.ts",
      "src/lib/screeningSnapshotStorage.test.ts",
      "tests/screening-snapshot-boundaries.test.ts",
      "tests/web-screening-server-only.test.ts",
      "tests/screening-memory-cli.test.ts",
      "src/components/PortfolioPendingEntries.test.tsx",
      "src/components/PortfolioFreshnessSummary.test.tsx",
      "src/lib/ledgerUiMutation.test.ts",
    ],
  },
});
