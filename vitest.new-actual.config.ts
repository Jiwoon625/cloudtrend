import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    // K4 as-of pooled cost and actual E4 acquisition lots must run in ledger CI.
    include: [
      "src/lib/newActual*.test.ts",
      "src/routes/-api.assistant-trades.test.ts",
      "src/lib/actualHoldingPriceExit.server.test.ts",
      "src/lib/actualHoldingPriceInputs.server.test.ts",
      "src/lib/actualHoldingPriceLots.test.ts",
      "src/lib/engine/holdingPriceExit.test.ts",
      "src/components/NewActualPortfolio.test.tsx",
    ],
  },
});
