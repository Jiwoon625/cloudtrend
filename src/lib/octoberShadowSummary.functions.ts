import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ADOPTED_SERIES_KINDS } from "./ledger/modelSeries";
const request = z.object({
  accessToken: z.string().min(1),
  detailKind: z.enum(ADOPTED_SERIES_KINDS).optional(),
  version: z.enum(["adopted-shadow-2026-10-05-v1", "adopted-shadow-2026-10-12-v1"]).optional(),
});
export const octoberShadowSummaryServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => request.parse(input))
  .handler(async ({ data }) => {
    const { loadOctoberShadowSummary } = await import("./octoberShadowSummary.server");
    return loadOctoberShadowSummary(data.accessToken, data.version, data.detailKind);
  });
