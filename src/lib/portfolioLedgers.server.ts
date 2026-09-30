import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveSources, type ActiveSourceRecord } from "./screeningSources.server";
import { visitDelimitedRows } from "./sourceData";
import type { DailyPrice, Market } from "./engine/types";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import {
  calculateActual,
  keyFor,
  LEDGER_VERSION,
  simulateStrategy,
  type ActualExecution,
  type DualPortfolioState,
  type LedgerDocument,
} from "./portfolioLedgers";

const TABLE = "portfolio_ledgers";
type Row = { revision: number; payload: LedgerDocument };
export interface LedgerRequest {
  action: "load" | "sync" | "capital" | "execution" | "remove" | "exclude";
  revision?: number | undefined;
  strategyCapital?: number | undefined;
  actualCapital?: number | undefined;
  execution?: Omit<ActualExecution, "order"> | undefined;
  executionId?: string | undefined;
  signalKey?: string | undefined;
  note?: string | undefined;
}
async function readDocument(client: SupabaseClient, uid: string): Promise<Row> {
  const { data, error } = await client
    .from(TABLE)
    .select("revision,payload")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data as Row;
  const [{ data: settings, error: se }, { data: legacy, error: le }] = await Promise.all([
    client.from("portfolio_settings").select("*").eq("user_id", uid).maybeSingle(),
    client
      .from("portfolio_trades")
      .select("*")
      .eq("user_id", uid)
      .order("entry_date")
      .order("symbol"),
  ]);
  if (se || le) throw new Error((se ?? le)!.message);
  const capital = Number(settings?.initial_capital ?? 10_000_000);
  const executions: ActualExecution[] = [];
  const excluded: Record<string, string> = {};
  for (const t of legacy ?? []) {
    const signalKey = keyFor(t.symbol, t.signal_date);
    if (Number(t.shares) <= 0) {
      excluded[signalKey] = "기존 미매수 · 0주";
      continue;
    }
    const shared = {
      symbol: String(t.symbol),
      name: String(t.name),
      market: t.market as Market,
      signalKey,
      shares: Number(t.shares),
      note: "",
    };
    executions.push({
      ...shared,
      id: `legacy-buy-${t.id}`,
      side: "BUY",
      date: String(t.entry_date),
      price: Number(t.entry_price),
      fee: Number(t.entry_fee),
      order: executions.length,
    });
    if (t.status === "CLOSED" && Number(t.exit_price) > 0 && t.exit_date)
      executions.push({
        ...shared,
        id: `legacy-sell-${t.id}`,
        side: "SELL",
        date: String(t.exit_date),
        price: Number(t.exit_price),
        fee: Number(t.exit_fee),
        order: executions.length,
      });
  }
  const payload: LedgerDocument = {
    version: LEDGER_VERSION,
    settings: {
      initialCapital: capital,
      maxPositions: 30,
      sectorCap: Number(settings?.sector_cap ?? 0.3),
      roundTripCostRate: Number(settings?.round_trip_cost_rate ?? 0.003),
    },
    actualCapital: capital,
    executions,
    excluded,
    strategy: null,
    migratedAt: new Date().toISOString(),
  };
  calculateActual(capital, executions, {}, null);
  const { error: insertError } = await client
    .from(TABLE)
    .insert({ user_id: uid, payload, revision: 1 });
  if (insertError?.code === "23505") return readDocument(client, uid);
  if (insertError) throw new Error(insertError.message);
  return { revision: 1, payload };
}
async function snapshotsFor(client: SupabaseClient, uid: string) {
  const result: ScreeningSnapshot[] = [];
  for (let start = 0; ; start += 200) {
    const { data, error } = await client
      .from("screening_history")
      .select("snapshot")
      .eq("user_id", uid)
      .order("date")
      .range(start, start + 199);
    if (error) throw new Error(error.message);
    result.push(...(data ?? []).map((r) => r.snapshot as ScreeningSnapshot));
    if (!data || data.length < 200) break;
  }
  return result;
}

/** Read only relevant daily OHLC rows, one source at a time; never send raw market history to the browser. */
async function priceInputs(
  client: SupabaseClient,
  sources: ActiveSourceRecord[],
  symbols: Set<string>,
  from: string,
) {
  const bySymbol = new Map<string, Map<string, DailyPrice>>();
  const markets: Record<string, Market> = {};
  for (const source of sources) {
    if (source.max_date && source.max_date < from) continue;
    const { data, error } = await client.storage
      .from(source.storage_bucket)
      .download(source.storage_path);
    if (error || !data)
      throw new Error(`포트폴리오 가격 조회 실패: ${error?.message ?? source.original_filename}`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.file_hash)
      throw new Error("가격 원본 검증에 실패했습니다.");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("euc-kr").decode(bytes);
    }
    let header: Record<string, number> = {};
    visitDelimitedRows(text, (cells, index) => {
      if (index === 0) {
        header = Object.fromEntries(
          cells.map((v, i) => [
            v
              .replace(/^\uFEFF/, "")
              .trim()
              .toLowerCase(),
            i,
          ]),
        );
        return;
      }
      const cell = (key: string) => cells[header[key]!] ?? "";
      const symbol = cell("symbol"),
        date = cell("date");
      if (!symbols.has(symbol) || date < from) return;
      const market = cell("market");
      if (market !== "KOSPI" && market !== "KOSDAQ") return;
      const number = (key: string) => Number(cell(key).replaceAll(",", ""));
      if (number("open") <= 0 || number("close") <= 0) return;
      const series = bySymbol.get(symbol) ?? new Map<string, DailyPrice>();
      if (!series.has(date))
        series.set(date, {
          tradeDate: date,
          open: number("open"),
          close: number("close"),
          high: number("high"),
          low: number("low"),
          volume: number("volume"),
          tradingValue: 0,
          marketCap: null,
          foreignNetBuyValue: null,
          institutionNetBuyValue: null,
        });
      bySymbol.set(symbol, series);
      markets[symbol] = market;
    });
  }
  const bars = Object.fromEntries(
    [...bySymbol].map(([s, b]) => [
      s,
      [...b.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)),
    ]),
  );
  return { bars, markets };
}

async function refreshStrategy(client: SupabaseClient, uid: string, doc: LedgerDocument) {
  const [snapshots, sources] = await Promise.all([
    snapshotsFor(client, uid),
    listActiveSources(client, uid),
  ]);
  const symbols = new Set(doc.executions.map((e) => e.symbol));
  for (const s of snapshots)
    for (const e of s.entries) if (e.kospi80Onset || e.kosdaq80Onset) symbols.add(e.symbol);
  // Include old KOSDAQ status-only onsets, supported by the original rule.
  for (const s of snapshots)
    for (const e of s.entries)
      if (/KOSDAQ\s*(?:80|8)\s*Onset/i.test(e.status ?? "")) symbols.add(e.symbol);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: LEDGER_VERSION,
        settings: [
          doc.settings.initialCapital,
          doc.settings.maxPositions,
          doc.settings.sectorCap,
          doc.settings.roundTripCostRate,
        ],
        sources: sources.map((s) => [s.id, s.file_hash, s.activated_at]),
        snapshots,
        symbols: [...symbols].sort(),
      }),
    )
    .digest("hex");
  if (doc.strategy?.fingerprint === fingerprint) return false;
  const from =
    [...snapshots.map((s) => s.asOfDate), ...doc.executions.map((e) => e.date)]
      .filter(Boolean)
      .sort()[0] ?? "9999-12-31";
  const { bars, markets } = await priceInputs(client, sources, symbols, from);
  doc.strategy = simulateStrategy(doc.settings, snapshots, bars, markets, fingerprint);
  return true;
}

export async function operateLedgers(
  client: SupabaseClient,
  uid: string,
  input: LedgerRequest,
): Promise<DualPortfolioState> {
  const row = await readDocument(client, uid);
  const doc = structuredClone(row.payload);
  let changed = false;
  for (const execution of doc.executions) {
    if (execution.note === "기존 0주 초과 기록 이관 · 기존 비용 유지") {
      execution.note = "";
      changed = true;
    }
  }
  if (input.action !== "load" && input.action !== "sync" && input.revision !== row.revision)
    throw new Error("다른 화면에서 원장이 변경됐습니다. 새로고침 후 다시 저장하세요.");
  if (input.action === "capital") {
    for (const v of [input.strategyCapital, input.actualCapital])
      if (!Number.isFinite(v) || v! <= 0 || v! > 1e15)
        throw new Error("운용자금은 0보다 큰 금액으로 입력하세요.");
    doc.settings.initialCapital = input.strategyCapital!;
    doc.actualCapital = input.actualCapital!;
    changed = true;
  }
  if (input.action === "execution") {
    const e = input.execution;
    if (!e) throw new Error("체결 정보를 입력하세요.");
    const existing = doc.executions.find((x) => x.id === e.id);
    if (e.id && !existing) throw new Error("수정할 체결 기록을 찾지 못했습니다.");
    const candidate = doc.strategy?.candidates.find((c) => c.key === e.signalKey);
    const position = doc.executions.find((x) => x.symbol === e.symbol);
    if (!candidate && !position) throw new Error("등록된 Onset 또는 실제 보유 종목을 선택하세요.");
    if (e.date > new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }))
      throw new Error("미래 날짜로 실제 체결을 기록할 수 없습니다.");
    if (
      !Number.isFinite(Date.parse(e.date)) ||
      new Date(e.date).toISOString().slice(0, 10) !== e.date
    )
      throw new Error("체결 날짜를 확인하세요.");
    const meta = candidate ?? position!;
    if (e.symbol !== meta.symbol) throw new Error("체결 종목과 신호가 다릅니다.");
    const event: ActualExecution = {
      id: existing?.id ?? crypto.randomUUID(),
      symbol: meta.symbol,
      name: meta.name,
      market: meta.market,
      signalKey: existing?.signalKey ?? candidate?.key ?? null,
      side: e.side,
      date: e.date,
      price: e.price,
      shares: e.shares,
      fee: e.fee,
      note: String(e.note ?? "").slice(0, 300),
      order: existing?.order ?? Math.max(-1, ...doc.executions.map((x) => x.order)) + 1,
    };
    doc.executions = doc.executions.filter((x) => x.id !== event.id);
    doc.executions.push(event);
    if (event.signalKey) delete doc.excluded[event.signalKey];
    changed = true;
  }
  if (input.action === "remove") {
    if (!doc.executions.some((e) => e.id === input.executionId))
      throw new Error("체결 기록을 찾지 못했습니다.");
    doc.executions = doc.executions.filter((e) => e.id !== input.executionId);
    changed = true;
  }
  if (input.action === "exclude") {
    const key = input.signalKey;
    const existing = doc.executions.find((e) => e.id === input.executionId);
    if (input.executionId && (!existing || existing.side !== "BUY" || existing.signalKey !== key))
      throw new Error("미매수로 변경할 매수 기록을 확인하세요.");
    if (!key || (!existing && !doc.strategy?.candidates.some((c) => c.key === key)))
      throw new Error("Onset 신호를 확인하세요.");
    if (existing) doc.executions = doc.executions.filter((e) => e.id !== existing.id);
    if (doc.executions.some((e) => e.signalKey === key))
      throw new Error("실제 체결 기록이 있습니다. 체결 내역에서 수정하세요.");
    doc.excluded[key] = String(input.note ?? "미매수 · 0주").slice(0, 300);
    changed = true;
  }
  if (input.action === "sync" || input.action === "capital" || !doc.strategy)
    changed = (await refreshStrategy(client, uid, doc)) || changed;
  const actual = calculateActual(
    doc.actualCapital,
    doc.executions,
    doc.strategy?.quotes ?? {},
    doc.strategy?.summary.latestDate ?? null,
  );
  if (changed) {
    const { data, error } = await client
      .from(TABLE)
      .update({ payload: doc, revision: row.revision + 1, updated_at: new Date().toISOString() })
      .eq("user_id", uid)
      .eq("revision", row.revision)
      .select("revision")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("동시에 원장이 변경됐습니다. 새로고침 후 다시 시도하세요.");
    return { revision: row.revision + 1, document: doc, actual };
  }
  return { revision: row.revision, document: doc, actual };
}
