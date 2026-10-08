import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/us-replay-*.test.ts",
      "tests/us-operating-replay.test.ts",
      "tests/us-recovery-*.test.ts",
      "tests/us-recovery-*.test.tsx",
    ],
  },
});
