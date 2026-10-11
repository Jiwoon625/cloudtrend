import type { QueryClient } from "@tanstack/react-query";

export const DASHBOARD_OPERATIONS_QUERY = [
  "dashboard-operations",
  "actual-lifecycle-2026-10-12-v1",
];

/** Saving an actual fill usually happens while the dashboard is unmounted.
 * Mark derived reads stale without calculating or starting a hidden refresh.
 */
export async function invalidateActualPositionViews(client: QueryClient, refetchActive = false) {
  // A read begun before the fill must not overwrite the later invalidation.
  await Promise.all([
    client.cancelQueries({ queryKey: DASHBOARD_OPERATIONS_QUERY }),
    client.cancelQueries({ queryKey: ["domestic-position-context"] }),
    client.cancelQueries({ queryKey: ["operating-allocation"] }),
  ]);
  await Promise.all([
    client.invalidateQueries({
      queryKey: DASHBOARD_OPERATIONS_QUERY,
      refetchType: refetchActive ? "active" : "none",
    }),
    client.invalidateQueries({
      queryKey: ["domestic-position-context"],
      refetchType: refetchActive ? "active" : "none",
    }),
    client.invalidateQueries({
      queryKey: ["operating-allocation"],
      refetchType: refetchActive ? "active" : "none",
    }),
  ]);
}
