import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/lib/ledger/actualPerformance.test.ts",
      "src/lib/actualPerformance*.test.ts",
      "src/components/ActualPerformance*.test.tsx",
    ],
  },
});
