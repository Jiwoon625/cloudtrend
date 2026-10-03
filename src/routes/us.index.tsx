import { createFileRoute, redirect } from "@tanstack/react-router";

/** Preserve existing bookmarks while keeping one market/data navigation destination. */
export const Route = createFileRoute("/us/")({
  beforeLoad: () => {
    throw redirect({ to: "/data-status", hash: "us-data", replace: true });
  },
});
