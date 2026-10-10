import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";
import { canonicalJson } from "./ledger/migration";
import { decimal, representedLegacyNumber } from "./ledger/decimal";
import { rejectExecutionMemoUrls, savedExecutionMemo } from "./ledger/executionMemo";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import { loadNewActualDomesticQuotes } from "./portfolioLedgers.server";
import { quotesFor } from "./usActualLedger.server";
import type { Quote } from "./portfolioLedgers";
import {
  emptyNewActualMetadata,
  hasMixedActualProvenance,
  newActualAsset,
  projectNewActualPool,
  type NewActualMetadata,
  type NewActualExecution,
  type NewActualCurrency,
  type NewActualPool,
  type NewActualAudit,
} from "./newActualPortfolio";
import {
  parseNewActualPortfolioRequest,
  type NewActualPortfolioWrite,
} from "./newActualPortfolioInput";

export type NewActualDocument = {
  executions: NewActualExecution[];
  newActualPortfolio?: NewActualMetadata;
  [key: string]: unknown;
};
type Row = { revision: number; payload: NewActualDocument };
export interface NewActualPortfolioResponse {
  domesticRevision: number | null;
  usRevision: number | null;
  pools: { KRW: NewActualPool; USD: NewActualPool };
  warnings: string[];
}
const tableFor = (currency: NewActualCurrency) =>
  currency === "USD" ? ("us_actual_portfolio_ledgers" as const) : ("portfolio_ledgers" as const);
const localDay = (currency: NewActualCurrency, now: string) =>
  new Date(now).toLocaleDateString("en-CA", {
    timeZone: currency === "USD" ? "America/New_York" : "Asia/Seoul",
  });
function currencyFor(input: NewActualPortfolioWrite): NewActualCurrency {
  return "currency" in input ? input.currency : input.asset === "US" ? "USD" : "KRW";
}
function validateDate(date: string, currency: NewActualCurrency, now: string) {
  if (date < ACTUAL_PERFORMANCE_START || date > localDay(currency, now))
    throw new Error(
      "2026-10-12 이후 실제 발생한 현지 날짜만 입력하세요. 기존 거래와 미래 체결은 새 구간에 넣지 않습니다.",
    );
}
function project(
  row: Row | null,
  currency: NewActualCurrency,
  quotes: Record<string, Quote>,
  now: string,
) {
  const today = localDay(currency, now);
  return projectNewActualPool({
    currency,
    executions: row?.payload.executions ?? [],
    metadata: row?.payload.newActualPortfolio ?? null,
    quotes,
    // Without a verified exchange-session calendar we cannot promote old marks to current.
    // Recording remains available on every day; only today's valuation waits for dated inputs.
    valuationDate: today,
    today,
  });
}

/** Canonical owner-scoped reads only; no initialization, backfill, MODEL replay, or hidden writes. */
export async function loadNewActualPortfolio(
  client: SupabaseClient,
  uid: string,
  now = new Date().toISOString(),
): Promise<NewActualPortfolioResponse> {
  const [domestic, us] = await Promise.all([
    readWebsiteDocument<NewActualDocument>(client, uid, "portfolio_ledgers"),
    readWebsiteDocument<NewActualDocument>(client, uid, "us_actual_portfolio_ledgers"),
  ]);
  const warnings: string[] = [];
  async function marks(row: Row | null, currency: NewActualCurrency) {
    // Validate identities and new-only positions before requesting any price inputs.
    const initial = project(row, currency, {}, now);
    const symbols = new Set(initial.positions.map((p) => p.symbol));
    if (!symbols.size) return {};
    let raw: Record<string, Quote> = {};
    try {
      raw =
        currency === "USD"
          ? await quotesFor(client, uid, symbols)
          : await loadNewActualDomesticQuotes(
              client,
              uid,
              symbols,
              ACTUAL_PERFORMANCE_START,
              localDay(currency, now),
            );
    } catch {
      warnings.push(
        currency === "USD"
          ? "미국 평가가격을 읽지 못했습니다. 체결·보유 기록은 유지하며 평가는 미확정입니다."
          : "한국·ETF 평가가격을 읽지 못했습니다. 체결·보유 기록은 유지하며 평가는 미확정입니다.",
      );
    }
    return Object.fromEntries(
      initial.positions.flatMap((p) =>
        raw[p.symbol] ? [[`${p.market}:${p.symbol}`, raw[p.symbol]!]] : [],
      ),
    );
  }
  const [krQuotes, usQuotes] = await Promise.all([marks(domestic, "KRW"), marks(us, "USD")]);
  if (!domestic)
    warnings.push(
      "한국·ETF 원장이 아직 초기화되지 않았습니다. 기존 원장 준비 후 기록할 수 있습니다.",
    );
  if (!us)
    warnings.push("미국 원장이 아직 초기화되지 않았습니다. 기존 원장 준비 후 기록할 수 있습니다.");
  return {
    domesticRevision: domestic?.revision ?? null,
    usRevision: us?.revision ?? null,
    pools: { KRW: project(domestic, "KRW", krQuotes, now), USD: project(us, "USD", usQuotes, now) },
    warnings,
  };
}

/** Same document CAS atomically appends the raw canonical fill and its explicit new-slice assignment. */
export async function saveNewActualPortfolio(
  client: SupabaseClient,
  uid: string,
  rawInput: NewActualPortfolioWrite,
  now = new Date().toISOString(),
) {
  const input = parseNewActualPortfolioRequest(rawInput);
  if (input.action === "load") throw new Error("체결 또는 입출금 작업을 확인하세요.");
  if (!Number.isFinite(Date.parse(now))) throw new Error("기록 시각을 확인하세요.");
  const currency = currencyFor(input),
    table = tableFor(currency);
  const row = await readWebsiteDocument<NewActualDocument>(client, uid, table);
  if (!row)
    throw new Error(
      "기존 원장 준비 후 신규 기록을 시작해 주세요. 임의 초기자금은 만들지 않습니다.",
    );
  const previous = row.payload.newActualPortfolio ?? emptyNewActualMetadata();
  const { accessToken: _token, expectedRevision: _revision, ...fingerprintInput } = input;
  const fingerprint = createHash("sha256").update(canonicalJson(fingerprintInput)).digest("hex");
  const priorRequest = previous.audit.find((a) => a.requestId === input.requestId);
  if (priorRequest) {
    if (priorRequest.fingerprint !== fingerprint)
      throw new Error(
        "같은 저장 식별자에 다른 내용이 사용됐습니다. 새로고침 후 입력을 다시 여세요.",
      );
    // Exactly-once request acknowledgement, even after a lost response or later unrelated changes.
    return { revision: row.revision, reused: true };
  }
  if (row.revision !== input.expectedRevision)
    throw new Error("원장 버전이 변경됐습니다. 새로고침 후 입력을 닫고 다시 열어 주세요.");
  const doc = structuredClone(row.payload),
    metadata = structuredClone(previous);
  doc.newActualPortfolio = metadata;
  const audit: NewActualAudit = {
    requestId: input.requestId,
    fingerprint,
    action: input.action,
    recordedAt: new Date(now).toISOString(),
    targetId: "",
  };
  if (input.action === "execution") {
    const proposed = input.execution;
    if (newActualAsset(proposed.market) !== input.asset)
      throw new Error("종목 시장과 선택한 자산군이 다릅니다.");
    validateDate(proposed.date, currency, now);
    rejectExecutionMemoUrls(proposed.note);
    const existing = proposed.id ? doc.executions.find((e) => e.id === proposed.id) : undefined;
    if (proposed.id && (!existing || !metadata.assignments[proposed.id]))
      throw new Error("기존 보유·거래를 신규 성과로 이동할 수 없습니다.");
    if (existing && (existing.symbol !== proposed.symbol || existing.market !== proposed.market))
      throw new Error(
        "정정 중 종목·시장은 바꿀 수 없습니다. 잘못된 신규 체결을 취소한 뒤 다시 입력하세요.",
      );
    if (existing && hasMixedActualProvenance(metadata, existing)) {
      for (const field of ["side", "date", "price", "shares", "fee"] as const) {
        if (existing[field] !== proposed[field])
          throw new Error(
            "혼합 체결의 원본 수량·금액·비용·날짜·구분은 여기서 변경할 수 없습니다. 원본은 보존하며 신규 배정분만 정정하세요.",
          );
      }
    }
    const id = existing?.id ?? `new-actual:${input.requestId}`;
    if (!existing && doc.executions.some((e) => e.id === id))
      throw new Error("이미 사용한 체결 식별자입니다.");
    // Never inherit a pre-start signal/order from the MODEL or historical account.
    const event: NewActualExecution = {
      ...proposed,
      id,
      signalKey: existing?.signalKey ?? null,
      order: existing?.order ?? Math.max(-1, ...doc.executions.map((e) => e.order)) + 1,
      ...savedExecutionMemo(proposed, existing),
    };
    audit.targetId = id;
    if (existing) audit.before = { execution: existing, assignment: metadata.assignments[id]! };
    const assignment = { ...input.allocation, executionId: id };
    audit.after = { execution: event, assignment };
    doc.executions = [...doc.executions.filter((e) => e.id !== id), event];
    metadata.assignments[id] = assignment;
  } else if (input.action === "cancelExecution") {
    const existing = doc.executions.find((e) => e.id === input.executionId),
      assignment = metadata.assignments[input.executionId];
    if (!existing || !assignment || newActualAsset(existing.market) !== input.asset)
      throw new Error("취소할 신규 체결을 찾지 못했습니다.");
    // A mixed raw fill also represents legacy holdings: new UI cannot erase that legacy component.
    if (
      hasMixedActualProvenance(metadata, existing) ||
      assignment.quantity !== existing.shares ||
      decimal(representedLegacyNumber(assignment.gross)) !==
        decimal(representedLegacyNumber(existing.price * existing.shares)) ||
      assignment.fee !== existing.fee
    )
      throw new Error(
        "기존·신규 혼합 체결 원본은 여기서 전체 취소할 수 없습니다. 신규 배정과 원본을 대조한 정정이 필요합니다.",
      );
    audit.targetId = existing.id;
    audit.reason = input.reason;
    audit.before = { execution: existing, assignment };
    doc.executions = doc.executions.filter((e) => e.id !== existing.id);
    delete metadata.assignments[existing.id];
  } else if (input.action === "cash") {
    validateDate(input.event.date, currency, now);
    const existing = input.event.id
      ? metadata.cashEvents.find((e) => e.id === input.event.id)
      : undefined;
    if (input.event.id && (!existing || existing.voided))
      throw new Error("정정할 신규 현금 기록을 찾지 못했습니다.");
    const event = { ...input.event, id: existing?.id ?? `new-cash:${input.requestId}` };
    audit.targetId = event.id;
    if (existing) audit.before = { cashEvent: existing };
    audit.after = { cashEvent: event };
    metadata.cashEvents = [...metadata.cashEvents.filter((e) => e.id !== event.id), event];
  } else {
    const existing = metadata.cashEvents.find((e) => e.id === input.eventId);
    if (!existing || existing.voided) throw new Error("취소할 신규 현금 기록을 찾지 못했습니다.");
    const event = { ...existing, voided: true };
    audit.targetId = event.id;
    audit.reason = input.reason;
    audit.before = { cashEvent: existing };
    audit.after = { cashEvent: event };
    metadata.cashEvents = metadata.cashEvents.map((e) => (e.id === event.id ? event : e));
  }
  metadata.audit.push(audit);
  // Reject over-sales, missing original fills, duplicate references and invalid allocations.
  // Funding/price gaps only produce pending/incomplete output; they never discard actual fills.
  project({ revision: row.revision, payload: doc }, currency, {}, now);
  const result = await client
    .from(table)
    .update({ payload: doc, revision: row.revision + 1, updated_at: new Date(now).toISOString() })
    .eq("user_id", uid)
    .eq("revision", row.revision)
    .select("revision")
    .maybeSingle();
  if (result.error)
    throw new Error("신규 기록 저장을 확인하지 못했습니다. 새로고침 후 체결·입출금을 대조하세요.");
  if (!result.data)
    throw new Error(
      "동시에 원장이 변경됐습니다. 덮어쓰지 않았습니다. 새로고침 후 다시 확인하세요.",
    );
  const checked = await readWebsiteDocument<NewActualDocument>(client, uid, table);
  if (
    !checked ||
    checked.revision !== row.revision + 1 ||
    canonicalJson(checked.payload) !== canonicalJson(doc)
  )
    throw new Error(
      "저장 응답 후 원장 확인이 완료되지 않았습니다. 재입력하지 말고 새로고침 후 대조하세요.",
    );
  return { revision: checked.revision, reused: false };
}
