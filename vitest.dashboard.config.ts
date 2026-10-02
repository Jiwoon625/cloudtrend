import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/components/KospiEntryDetails.test.tsx",
      "src/components/DashboardOperations.test.tsx",
      "tests/dashboard-operations.test.ts",
      "tests/dashboard-operations-server.test.ts",
      "src/lib/dashboardHoldingSignals.test.ts",
      "src/lib/engine/operationalStrategy.test.ts",
      "src/lib/engine/kospiEntryConfirmation.test.ts",
      "tests/kospi-confirmation-persistence.test.ts",
      "src/lib/engine/etfStrategy.test.ts",
      "src/lib/engine/usProspective.test.ts",
    ],
  },
});
