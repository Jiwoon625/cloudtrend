import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/lib/stockAssessmentDisplay.test.ts",
      "src/components/DomesticAssessmentPanel.test.tsx",
      "src/lib/etfPartialEvidence.test.ts",
      "src/components/EtfScreener.test.tsx",
      "src/components/KospiEntryDetails.test.tsx",
      "src/components/UniverseFilterDetails.test.tsx",
      "src/components/DashboardOperations.test.tsx",
      "src/components/UsOrderPreview.test.tsx",
      "src/lib/engine/usProspectiveOrderPreview.test.ts",
      "src/lib/usOrderPreview*.test.ts",
      "tests/us-order-preview*.test.ts",
      "tests/dashboard-operations.test.ts",
      "tests/dashboard-operations-sector-limits.test.ts",
      "tests/dashboard-operations-server.test.ts",
      "src/lib/dashboardHoldingSignals.test.ts",
      "src/lib/statusDisplay.test.ts",
      "src/lib/engine/operationalStrategy.test.ts",
      "src/lib/engine/kospiEntryConfirmation.test.ts",
      "tests/kospi-confirmation-persistence.test.ts",
      "src/lib/engine/etfStrategy.test.ts",
      "src/lib/engine/usProspective.test.ts",
    ],
  },
});
