import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gunzipSync } from "node:zlib";
import { downloadFreshObject } from "./freshStorage";
import { keyFor, type Quote } from "./portfolioLedgers";
import {
  migrateUsActual,
  calculateUsActual,
  changeUsActual,
  type UsActualDocument,
  type UsActualRequest,
  type UsActualState,
  type UsCandidate,
} from "./usActualLedger";
import type { UsPortfolioTradeRecord, UsProspectiveCache } from "./usProspectiveCloud";

const TABLE = "us_actual_portfolio_ledgers";
async function read(
  client: SupabaseClient,
  uid: string,
): Promise<{ revision: number; payload: UsActualDocument }> {
  const canonical = await readWebsiteDocument<UsActualDocument>(client, uid, TABLE);
  if (canonical) return canonical;
  const trades: UsPortfolioTradeRecord[] = [];
  for (let start = 0; ; start += 500) {
    const page = await client
      .from("us_portfolio_trades")
      .select("*")
      .eq("user_id", uid)
      .eq("strategy_id", "A0_QUARTER_PRIMARY")
      .not("actual_shares", "is", null)
      .order("trade_key")
      .range(start, start + 499);
    if (page.error) throw new Error(page.error.message);
    trades.push(...(page.data ?? []));
    if (!page.data || page.data.length < 500) break;
  }
  const payload = migrateUsActual(trades);
  const inserted = await client.from(TABLE).insert({ user_id: uid, revision: 1, payload });
  if (inserted.error?.code === "23505") return read(client, uid);
  if (inserted.error) throw new Error(inserted.error.message);
  const created = await readWebsiteDocument<UsActualDocument>(client, uid, TABLE);
  if (!created) throw new Error("통합 실제 원장 생성을 확인하지 못했습니다.");
  return created;
}
async function candidatesFor(client: SupabaseClient, uid: string) {
  const candidates: UsCandidate[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await client
      .from("us_a0_entry_signals")
      .select("date,symbol,name")
      .eq("user_id", uid)
      .order("date", { ascending: false })
      .order("symbol")
      .range(start, start + 499);
    if (error) throw new Error(error.message);
    for (const c of data ?? []) candidates.push({ ...c, key: keyFor(c.symbol, c.date) });
    if (!data || data.length < 500) break;
  }
  return candidates;
}
export async function quotesFor(client: SupabaseClient, uid: string, symbols: Set<string>) {
  const quotes: Record<string, Quote> = {};
  if (!symbols.size) return quotes;
  const zipped = await downloadFreshObject(
    client,
    "cloudtrend-data",
    `${uid}/cache/us-screening/view-v1.json.gz`,
  );
  let cache: UsProspectiveCache;
  if (zipped.data)
    cache = JSON.parse(
      gunzipSync(new Uint8Array(await zipped.data.arrayBuffer())).toString("utf8"),
    );
  else {
    const legacy = await downloadFreshObject(
      client,
      "cloudtrend-data",
      `${uid}/cache/us-screening/latest.json`,
    );
    if (legacy.error || !legacy.data)
      throw new Error("미국 평가가격을 불러오지 못했습니다. 새로고침해 주세요.");
    cache = JSON.parse(await legacy.data.text());
  }
  for (const r of cache.analysis.rows)
    if (symbols.has(r.symbol) && r.close && Number.isFinite(r.close) && r.close > 0)
      quotes[r.symbol] = {
        price: r.close,
        date: r.date || cache.analysis.date,
        exitSignal: r.a0BetaExit
          ? "Beta 상위 40% 밖 3거래일 연속"
          : r.a0Exit
            ? "A0 청산 신호"
            : null,
      };
  return quotes;
}
export async function operateUsActual(
  client: SupabaseClient,
  uid: string,
  input: UsActualRequest,
): Promise<UsActualState> {
  const [row, candidates] = await Promise.all([read(client, uid), candidatesFor(client, uid)]);
  const doc = structuredClone(row.payload);
  if (input.action !== "load") {
    if (input.revision !== row.revision)
      throw new Error("다른 화면에서 원장이 변경됐습니다. 새로고침 후 다시 저장하세요.");
    changeUsActual(
      doc,
      input,
      candidates,
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    );
  }
  const quotes = await quotesFor(
    client,
    uid,
    new Set([...candidates.map((c) => c.symbol), ...doc.executions.map((e) => e.symbol)]),
  );
  const latest =
    Object.values(quotes)
      .map((q) => q.date)
      .sort()
      .at(-1) ?? null;
  const actual = calculateUsActual(doc.capital, doc.executions, quotes, latest);
  let revision = row.revision;
  if (input.action !== "load") {
    const result = await client
      .from(TABLE)
      .update({ payload: doc, revision: revision + 1, updated_at: new Date().toISOString() })
      .eq("user_id", uid)
      .eq("revision", revision)
      .select("revision")
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("동시에 원장이 변경됐습니다. 새로고침 후 다시 시도하세요.");
    revision++;
  }
  return { revision, document: doc, actual, candidates, quotes };
}
