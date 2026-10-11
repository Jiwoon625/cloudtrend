import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/portfolio-tab-scroll.test.tsx",
      "tests/legacy-toss-removal.test.tsx",
      "tests/audit-data-status.test.ts",
      "tests/audit-ui-polish.test.tsx",
      "tests/session-view-state.test.tsx",
      "tests/market-data-ui.test.tsx",
      "tests/reaudit-ui.test.tsx",
      "tests/app-navigation-ui.test.tsx",
      "tests/v8-formula-location-ui.test.tsx",
      "tests/portfolio-model-consolidation.test.ts",
      "tests/portfolio-consolidated-ui.test.tsx",
      "tests/portfolio-consolidation-auth.test.ts",
      "tests/us-data-quality.test.ts",
      "tests/us-browser-views.test.ts",
      "tests/us-market-data-loader.test.ts",
      "tests/shadow-ui.test.tsx",
      "tests/us-tax-ui.test.tsx",
      "src/components/UsOrderPreview.test.tsx",
    ],
  },
});
