import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/lib/octoberShadowSummary.test.ts",
      "src/lib/octoberShadowSummary.functions.test.ts",
      "src/lib/websitePerformanceBoundary.test.ts",
      "src/lib/octoberShadowPublication.test.ts",
      "src/lib/shadowReplay.test.ts",
      "src/lib/ledger/octoberShadowTax.test.ts",
      "src/components/OctoberShadowSummary.test.tsx",
    ],
  },
});
