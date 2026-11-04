import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AllocatedPerformanceHistory } from "./allocatedPerformanceHistory";

/** Only a derived report for the authenticated owner's current ledger revision. */
export const allocatedPerformanceHistoryServer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), currency: z.enum(["KRW", "USD"]) }).parse(input),
  )
  .handler(async ({ data }): Promise<AllocatedPerformanceHistory | null> => {
    const client = createClient(
      import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
      import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
        "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
      {
        global: { headers: { Authorization: `Bearer ${data.accessToken}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const auth = await client.auth.getUser(data.accessToken);
    if (auth.error || !auth.data.user) throw new Error("로그인 확인 필요");
    const { readWebsiteDocument } = await import("./ledger/websiteRepository.server");
    const uid = auth.data.user.id;
    const system = data.currency === "KRW" ? "portfolio_ledgers" : "us_actual_portfolio_ledgers";
    const ledger = await readWebsiteDocument(client, uid, system);
    if (!ledger) return null;
    const root = `${uid}/results/actual-performance/${data.currency}/revision-${ledger.revision}`;
    const { data: files, error } = await client.storage
      .from("cloudtrend-data")
      .list(root, { limit: 1000, sortBy: { column: "name", order: "desc" } });
    if (error) throw new Error("실제 성과 기록 조회 실패");
    const candidates = (files ?? [])
      .filter((f) => /^\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.json$/.test(f.name))
      .sort(
        (a, b) =>
          b.name.slice(0, 10).localeCompare(a.name.slice(0, 10)) ||
          String(b.updated_at).localeCompare(String(a.updated_at)),
      );
    if (!candidates.length) return null;
    const report = await client.storage
      .from("cloudtrend-data")
      .download(`${root}/${candidates[0]!.name}`);
    if (report.error) throw new Error("실제 성과 기록 읽기 실패");
    const history = JSON.parse(await report.data.text()) as AllocatedPerformanceHistory;
    const fresh = await readWebsiteDocument(client, uid, system);
    if (fresh?.revision !== ledger.revision)
      throw new Error("실제 원장이 변경됐습니다. 다시 조회하세요.");
    if (
      history.version !== 1 ||
      history.currency !== data.currency ||
      history.sourceRevision !== ledger.revision ||
      history.throughDate !== candidates[0]!.name.slice(0, 10) ||
      !Array.isArray(history.points)
    )
      throw new Error("실제 성과 기록 식별 오류");
    return history;
  });
