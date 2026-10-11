import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/lib/operatingAllocation*.test.ts",
      "src/lib/operatingEtfSizing*.test.ts",
      "src/lib/operatingAnnualSizing*.test.ts",
      "src/components/OperatingAllocationPanel.test.tsx",
      "src/components/OperatingCapitalPlan.test.tsx",
    ],
  },
});
