import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/lib/research/*.test.ts",
      "tests/adopted-backtest*.test.ts",
      "src/lib/engine/manualDataset.test.ts",
    ],
  },
});
