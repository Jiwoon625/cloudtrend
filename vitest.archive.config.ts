import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["scripts/archived-storage.test.ts", "scripts/kr-vintage-preflight/transport.test.ts"],
  },
});
