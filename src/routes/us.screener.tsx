import { createFileRoute } from "@tanstack/react-router";
import { UsScreenerPage } from "@/components/UsScreenerPage";

export const Route = createFileRoute("/us/screener")({
  ssr: false,
  head: () => ({ meta: [{ title: "US 스크리너 | CloudTrend A0 Prospective" }] }),
  component: UsScreenerPage,
});
