import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
const schema = z
  .object({
    accessToken: z.string().min(1).max(16000),
    action: z.enum(["load", "initialize"]),
    kind: z.enum(["O1", "S07"]).optional(),
  })
  .strict();
export const integratedAllocationShadowServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data }) => {
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
      throw new Error("로그인 소유자 확인 필요");
    const { readIntegratedAllocationBook, initializeIntegratedAllocationBook } =
      await import("./integratedAllocationStore.server");
    const kinds = data.kind ? [data.kind] : (["O1", "S07"] as const);
    const books = [];
    for (const kind of kinds)
      books.push(
        await (data.action === "initialize"
          ? initializeIntegratedAllocationBook(client, auth.data.user.id, kind)
          : readIntegratedAllocationBook(client, auth.data.user.id, kind)),
      );
    return { checkedAt: new Date().toISOString(), books };
  });
