import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import {
  OPERATING_ALLOCATION_ERRORS,
  operatingAllocationErrorMessage,
  parseOperatingAllocationRequest,
} from "./operatingAllocation";

export const operatingAllocationServer = createServerFn({ method: "POST" })
  .inputValidator(parseOperatingAllocationRequest)
  .handler(async ({ data }) => {
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
      if (auth.error || !auth.data.user || auth.data.user.is_anonymous)
        throw new Error(OPERATING_ALLOCATION_ERRORS.auth);
      const { loadOperatingAllocation, writeOperatingAllocation } =
        await import("./operatingAllocation.server");
      return data.action === "load"
        ? await loadOperatingAllocation(client, auth.data.user.id, data.currency)
        : await writeOperatingAllocation(client, auth.data.user.id, data);
    } catch (error) {
      throw new Error(operatingAllocationErrorMessage(error));
    }
  });
