import { createServerFn } from "@tanstack/react-start";

export const dashboardOperationsServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string }) => ({ accessToken: String(input.accessToken ?? "") }))
  .handler(async ({ data }) => {
    const { loadDashboardOperations } = await import("./dashboardOperations.server");
    return loadDashboardOperations(data.accessToken);
  });

export const dashboardEtfHoldingsServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; symbols: string[] }) => ({
    accessToken: String(input.accessToken ?? ""), symbols: input.symbols,
  }))
  .handler(async ({ data }) => {
    const { saveDashboardEtfHoldings } = await import("./dashboardOperations.server");
    return saveDashboardEtfHoldings(data.accessToken, data.symbols);
  });
