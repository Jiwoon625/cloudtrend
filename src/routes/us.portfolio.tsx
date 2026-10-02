import { createFileRoute } from "@tanstack/react-router";
import { UsPortfolioView } from "@/components/UsPortfolioView";
export const Route = createFileRoute("/us/portfolio")({
  ssr: false,
  head: () => ({ meta: [{ title: "US A0 Primary | CloudTrend" }] }),
  component: UsPortfolioView,
});
