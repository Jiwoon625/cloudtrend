import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/debug-candles")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const symbol = new URL(request.url).searchParams.get("symbol") ?? "550082";
        const { debugCandles } = await import("@/lib/engine/toss.server");
        return Response.json(await debugCandles(symbol));
      },
    },
  },
});
