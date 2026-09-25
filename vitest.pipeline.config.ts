import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "src/lib/portfolioStrategy.test.ts",
      "src/lib/sourceData.test.ts",
      "tests/screening-pipeline.test.ts",
    ],
  },
});
