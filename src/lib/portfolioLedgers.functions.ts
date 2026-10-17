import { loadActualEntryDecisions } from "./actualEntryDecisions.server";
import { activeEntryDecisions } from "./actualEntryDecisions";
import { isActionableActualPriceExit } from "./newActualPriceExit";
import type { PortfolioLedgerViewState } from "./portfolioFreshness";
import { validateExecutionSourceLinks } from "./ledger/executionMemo";
import { loadActualPositionContextForOwner } from "./websitePositionContext.server";
import { attachActualHoldingPriceExits } from "./actualHoldingPriceExit.server";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { operateLedgers } from "./portfolioLedgers.server";
import type { DomesticPositionContext } from "./positionSignalContext";

const sourceLinks = z
  .unknown()
  .superRefine((value, context) => {
    try {
      validateExecutionSourceLinks(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid execution source links" });
    }
  })
  .transform(
    (value) => value as import("./ledger/executionMemo").ExecutionSourceLink[] | undefined,
  );
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
  sourceLinks: sourceLinks.optional(),
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
      sourceLinks: sourceLinks.optional(),
    })
    .optional(),
});
async function authenticate(accessToken: string) {
  const client = createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data: auth, error } = await client.auth.getUser(accessToken);
  if (error || !auth.user) throw new Error("로그인 세션을 확인하세요.");
  return { client, uid: auth.user.id };
}

export const portfolioLedgersServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => request.parse(input))
  .handler(async ({ data }): Promise<PortfolioLedgerViewState> => {
    const { client, uid } = await authenticate(data.accessToken);
    return operateLedgers(client, uid, data);
  });

export const portfolioPositionContextServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string }) => ({
    accessToken: String(input.accessToken ?? ""),
  }))
  .handler(async ({ data }): Promise<DomesticPositionContext> => {
    const { client, uid } = await authenticate(data.accessToken);
    const context = await loadActualPositionContextForOwner(client, uid);
    if (context.actualPools?.KRW) {
      try {
        await attachActualHoldingPriceExits(
          client,
          uid,
          context.actualPools.KRW,
          new Date().toISOString(),
        );
      } catch {
        // Failing a private price-evidence fetch must not be reported as a
        // negative stop. Do not mask pre-existing latched signals.
        for (const p of context.actualPools.KRW.positions) {
          if (
            (p.market === "KOSPI" || p.market === "ETF") &&
            !isActionableActualPriceExit(p.priceExit)
          )
            p.priceExit = {
              policyVersion: "holding-price-exit-k4-e4-v1",
              status: "가격청산 근거 조회 실패 · 확인 대기",
              reason: null,
              threshold: null,
              peak: null,
              signalDate: null,
              auditStatus: "PENDING",
            };
        }
      }
    }
    return {
      actualEntryDecisions: await loadActualEntryDecisions(client, uid)
        .then(activeEntryDecisions)
        .catch(() => null),
      heldSymbols: context.heldSymbols,
      lastSellDateBySymbol: context.lastSellDateBySymbol,
      priceExits: Object.fromEntries(
        (context.actualPools?.KRW.positions ?? []).flatMap((p) =>
          p.priceExit ? [[p.symbol, p.priceExit]] : [],
        ),
      ),
    };
  });
