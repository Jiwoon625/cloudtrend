import { assertLegacyLedgerActive } from "./legacyLedgerRetirement.server";
import { verifyKrScreeningPublication } from "./krScreeningPublication.server";
import { hydrateScreeningSnapshot } from "./screeningSnapshotStorage";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { createPortfolioStore } from "./portfolioStoreCore";
import { listActiveSources } from "./screeningSources.server";

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
    assertLegacyLedgerActive();
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
        // 예전에는 활성 원천 CSV 52개(약 315MiB)를 통째로 내려받아 데이터셋을 만들었다.
        // Drive v7 게시본에는 그 원천의 라이브 사본이 없고, 원천 세트 전체 다운로드는
        // 라이브 egress 한도를 넘기던 원인이었다. 포트폴리오 재구성은 원장 화면이 맡는다.
        throw new Error(
          "포트폴리오 동기화는 원장 화면(/portfolio)으로 이전되었습니다. 원천 CSV 전체를 다시 내려받지 않습니다.",
        );
      },
    });
    return data.sync ? store.syncPortfolioFromHistory() : store.loadPortfolioState();
  });
