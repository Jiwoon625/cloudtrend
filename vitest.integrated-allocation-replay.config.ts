import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "tests/integrated-allocation-replay.test.ts",
      "src/lib/integratedAllocationShadow.test.ts",
    ],
    testTimeout: 30_000,
  },
});
