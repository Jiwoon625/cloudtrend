import { createFileRoute } from "@tanstack/react-router";
import { ShadowPage } from "@/components/ShadowPage";

export const Route = createFileRoute("/shadow")({
  ssr: false,
  head: () => ({ meta: [{ title: "Shadow 연구 관찰 | CloudTrend" }] }),
  component: ShadowPage,
});
