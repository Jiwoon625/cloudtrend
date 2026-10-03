import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old portfolio links land on the unified portfolio's US asset panel. */
export const Route = createFileRoute("/us/portfolio")({
  beforeLoad: () => {
    throw redirect({ to: "/portfolio", search: { asset: "US" }, replace: true });
  },
});
