import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/fast-chart.test.ts",
      "tests/instrument-chart-cache.test.ts",
      "tests/instrument-chart-loading.test.ts",
      "tests/instrument-chart-ui.test.tsx",
    ],
  },
});
