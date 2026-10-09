import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ADOPTED_SERIES_KINDS, RESTART_SERIES_VERSION } from "./ledger/modelSeries";
const request = z.object({
  accessToken: z.string().min(1),
  detailKind: z.enum(ADOPTED_SERIES_KINDS).optional(),
  version: z.literal(RESTART_SERIES_VERSION).optional(),
});
export const octoberShadowSummaryServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => request.parse(input))
  .handler(async ({ data }) => {
    const { loadOctoberShadowSummary } = await import("./octoberShadowSummary.server");
    return loadOctoberShadowSummary(data.accessToken, RESTART_SERIES_VERSION, data.detailKind);
  });
