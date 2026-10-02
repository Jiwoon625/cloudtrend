import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
/** CLI-only config: do not boot TanStack Start/Nitro while advancing the model journal. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
});
