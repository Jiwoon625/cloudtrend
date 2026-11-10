import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "tests/screening-memory*.test.ts",
      "tests/screening-engine-identity.test.ts",
      "tests/drive-publication-publisher.test.ts",
      "tests/drive-publication-writes.test.ts",
      "src/lib/sourceData.test.ts",
      "src/lib/engine/manualDataset.test.ts",
      "src/lib/engine/screeningSourceContract.test.ts",
      "src/lib/engine/etfStrategy.test.ts",
      "src/lib/engine/operationalStrategy.test.ts",
      "tests/fast-chart.test.ts",
      "tests/instrument-chart-cache.test.ts",
      "tests/history-asof.test.ts",
      "tests/dashboard-cache.test.ts",
    ],
  },
});
