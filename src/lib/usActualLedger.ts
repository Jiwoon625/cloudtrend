import { savedExecutionMemo } from "./ledger/executionMemo";
import {
  calculateActual,
  keyFor,
  type ActualExecution,
  type ActualLedger,
  type Quote,
} from "./portfolioLedgers";
import type { UsPortfolioTradeRecord } from "./usProspectiveCloud";

export type UsExecution = ActualExecution<"US">;
export interface UsCandidate {
  key: string;
  symbol: string;
  name: string;
  date: string;
}
export interface UsActualDocument {
  /** Optional verified reporting projection. No inference from execution-date/USD P&L. */
  taxEvidence?: import("./usTaxOverlay").ActualTaxEvidence;
  capital: number;
  executions: UsExecution[];
  excluded: Record<string, string>;
  excludedSourceLinks?: Record<string, import("./ledger/executionMemo").ExecutionSourceLink[]>;
  migratedAt: string;
}
export interface UsActualState {
  revision: number;
  document: UsActualDocument;
  actual: ActualLedger<"US">;
  candidates: UsCandidate[];
  quotes: Record<string, Quote>;
}
export interface UsActualRequest {
  action: "load" | "capital" | "execution" | "remove" | "exclude";
  revision?: number | undefined;
  capital?: number | undefined;
  execution?: UsExecution | undefined;
  executionId?: string | undefined;
  signalKey?: string | undefined;
  note?: string | undefined;
  sourceLinks?: import("./ledger/executionMemo").ExecutionSourceLink[] | undefined;
}
export function migrateUsActual(trades: UsPortfolioTradeRecord[]): UsActualDocument {
  const doc: UsActualDocument = {
    capital: 100000,
    executions: [],
    excluded: {},
    migratedAt: new Date().toISOString(),
  };
  for (const t of [...trades].sort(
    (a, b) =>
      (a.execution_date ?? "").localeCompare(b.execution_date ?? "") ||
      a.trade_key.localeCompare(b.trade_key),
  )) {
    if (t.strategy_id !== "A0_QUARTER_PRIMARY" || t.actual_shares === null) continue;
    const key = keyFor(t.symbol, t.signal_date);
    if (t.actual_shares === 0) {
      if (t.side.endsWith("BUY")) doc.excluded[key] = "기존 미매수 · 0주";
      continue;
    }
    if (!t.actual_price || !t.execution_date)
      throw new Error(`${t.symbol}: 기존 실제 체결의 가격·날짜를 확인하세요.`);
    doc.executions.push({
      id: `legacy-${t.trade_key}`,
      symbol: t.symbol,
      name: t.name ?? t.symbol,
      market: "US",
      signalKey: key,
      side: t.side.endsWith("BUY") ? "BUY" : "SELL",
      date: t.execution_date,
      shares: t.actual_shares,
      price: t.actual_price,
      fee: t.actual_fee_usd ?? 0,
      order: doc.executions.length,
      note: "",
    });
  }
  calculateActual(doc.capital, doc.executions, {}, null);
  return doc;
}
export function changeUsActual(
  doc: UsActualDocument,
  input: UsActualRequest,
  candidates: UsCandidate[],
  today: string,
) {
  if (input.action === "capital") {
    if (!Number.isFinite(input.capital) || input.capital! <= 0 || input.capital! > 1e15)
      throw new Error("실제 운용자금을 확인하세요.");
    doc.capital = input.capital!;
  }
  if (input.action === "execution") {
    const e = input.execution;
    if (!e) throw new Error("체결 정보를 입력하세요.");
    const existing = doc.executions.find((x) => x.id === e.id);
    if (e.id && !existing) throw new Error("수정할 체결을 찾지 못했습니다.");
    const candidate = candidates.find((c) => c.key === e.signalKey);
    const previous = doc.executions.find((x) => x.symbol === e.symbol);
    const meta = existing ?? candidate ?? previous;
    if (!meta || meta.symbol !== e.symbol)
      throw new Error("A0 신호 또는 실제 보유 종목을 선택하세요.");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
      !Number.isFinite(Date.parse(e.date)) ||
      new Date(e.date).toISOString().slice(0, 10) !== e.date ||
      e.date > today
    )
      throw new Error("미국 현지 체결일을 확인하세요. 미래 날짜는 입력할 수 없습니다.");
    if (candidate && e.date < candidate.date)
      throw new Error("신호일 이전 체결은 해당 신호에 연결할 수 없습니다.");
    const event: UsExecution = {
      ...e,
      id: existing?.id ?? crypto.randomUUID(),
      name: meta.name,
      market: "US",
      signalKey: existing?.signalKey ?? candidate?.key ?? null,
      order: existing?.order ?? Math.max(-1, ...doc.executions.map((x) => x.order)) + 1,
      ...savedExecutionMemo({ ...e, note: e.note.slice(0, 300) }, existing),
    };
    doc.executions = doc.executions.filter((x) => x.id !== event.id);
    doc.executions.push(event);
    if (event.signalKey) delete doc.excluded[event.signalKey];
  }
  if (input.action === "remove") {
    if (!doc.executions.some((e) => e.id === input.executionId))
      throw new Error("체결 기록을 찾지 못했습니다.");
    doc.executions = doc.executions.filter((e) => e.id !== input.executionId);
  }
  if (input.action === "exclude") {
    const key = input.signalKey;
    const existing = doc.executions.find((e) => e.id === input.executionId);
    if (input.executionId && (!existing || existing.side !== "BUY" || existing.signalKey !== key))
      throw new Error("미매수로 변경할 매수 기록을 확인하세요.");
    if (!key || (!existing && !candidates.some((c) => c.key === key)))
      throw new Error("A0 신호를 확인하세요.");
    if (doc.executions.some((e) => e.signalKey === key && e.id !== existing?.id))
      throw new Error("해당 신호의 다른 체결 기록이 있습니다. 체결 내역에서 수정하세요.");
    const memo = savedExecutionMemo(
      { note: input.note?.slice(0, 300) || "미매수 · 0주", sourceLinks: input.sourceLinks },
      existing ?? { note: doc.excluded[key] ?? "", sourceLinks: doc.excludedSourceLinks?.[key] },
    );
    if (existing) doc.executions = doc.executions.filter((e) => e.id !== existing.id);
    doc.excluded[key] = memo.note;
    if (memo.sourceLinks?.length) {
      doc.excludedSourceLinks = { ...doc.excludedSourceLinks, [key]: memo.sourceLinks };
    }
  }
  calculateActual(doc.capital, doc.executions, {}, null);
}
