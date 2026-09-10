// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const codeVersion =
  process.env["VERCEL_GIT_COMMIT_SHA"] ??
  process.env["GITHUB_SHA"] ??
  process.env["LOVABLE_GIT_COMMIT_SHA"] ??
  "dev";

export default defineConfig({
  vite: {
    define: {
      "import.meta.env.VITE_CLOUDTREND_CODE_VERSION": JSON.stringify(codeVersion),
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
