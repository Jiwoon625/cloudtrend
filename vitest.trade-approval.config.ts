import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Offline release gate: no production credentials, prices, or network requests.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "src/routes/-api.assistant-trades.test.ts",
      "src/lib/assistantActualTrade.test.ts",
      "src/lib/newActualPortfolio.server.test.ts",
      "src/lib/newActualPortfolioInput.test.ts",
      "src/lib/newActualPortfolio.test.ts",
    ],
  },
});
