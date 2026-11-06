import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "tests/preliminary-recovery.test.ts",
      "tests/screening-execution-archive.test.ts",
      "tests/screening-run-archive-storage.test.ts",
      "src/lib/krScreeningPublication.test.ts",
    ],
  },
});
