import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "tests/dashboard-operations.test.ts",
      "tests/dashboard-operations-server.test.ts",
      "src/lib/dashboardHoldingSignals.test.ts",
      "src/lib/engine/operationalStrategy.test.ts",
      "src/lib/engine/etfStrategy.test.ts",
      "src/lib/engine/usProspective.test.ts",
    ],
  },
});
