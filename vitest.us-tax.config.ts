import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/lib/*Tax*.test.ts", "src/lib/engine/*Tax*.test.ts", "tests/us-tax-*.test.tsx"],
  },
});
