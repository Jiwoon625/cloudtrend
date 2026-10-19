import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "tests/us-revision-*.test.ts",
      "tests/us-same-session-reference.test.ts",
      "tests/us-same-session-reference-ui.test.tsx",
    ],
  },
});
