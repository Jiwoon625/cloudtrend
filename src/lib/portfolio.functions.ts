import { verifyKrScreeningPublication } from "./krScreeningPublication.server";
import { hydrateScreeningSnapshot } from "./screeningSnapshotStorage";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { createPortfolioStore } from "./portfolioStoreCore";
import { listActiveSources, loadActiveSources } from "./screeningSources.server";
import { parseManualMarketData } from "./engine/manualDataset";

export const portfolioServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; sync: boolean }) => ({
    accessToken: String(input.accessToken ?? ""),
    sync: input.sync === true,
  }))
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
    if (error || !auth.user) throw new Error("로그인 세션 검증에 실패했습니다.");
    const uid = auth.user.id;
    if (data.sync) {
      const sources = await listActiveSources(client, uid);
      if ((await verifyKrScreeningPublication(client, uid, sources)).phase === "PRELIMINARY")
        throw new Error(
          "KRX 공표 대기 중에는 예비 스크리닝만 제공하며 포트폴리오 동기화는 보류합니다.",
        );
    }
    const { data: history, error: historyError } = await client
      .from("screening_history")
      .select("snapshot")
      .eq("user_id", uid)
      .order("date", { ascending: false })
      .limit(data.sync ? 90 : 1);
    if (historyError) throw historyError;
    const store = createPortfolioStore({
      supabase: client,
      userId: async () => uid,
      loadSnapshots: () => (history ?? []).map((row) => hydrateScreeningSnapshot(row.snapshot)),
      ensureManualDataset: async () => {
        if (!history?.length) return null;
        const { sources, texts } = await loadActiveSources(client, uid);
        const publication = await verifyKrScreeningPublication(client, uid, sources, texts);
        if (publication.phase === "PRELIMINARY")
          throw new Error(
            "KRX 공표 대기 중에는 예비 스크리닝만 제공하며 포트폴리오 동기화는 보류합니다.",
          );
        return parseManualMarketData(texts);
      },
    });
    return data.sync ? store.syncPortfolioFromHistory() : store.loadPortfolioState();
  });
