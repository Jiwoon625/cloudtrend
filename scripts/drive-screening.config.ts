import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
/** Run the screening CLI without starting the web application's Vite plugins. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
});
