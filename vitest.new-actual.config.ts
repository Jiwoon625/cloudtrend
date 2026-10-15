import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "src/lib/newActual*.test.ts",
      "src/lib/actualHoldingPriceExit.server.test.ts",
      "src/lib/engine/holdingPriceExit.test.ts",
      "src/components/NewActualPortfolio.test.tsx",
    ],
  },
});
