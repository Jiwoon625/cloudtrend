import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "tests/kr-publication-ingestion.test.ts",
      "tests/kr-etf-lifecycle.test.ts",
      "src/lib/sourceRegistryFingerprint.test.ts",
      "src/lib/krScreeningPublication.test.ts",
      "tests/audit-quality-source-order.test.ts",
      "tests/source-validation-cache.test.ts",
      "tests/source-registration-cache.test.ts",
      "tests/storage-upload-retry.test.ts",
      "tests/analysis-run-store-upload.test.ts",
    ],
  },
});
