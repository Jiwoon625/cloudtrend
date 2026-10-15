import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: [
      "tests/integrated-allocation-replay.test.ts",
      "tests/integrated-allocation-runtime-store.test.ts",
      "src/lib/integratedAllocationShadow.test.ts",
      "src/lib/integratedAllocationRuntime*.test.ts",
      "tests/shadow-runtime-preflight.test.ts",
    ],
    testTimeout: 30_000,
  },
});
