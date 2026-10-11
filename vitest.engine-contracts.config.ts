import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "src/lib/engine/**/*.test.ts",
      "src/lib/verifiedIndexHistoryBoundary.test.ts",
      "scripts/audit-verified-index-membership.test.ts",
    ],
  },
});
