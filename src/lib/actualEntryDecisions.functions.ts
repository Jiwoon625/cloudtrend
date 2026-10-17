import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { entryCommandSchema } from "./actualEntryDecisions";
import { loadActualEntryDecisions, saveActualEntryDecision } from "./actualEntryDecisions.server";
const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load"), accessToken: z.string().min(1) }).strict(),
  z
    .object({
      action: z.literal("save"),
      accessToken: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      command: entryCommandSchema,
    })
    .strict(),
]);
export const actualEntryDecisionsServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => request.parse(input))
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
      throw new Error("로그인 세션을 확인하세요.");
    return data.action === "load"
      ? loadActualEntryDecisions(client, auth.data.user.id)
      : saveActualEntryDecision(client, auth.data.user.id, data.command, data.expectedRevision);
  });
