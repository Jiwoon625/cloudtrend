import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { operateUsActual } from "./usActualLedger.server";
const request = z.object({
  accessToken: z.string().min(1),
  action: z.enum(["load", "capital", "execution", "remove", "exclude"]),
  revision: z.number().int().optional(),
  capital: z.number().positive().optional(),
  executionId: z.string().optional(),
  signalKey: z.string().optional(),
  note: z.string().max(300).optional(),
  execution: z
    .object({
      id: z.string(),
      symbol: z.string(),
      name: z.string(),
      market: z.literal("US"),
      signalKey: z.string().nullable(),
      side: z.enum(["BUY", "SELL"]),
      date: z.string(),
      price: z.number().positive(),
      shares: z.number().int().positive(),
      fee: z.number().nonnegative(),
      note: z.string().max(300),
      order: z.number().int(),
    })
    .optional(),
});
export const usActualLedgerServer = createServerFn({ method: "POST" })
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
    if (auth.error || !auth.data.user) throw new Error("로그인 세션을 확인하세요.");
    return operateUsActual(client, auth.data.user.id, data);
  });
