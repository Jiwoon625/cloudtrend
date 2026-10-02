import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
const request = z.object({
  accessToken: z.string().min(1),
  requests: z
    .array(
      z.object({
        strategyId: z.enum(["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW"]),
        sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .max(3),
});
export const usModelTaxProjectionsServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => request.parse(input))
  .handler(async ({ data }) => {
    const { loadUsModelTaxProjections } = await import("./usModelTax.server");
    return loadUsModelTaxProjections(data.accessToken, data.requests);
  });
