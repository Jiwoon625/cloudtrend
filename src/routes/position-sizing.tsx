import { createFileRoute, redirect } from "@tanstack/react-router";

/** Position sizing is no longer a separate UI; engine sizing policies are unchanged here. */
export const Route = createFileRoute("/position-sizing")({
  beforeLoad: () => {
    throw redirect({ to: "/portfolio", replace: true });
  },
});
