import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import {
  CAPITAL_PLAN_ERRORS,
  capitalPlanErrorMessage,
  parseOperatingCapitalPlanRequest,
} from "./operatingCapitalPlan";
import {
  loadOperatingCapitalPlan,
  writeOperatingCapitalPlan,
  type CapitalPlanResult,
} from "./operatingCapitalPlan.server";

export type OperatingCapitalPlanResponse = CapitalPlanResult & {
  action: "load" | "preview" | "save";
  reused?: boolean;
};
/** Existing owner auth/RLS. No read creates a plan and no plan confirms money or activates trading. */
export const operatingCapitalPlanServer = createServerFn({ method: "POST" })
  .inputValidator(parseOperatingCapitalPlanRequest)
  .handler(async ({ data }): Promise<OperatingCapitalPlanResponse> => {
    try {
      const client = createClient(
        import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
        import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
          "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
        {
          global: { headers: { Authorization: `Bearer ${data.accessToken}` } },
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        },
      );
      const auth = await client.auth.getUser(data.accessToken);
      if (auth.error || !auth.data.user) throw new Error(CAPITAL_PLAN_ERRORS.auth);
      const uid = auth.data.user.id;
      if (data.action === "load")
        return { action: "load", ...(await loadOperatingCapitalPlan(client, uid)) };
      return { action: data.action, ...(await writeOperatingCapitalPlan(client, uid, data)) };
    } catch (error) {
      throw new Error(capitalPlanErrorMessage(error));
    }
  });
