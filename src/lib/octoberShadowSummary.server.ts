import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ADOPTED_SERIES_KINDS,
  ADOPTED_SERIES_VERSION,
  RESTART_SERIES_VERSION,
  activeSeriesVersion,
  MODEL_ACCOUNTING_START,
  firstModelSession,
  guardModelRun,
  hashSeriesValue,
  isAdoptedUsSeriesKind,
  verifyFrozenSeries,
  type AdoptedSeriesKind,
  type AdoptedUsRun,
  type FrozenModelSeries,
} from "./ledger/modelSeries";
import type { OctoberRun } from "./ledger/octoberShadowPipeline";
import type { AdoptedKrRun } from "./ledger/krAdoptedShadow";
import type { AdoptedEtfRun } from "./ledger/etfAdoptedShadow";
import type { AdoptedKospiShadowRun } from "./ledger/kospiAdoptedShadow";
import { octoberShadowTax } from "./ledger/octoberShadowTax";
import type { UsTaxOverlayResult } from "./engine/usCapitalGainsTax";

export interface OctoberShadowBookSummary {
  history?: Array<{ date: string; nav: number | null; benchmark: number | null }>;
  trades?: Array<{
    date: string;
    symbol: string;
    side: string;
    quantity: string;
    price: string;
    reason: string;
  }>;
  mddPercent?: number | null;
  bookId: string;
  kind: AdoptedSeriesKind;
  role: "ADOPTED_SHADOW" | "ALTERNATIVE_SHADOW";
  currency: "KRW" | "USD";
  status: "NOT_INITIALIZED" | "INITIALIZED_WAITING" | "RECORDED" | "UNAVAILABLE";
  scheduledStart: string;
  frozenAt: string | null;
  firstSessionDate: string | null;
  latestSessionDate: string | null;
  initialCapital: string | null;
  residualKrw: string | null;
  cash: string | null;
  nav: string | null;
  positions: number | null;
  pending: number | null;
  holdings: Array<{
    symbol: string;
    name: string;
    quantity: string;
    price: string | null;
    value: string | null;
    entryDate: string;
  }>;
  returnPercent: number | null;
  valuationStatus: string | null;
  tax: UsTaxOverlayResult | null;
  warnings: string[];
}
export interface ShadowReplayStatusSummary {
  market: "KR" | "US";
  signalDate: string;
  calculatedAt: string;
  sourceCapturedAt: string | null;
  modelDecisionAt: string | null;
  executionAt: string | null;
  replayMode: "CONTEMPORANEOUS" | "RETROSPECTIVE";
  status: "RECORDED" | "REUSED" | "WAITING_INPUT" | "FAILED";
  reason: string | null;
}
export interface OctoberShadowSummary {
  version: string;
  checkedAt: string;
  viewVersion: "october-shadow-holdings-tax-v2";
  readyForPortfolioConsolidation: boolean;
  replayStatus: ShadowReplayStatusSummary[];
  books: OctoberShadowBookSummary[];
}
export interface OctoberRegistryRow {
  series_id: string;
  strategy_id: string;
  role: string;
  scheduled_start: string;
  config_hash: string;
  payload: FrozenModelSeries;
}
export interface OctoberSessionRow {
  series_id: string;
  session_date: string;
  previous_session_date: string | null;
  state_hash: string;
  payload: OctoberRun;
}
const roleFor = (kind: AdoptedSeriesKind) =>
  ["US_A2", "US_B3", "KR_KOSPI_CONFIRM1_BEAR"].includes(kind)
    ? ("ALTERNATIVE_SHADOW" as const)
    : ("ADOPTED_SHADOW" as const);
const empty = (
  kind: AdoptedSeriesKind,
  version: string = ADOPTED_SERIES_VERSION,
): OctoberShadowBookSummary => ({
  bookId: `${version}:${kind}`,
  kind,
  role: roleFor(kind),
  currency: isAdoptedUsSeriesKind(kind) ? "USD" : "KRW",
  status: "NOT_INITIALIZED",
  scheduledStart: version === RESTART_SERIES_VERSION ? "2026-10-12" : MODEL_ACCOUNTING_START,
  frozenAt: null,
  firstSessionDate: null,
  latestSessionDate: null,
  initialCapital: null,
  residualKrw: null,
  cash: null,
  nav: null,
  positions: null,
  pending: null,
  holdings: [],
  returnPercent: null,
  valuationStatus: null,
  tax: null,
  warnings: [],
});
const money = (value: unknown): string | null =>
  (typeof value === "number" || typeof value === "string") &&
  value !== "" &&
  Number.isFinite(Number(value))
    ? String(value)
    : null;

async function verifySession(series: FrozenModelSeries, row: OctoberSessionRow, checkedAt: string) {
  const run = row.payload;
  await guardModelRun(series, run.receipt, run.receipt);
  const { stateHash, ...body } = run;
  if (
    row.series_id !== series.bookId ||
    run.book !== "MODEL" ||
    run.bookId !== series.bookId ||
    run.contractHash !== series.contractHash ||
    row.session_date !== run.receipt.date ||
    row.state_hash !== stateHash ||
    stateHash !== (await hashSeriesValue(body)) ||
    !run.calendar.regularSessions.includes(row.session_date) ||
    run.publication?.version !== "october-manual-publication-v1" ||
    !Number.isFinite(Date.parse(run.publication.availableAt)) ||
    !Number.isFinite(Date.parse(run.publication.decisionAt)) ||
    Date.parse(run.publication.availableAt) > Date.parse(run.publication.decisionAt) ||
    Date.parse(run.publication.decisionAt) > Date.parse(checkedAt)
  )
    throw new Error("신규 Shadow 세션 해시·정규장 발행 증거 확인 필요");
}

/** Projection only. Registry initialization is never fabricated into a session. */
export async function summarizeOctoberShadowBook(
  kind: AdoptedSeriesKind,
  registry: OctoberRegistryRow | null,
  rows: OctoberSessionRow[],
  historyComplete: boolean,
  checkedAt: string,
): Promise<OctoberShadowBookSummary> {
  const output = empty(kind, registry?.payload.version);
  if (!registry) return output;
  try {
    const series = registry.payload;
    await verifyFrozenSeries(series);
    if (
      registry.series_id !== output.bookId ||
      series.bookId !== output.bookId ||
      registry.strategy_id !== kind ||
      registry.role !== output.role ||
      registry.scheduled_start !== series.accountingStartDate ||
      registry.config_hash !== series.configHash ||
      series.policy.currency !== output.currency ||
      (output.currency === "USD") !== Boolean(series.fx)
    )
      throw new Error("신규 Shadow 동결 등록정보 불일치");
    output.frozenAt = series.frozenAt;
    output.initialCapital = series.fx?.usdCash ?? series.initialKrw;
    output.residualKrw = series.fx?.residualKrw ?? null;
    if (!rows.length) {
      if (!historyComplete) throw new Error("세션 조회 범위 확인 필요");
      output.status = "INITIALIZED_WAITING";
      output.cash = output.initialCapital;
      output.positions = 0;
      output.pending = 0;
      // Initial cash is not a market-valued NAV or the first real session.
      if (isAdoptedUsSeriesKind(kind))
        output.tax = await octoberShadowTax({
          series,
          runs: [],
          historyComplete: true,
          asOf: checkedAt.slice(0, 10),
          preTaxNavUsd: null,
        });
      return output;
    }
    const first = rows[0]!,
      latest = rows.at(-1)!;
    await verifySession(series, first, checkedAt);
    if (latest !== first) await verifySession(series, latest, checkedAt);
    if (
      first.previous_session_date !== null ||
      first.payload.previousStateHash !== null ||
      first.session_date !== firstModelSession(series, first.payload.calendar) ||
      rows.some((row, i) => i > 0 && row.session_date <= rows[i - 1]!.session_date)
    )
      throw new Error("최초 신규 Shadow 세션 또는 일자 정렬 확인 필요");
    if (historyComplete) {
      for (let i = 1; i < rows.length; i++) {
        if (
          rows[i]!.previous_session_date !== rows[i - 1]!.session_date ||
          rows[i]!.payload.previousStateHash !== rows[i - 1]!.state_hash
        )
          throw new Error("신규 Shadow 세션 연결 누락");
      }
    }
    output.status = "RECORDED";
    output.firstSessionDate = first.session_date;
    output.latestSessionDate = latest.session_date;
    if (isAdoptedUsSeriesKind(kind)) {
      const run = latest.payload as AdoptedUsRun;
      output.cash = money(run.result.state.modelCashExact ?? run.result.cash);
      output.nav = money(run.result.nav);
      output.positions = Object.keys(run.result.state.positions).length;
      output.holdings = Object.values(run.result.state.positions).map((p) => ({
        symbol: p.symbol,
        name: p.name,
        quantity: String(p.shares),
        price: money(p.lastPrice),
        value: money(p.shares * p.lastPrice),
        entryDate: p.entryDate,
      }));
      output.pending =
        Object.keys(run.result.state.pendingTargets).length +
        Object.keys(run.result.state.pendingExits).length;
      output.tax = await octoberShadowTax({
        series,
        runs: rows.map((row) => row.payload as AdoptedUsRun),
        historyComplete,
        asOf: latest.session_date,
        preTaxNavUsd: output.nav === null ? null : Number(output.nav),
      });
    } else if (kind === "ETF_V02") {
      const state = (latest.payload as AdoptedEtfRun).result.state;
      output.cash = money(state.cash);
      output.nav = money(state.valuation.nav);
      output.valuationStatus = state.valuation.status;
      output.positions = state.positions.length;
      output.holdings = state.positions.map((p) => ({
        symbol: p.symbol,
        name: p.symbol,
        quantity: p.quantity,
        price: p.mark?.price ?? null,
        value: p.mark ? money(Number(p.quantity) * Number(p.mark.price)) : null,
        entryDate: p.entryDate,
      }));
      output.pending =
        state.pendingConfirmations.length + state.pendingEntries.length + state.pendingExits.length;
    } else if (kind === "KR_KOSPI_CONFIRM1_BEAR") {
      const { state, daily } = (latest.payload as AdoptedKospiShadowRun).result;
      output.cash = money(state.modelCashExact ?? state.cashKrw);
      output.nav = money(daily.navKrw);
      output.valuationStatus = daily.staleMarks.length ? "STALE" : "COMPLETE";
      output.positions = Object.keys(state.positions).length;
      output.holdings = Object.values(state.positions).map((p) => ({
        symbol: p.symbol,
        name: p.name,
        quantity: String(p.shares),
        price: money(p.lastPrice),
        value: money(p.shares * p.lastPrice),
        entryDate: p.entryDate,
      }));
      output.pending =
        state.awaiting.length +
        state.pendingEntries.length +
        Object.keys(state.pendingExits).length;
    } else {
      const result = (latest.payload as AdoptedKrRun).result;
      output.cash = money(result.modelAccounting?.cash);
      output.nav = money(result.modelAccounting?.nav);
      output.valuationStatus = result.modelAccounting?.valuationStatus ?? "MISSING";
      output.positions = result.summary.openPositions;
      output.holdings = result.trades
        .filter((p) => p.status === "OPEN")
        .map((p) => ({
          symbol: p.symbol,
          name: p.name,
          quantity: String(p.shares),
          price: money(p.currentPrice),
          value: p.currentPrice === null ? null : money(p.shares * p.currentPrice),
          entryDate: p.entryDate,
        }));
      // KR replay candidates are not a persisted pending-order queue.
      output.pending = null;
    }
    if (historyComplete) {
      output.history = [];
      output.trades = [];
      const seen = new Set<string>();
      for (const row of rows) {
        await verifySession(series, row, checkedAt);
        let nav: number | null = null,
          benchmark: number | null = null;
        if (isAdoptedUsSeriesKind(kind)) {
          const r = (row.payload as AdoptedUsRun).result;
          nav = r.nav;
          benchmark = r.benchmarkNav;
          for (const t of r.trades)
            if (t.executionDate && t.modelShares && t.modelPrice && t.status !== "PENDING")
              output.trades.push({
                date: t.executionDate,
                symbol: t.symbol,
                side: t.side,
                quantity: String(t.modelShares),
                price: String(t.modelPrice),
                reason: t.reason,
              });
        } else if (kind === "ETF_V02") {
          const r = (row.payload as AdoptedEtfRun).result;
          nav = r.state.valuation.nav === null ? null : Number(r.state.valuation.nav);
          for (const t of r.record.fills)
            output.trades.push({
              date: t.executionDate,
              symbol: t.symbol,
              side: t.side,
              quantity: t.quantity,
              price: t.price,
              reason: t.reason,
            });
        } else if (kind === "KR_KOSPI_CONFIRM1_BEAR") {
          const r = (row.payload as AdoptedKospiShadowRun).result;
          nav = r.daily.navKrw;
          benchmark = r.daily.benchmarkNavKrw;
          for (const t of r.trades)
            output.trades.push({
              date: t.executionDate,
              symbol: t.symbol,
              side: t.side,
              quantity: String(t.shares),
              price: String(t.price),
              reason: t.reason,
            });
        } else {
          const r = (row.payload as AdoptedKrRun).result;
          nav = r.modelAccounting?.nav === undefined ? null : Number(r.modelAccounting.nav);
          for (const t of r.trades) {
            if (!seen.has(t.id + ":BUY")) {
              output.trades.push({
                date: t.entryDate,
                symbol: t.symbol,
                side: "BUY",
                quantity: String(t.shares),
                price: String(t.entryPrice),
                reason: t.entryStatus,
              });
              seen.add(t.id + ":BUY");
            }
            if (t.exitDate && t.exitPrice && !seen.has(t.id + ":SELL")) {
              output.trades.push({
                date: t.exitDate,
                symbol: t.symbol,
                side: "SELL",
                quantity: String(t.shares),
                price: String(t.exitPrice),
                reason: t.exitReason ?? "",
              });
              seen.add(t.id + ":SELL");
            }
          }
        }
        output.history.push({ date: row.session_date, nav, benchmark });
      }
      let peak = Number(output.initialCapital),
        mdd = 0;
      for (const day of output.history)
        if (day.nav !== null) {
          peak = Math.max(peak, day.nav);
          mdd = Math.min(mdd, day.nav / peak - 1);
        }
      output.mddPercent = output.history.some((day) => day.nav === null) ? null : mdd * 100;
    }
    output.returnPercent =
      output.nav !== null && output.initialCapital !== null && Number(output.initialCapital) > 0
        ? (Number(output.nav) / Number(output.initialCapital) - 1) * 100
        : null;
    return output;
  } catch (error) {
    return {
      ...empty(kind, registry?.payload.version),
      status: "UNAVAILABLE",
      warnings: [error instanceof Error ? error.message : "신규 Shadow 확인 실패"],
    };
  }
}

/** Runtime readback gate. Code deployment alone must never hide the old reference model view. */
export function isOctoberShadowReady(books: OctoberShadowBookSummary[]) {
  return (
    books.length === ADOPTED_SERIES_KINDS.length &&
    ADOPTED_SERIES_KINDS.every((kind) => {
      const found = books.filter((book) => book.kind === kind);
      return (
        found.length === 1 &&
        ["INITIALIZED_WAITING", "RECORDED"].includes(found[0]!.status) &&
        found[0]!.initialCapital !== null &&
        Array.isArray(found[0]!.holdings) &&
        (!isAdoptedUsSeriesKind(kind) || found[0]!.tax !== null)
      );
    })
  );
}

const fields = "series_id,session_date,previous_session_date,state_hash,payload";
/** Owner SELECT only. US history pages to exhaustion; a cap/error never becomes zero tax. */
export async function loadOctoberShadowSummaryForOwner(
  client: SupabaseClient,
  uid: string,
  requestedVersion?: string,
  detailKind?: AdoptedSeriesKind,
): Promise<OctoberShadowSummary> {
  if (!/^[a-f\d-]{36}$/i.test(uid)) throw new Error("로그인 소유자 확인 필요");
  const checkedAt = new Date().toISOString();
  const version = requestedVersion ?? activeSeriesVersion(checkedAt.slice(0, 10));
  if (![ADOPTED_SERIES_VERSION, RESTART_SERIES_VERSION].includes(version))
    throw new Error("Unknown Shadow series version");
  const ids = ADOPTED_SERIES_KINDS.map((kind) => `${version}:${kind}`);
  const registry = await client
    .from("ledger_model_series")
    .select("series_id,strategy_id,role,scheduled_start,config_hash,payload")
    .eq("user_id", uid)
    .in("series_id", ids);
  if (registry.error) throw new Error(`신규 Shadow 등록정보 조회 실패: ${registry.error.message}`);
  const books = await Promise.all(
    ADOPTED_SERIES_KINDS.map(async (kind) => {
      const base = empty(kind, version);
      const matches = (registry.data ?? []).filter((row) => row.series_id === base.bookId);
      if (matches.length > 1)
        return { ...base, status: "UNAVAILABLE" as const, warnings: ["중복 신규 Shadow 등록정보"] };
      if (!matches[0]) return base;
      try {
        const rows: OctoberSessionRow[] = [];
        let historyComplete = true;
        if (isAdoptedUsSeriesKind(kind) || kind === detailKind) {
          for (let offset = 0; ; offset += 100) {
            if (offset >= 20000)
              throw new Error("전체 세션 검증 한도 초과: 부분 이력으로 세금 산출 불가");
            const page = await client
              .from("ledger_model_sessions")
              .select(fields)
              .eq("user_id", uid)
              .eq("series_id", base.bookId)
              .order("session_date")
              .range(offset, offset + 99);
            if (page.error)
              throw new Error(`신규 Shadow 전체 세션 조회 실패: ${page.error.message}`);
            rows.push(...((page.data ?? []) as unknown as OctoberSessionRow[]));
            if ((page.data?.length ?? 0) < 100) break;
          }
        } else {
          // KR replay payloads contain archived inputs; only read the two displayed endpoints.
          const endpoints = await Promise.all(
            [true, false].map((ascending) =>
              client
                .from("ledger_model_sessions")
                .select(fields)
                .eq("user_id", uid)
                .eq("series_id", base.bookId)
                .order("session_date", { ascending })
                .limit(1)
                .maybeSingle(),
            ),
          );
          for (const endpoint of endpoints) {
            if (endpoint.error)
              throw new Error(`신규 Shadow 세션 조회 실패: ${endpoint.error.message}`);
            const row = endpoint.data as unknown as OctoberSessionRow | null;
            if (row && !rows.some((saved) => saved.session_date === row.session_date))
              rows.push(row);
          }
          historyComplete = rows.length <= 1;
        }
        return await summarizeOctoberShadowBook(
          kind,
          matches[0] as unknown as OctoberRegistryRow,
          rows,
          historyComplete,
          checkedAt,
        );
      } catch (error) {
        return {
          ...base,
          status: "UNAVAILABLE" as const,
          warnings: [error instanceof Error ? error.message : "신규 Shadow 조회 실패"],
        };
      }
    }),
  );
  const replayQuery = await client
    .from("shadow_replay_audit")
    .select(
      "market,signal_date,calculated_at,source_captured_at,model_decision_at,execution_at,replay_mode,status,reason",
    )
    .eq("user_id", uid)
    .order("calculated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  const replayStatus: ShadowReplayStatusSummary[] = [];
  if (!replayQuery.error) {
    for (const market of ["KR", "US"] as const) {
      const row = (replayQuery.data ?? []).find((item) => item.market === market);
      if (!row) continue;
      replayStatus.push({
        market,
        signalDate: String(row.signal_date),
        calculatedAt: String(row.calculated_at),
        sourceCapturedAt: row.source_captured_at ? String(row.source_captured_at) : null,
        modelDecisionAt: row.model_decision_at ? String(row.model_decision_at) : null,
        executionAt: row.execution_at ? String(row.execution_at) : null,
        replayMode: row.replay_mode === "RETROSPECTIVE" ? "RETROSPECTIVE" : "CONTEMPORANEOUS",
        status:
          row.status === "WAITING_INPUT"
            ? "WAITING_INPUT"
            : row.status === "FAILED"
              ? "FAILED"
              : row.status === "REUSED"
                ? "REUSED"
                : "RECORDED",
        reason: row.reason ? String(row.reason) : null,
      });
    }
  }
  return {
    version,
    checkedAt,
    viewVersion: "october-shadow-holdings-tax-v2",
    readyForPortfolioConsolidation: isOctoberShadowReady(books),
    replayStatus,
    books,
  };
}

export async function loadOctoberShadowSummary(
  accessToken: string,
  version?: string,
  detailKind?: AdoptedSeriesKind,
) {
  const client = createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("로그인 세션을 확인해 주세요.");
  return loadOctoberShadowSummaryForOwner(client, data.user.id, version, detailKind);
}
