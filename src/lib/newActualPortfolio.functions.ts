import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { parseNewActualPortfolioRequest } from "./newActualPortfolioInput";
import {
  loadNewActualPortfolio,
  saveNewActualPortfolio,
  type NewActualPortfolioResponse,
} from "./newActualPortfolio.server";
export type { NewActualPortfolioResponse } from "./newActualPortfolio.server";
export type { NewActualPortfolioRequest } from "./newActualPortfolioInput";

/** Existing owner authorization and canonical bridge only. No service-role keys or broker API. */
export const newActualPortfolioServer = createServerFn({ method: "POST" })
  .inputValidator(parseNewActualPortfolioRequest)
  .handler(async ({ data }): Promise<NewActualPortfolioResponse> => {
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
    try {
      if (data.action !== "load") await saveNewActualPortfolio(client, auth.data.user.id, data);
      return await loadNewActualPortfolio(client, auth.data.user.id);
    } catch (error) {
      // Static Korean validation messages are actionable; don't expose backend SQL/source details.
      const message = error instanceof Error ? error.message : "";
      throw new Error(
        /[가-힣]/.test(message)
          ? message
          : "신규 배정 자료를 확인해 주세요. 신규 보유보다 많은 매도, 중복 체결 근거, 배정 수량·금액·비용 또는 원장 연결을 대조한 뒤 새로고침하세요.",
      );
    }
  });
