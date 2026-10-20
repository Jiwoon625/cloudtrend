import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/us-publication-only-recovery.test.ts",
      "tests/us-publication-recovery-integration.test.ts",
    ],
  },
});
