import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import {
  actualPerformanceErrorMessage,
  parseActualPerformanceRequest,
} from "./actualPerformanceInput";
import {
  previewReviewedActualPerformance,
  saveReviewedActualPerformance,
  validateAllocatedExecutions,
  type ActualPerformanceDocument,
} from "./actualPerformance.server";
import type { UsActualDocument } from "./usActualLedger";
import {
  actualPerformanceView,
  pendingActualPerformance,
  type ActualPerformanceSeries,
  type ActualPerformanceView,
} from "./ledger/actualPerformance";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";

export type ActualPerformanceResponse =
  | {
      action: "load";
      revision: number | null;
      usRevision: number | null;
      series: ActualPerformanceSeries;
      view: ActualPerformanceView;
    }
  | ({ action: "preview" } & Awaited<ReturnType<typeof previewReviewedActualPerformance>>)
  | ({ action: "save" } & Awaited<ReturnType<typeof saveReviewedActualPerformance>>);

/** Owner-scoped new-capital reporting only. Loading and previewing never create a ledger. */
export const actualPerformanceServer = createServerFn({ method: "POST" })
  .inputValidator(parseActualPerformanceRequest)
  .handler(async ({ data }): Promise<ActualPerformanceResponse> => {
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
      if (auth.error || !auth.data.user) throw new Error("로그인 세션을 확인하세요.");
      const userId = auth.data.user.id;
      if (data.action === "load") {
        const [domestic, us] = await Promise.all([
          readWebsiteDocument<ActualPerformanceDocument>(client, userId, "portfolio_ledgers"),
          readWebsiteDocument<UsActualDocument>(client, userId, "us_actual_portfolio_ledgers"),
        ]);
        const series = domestic?.payload.actualPerformance ?? pendingActualPerformance();
        if (domestic) validateAllocatedExecutions(series, domestic.payload, us?.payload ?? null);
        return {
          action: "load",
          revision: domestic?.revision ?? null,
          usRevision: us?.revision ?? null,
          series,
          view: actualPerformanceView(series),
        };
      }
      const input = { ...data.input, expectedRevision: data.expectedRevision };
      if (data.action === "preview")
        return {
          action: "preview",
          ...(await previewReviewedActualPerformance(client, userId, input)),
        };
      // The strict discriminated schema accepts this action only with reviewConfirmed === true.
      return { action: "save", ...(await saveReviewedActualPerformance(client, userId, input)) };
    } catch (error) {
      throw new Error(actualPerformanceErrorMessage(error));
    }
  });
