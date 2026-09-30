import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { operateLedgers } from "./portfolioLedgers.server";

const request = z.object({
  accessToken: z.string().min(1),
  action: z.enum(["load", "sync", "capital", "execution", "remove", "exclude"]),
  revision: z.number().int().optional(),
  strategyCapital: z.number().optional(),
  actualCapital: z.number().optional(),
  etfCapital: z.number().positive().optional(),
  executionId: z.string().optional(),
  signalKey: z.string().optional(),
  note: z.string().max(300).optional(),
  execution: z
    .object({
      id: z.string(),
      symbol: z.string(),
      name: z.string(),
      market: z.enum(["KOSPI", "KOSDAQ", "ETF"]),
      signalKey: z.string().nullable(),
      side: z.enum(["BUY", "SELL"]),
      date: z.string(),
      price: z.number().positive(),
      shares: z.number().int().positive(),
      fee: z.number().nonnegative(),
      note: z.string().max(300),
    })
    .optional(),
});
export const portfolioLedgersServer = createServerFn({ method: "POST" })
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
    const { data: auth, error } = await client.auth.getUser(data.accessToken);
    if (error || !auth.user) throw new Error("로그인 세션을 확인하세요.");
    return operateLedgers(client, auth.user.id, data);
  });
