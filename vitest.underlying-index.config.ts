import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "tests/underlying-index*.test.ts",
      "tests/operational-ma60*.test.ts",
      "tests/etf-instrument-chart.test.ts",
      "tests/etf-instrument-chart-ui.test.tsx",
      "tests/instrument-chart-cache.test.ts",
      "src/lib/engine/etfStrategy.test.ts",
    ],
  },
});
