import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/us-current-ledger-boundary.test.ts",
      "tests/legacy-ledger-retirement-plan.test.ts",
      "tests/us-order-preview-server.test.ts",
      "tests/us-order-preview-cloud.test.ts",
    ],
  },
});
