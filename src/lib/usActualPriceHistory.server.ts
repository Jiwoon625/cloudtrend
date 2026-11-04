import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { DatedActualPrice } from "./allocatedPerformanceHistory";
import { validDate } from "./ledger/date";

/** Actual valuation uses the preserved close for each date, independent of model signals. */
export async function extendUsActualPriceHistory(
  client: SupabaseClient,
  userId: string,
  input: {
    sourceHash: string;
    throughDate: string;
    prices: DatedActualPrice[];
  },
  symbols: Set<string>,
) {
  const records: Array<{ date: string; data_hash: string; rule_version: string }> = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await client
      .from("us_screening_history")
      .select("date,data_hash,rule_version")
      .eq("user_id", userId)
      .gte("date", "2026-10-12")
      .lt("date", input.throughDate)
      .order("date", { ascending: true })
      .range(offset, offset + 999);
    if (result.error) throw new Error("미국 과거 가격 목록 조회 실패");
    records.push(...(result.data ?? []));
    if ((result.data ?? []).length < 1000) break;
  }
  const dates = new Set<string>(),
    prices: DatedActualPrice[] = [],
    pins: unknown[] = [];
  for (const record of records) {
    if (
      !validDate(record.date) ||
      record.date < "2026-10-12" ||
      record.date >= input.throughDate ||
      dates.has(record.date)
    )
      throw new Error("미국 과거 가격 날짜 식별 오류");
    const file = await client.storage
      .from("cloudtrend-data")
      .download(`${userId}/results/us-screening/${record.date}.json`);
    if (file.error || !file.data) throw new Error("미국 과거 가격 기록 읽기 실패");
    const value = JSON.parse(await file.data.text());
    if (
      value.dataHash !== record.data_hash ||
      value.analysis?.date !== record.date ||
      value.analysis?.ruleVersion !== record.rule_version ||
      !Array.isArray(value.analysis?.rows)
    )
      throw new Error("미국 과거 가격 기록 식별 오류");
    const seen = new Set<string>();
    const selected: DatedActualPrice[] = [];
    for (const row of value.analysis.rows) {
      if (!symbols.has(row.symbol)) continue;
      if (row.date !== record.date || seen.has(row.symbol))
        throw new Error("미국 과거 종목 가격 중복 또는 날짜 오류");
      seen.add(row.symbol);
      if (typeof row.close === "number" && Number.isFinite(row.close) && row.close > 0)
        selected.push({ symbol: row.symbol, date: record.date, close: row.close });
    }
    selected.sort((a, b) => a.symbol.localeCompare(b.symbol));
    dates.add(record.date);
    prices.push(...selected);
    pins.push({ date: record.date, sourceHash: record.data_hash, prices: selected });
  }
  const current = input.prices
    .filter((p) => p.date === input.throughDate && symbols.has(p.symbol))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  dates.add(input.throughDate);
  prices.push(...current);
  const sourceHash =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify({ version: 1, currentSourceHash: input.sourceHash, current, prior: pins }),
      )
      .digest("hex");
  return { dates: [...dates].sort(), prices, sourceHash };
}
