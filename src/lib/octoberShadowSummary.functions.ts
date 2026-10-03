import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
const request = z.object({ accessToken: z.string().min(1) });
export const octoberShadowSummaryServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => request.parse(input))
  .handler(async ({ data }) => {
    const { loadOctoberShadowSummary } = await import("./octoberShadowSummary.server");
    return loadOctoberShadowSummary(data.accessToken);
  });
