import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import { gunzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { downloadFreshObject } from "./freshStorage";
import { loadUsOrderPreview } from "./usOrderPreview.server";
import { calculateActual, type LedgerDocument, type Quote } from "./portfolioLedgers";
import type { UsActualDocument } from "./usActualLedger";
import type { AnalysisResult } from "./engine/pipeline";
import {
  DASHBOARD_CACHE_VERSION,
  SCREENING_CACHE_VERSION,
  type DashboardSummary,
} from "./screeningCacheContract";
import type { UsProspectiveCache } from "./usProspectiveCloud";
import {
  DASHBOARD_MARKETS,
  ETF_HOLDINGS_PATH,
  marketSignals,
  projectKrDashboard,
  projectUsDashboard,
  validateEtfHoldingSymbols,
  type DashboardIndex,
  type DashboardOperations,
} from "./dashboardOperations";

import { projectDashboardSectorContext } from "./dashboardOperationsSectorLimits";

const BUCKET = "cloudtrend-data";
const VERSION = "dashboard-operations-sector-codes-v5";
const memory = new Map<string, { expires: number; index: DashboardIndex }>();
const inFlight = new Map<string, Promise<DashboardIndex>>();

async function authenticate(accessToken: string) {
  if (accessToken.length < 20) throw new Error("먼저 로그인해 주세요.");
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
  return { client, uid: data.user.id };
}
async function readJson<T>(client: SupabaseClient, path: string, gzip = false): Promise<T | null> {
  const { data, error } = await downloadFreshObject(client, BUCKET, path);
  if (error) {
    if (String(error.statusCode) === "404" || /object not found/i.test(error.message)) return null;
    throw new Error(`저장된 결과 조회 실패: ${error.message}`);
  }
  if (!data) return null;
  return JSON.parse(
    gzip
      ? gunzipSync(new Uint8Array(await data.arrayBuffer())).toString("utf8")
      : await data.text(),
  ) as T;
}
async function writeJson(client: SupabaseClient, path: string, value: unknown) {
  const { error } = await client.storage.from(BUCKET).upload(
    path,
    new Blob([JSON.stringify(value)], {
      type: "application/json",
    }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) throw new Error(`저장 실패: ${error.message}`);
}

/** Full completed result is projected at most once per digest; never reads raw prices or runs an engine. */
export async function projection(client: SupabaseClient, uid: string, kind: "kr" | "us") {
  const meta =
    kind === "kr"
      ? await readJson<DashboardSummary>(client, `${uid}/cache/dashboard/latest.json`)
      : await readJson<UsProspectiveCache>(client, `${uid}/cache/us-screening/summary-v1.json`);
  if (!meta) return null;
  if (kind === "kr" && (meta as DashboardSummary).version !== DASHBOARD_CACHE_VERSION)
    throw new Error("KOSPI 하루·RS 확인 규칙으로 스크리닝을 다시 실행해 주세요.");
  const digest =
    kind === "kr"
      ? (meta as DashboardSummary).resultDigest
      : `${(meta as UsProspectiveCache).dataHash}:${(meta as UsProspectiveCache).generatedAt}`;
  const key = `${uid}:${kind}:${VERSION}:${digest}`;
  // Always use freshly read generation metadata, even for the same result digest.
  // Keep it out of the reusable projection so a same-day re-screen cannot reuse an old timestamp.
  const observed = (index: DashboardIndex): DashboardIndex =>
    kind === "kr" ? { ...index, screeningCreatedAt: (meta as DashboardSummary).createdAt } : index;
  const cached = memory.get(key);
  if (cached && cached.expires > Date.now()) return observed(cached.index);
  const pending = inFlight.get(key);
  if (pending) return observed(await pending);
  const promise = (async () => {
    const path = `${uid}/cache/dashboard-operations/${kind}-v1.json`;
    const sidecar = await readJson<{ key: string; index: DashboardIndex }>(client, path);
    if (sidecar?.key === key && Array.isArray(sidecar.index?.rows)) return sidecar.index;
    let index: DashboardIndex;
    if (kind === "kr") {
      const full = await readJson<{
        version: string;
        resultDigest: string;
        payload: { analysis: AnalysisResult };
      }>(client, `${uid}/cache/screening/latest.json`);
      if (
        !full?.payload?.analysis ||
        full.version !== SCREENING_CACHE_VERSION ||
        full.resultDigest !== digest
      ) {
        throw new Error("국내 스크리닝이 갱신 중입니다. 잠시 후 새로고침해 주세요.");
      }
      index = projectKrDashboard(full.payload.analysis);
    } else {
      const full =
        (await readJson<UsProspectiveCache>(
          client,
          `${uid}/cache/us-screening/view-v1.json.gz`,
          true,
        )) ?? (await readJson<UsProspectiveCache>(client, `${uid}/cache/us-screening/latest.json`));
      if (!full?.analysis?.rows || `${full.dataHash}:${full.generatedAt}` !== digest) {
        throw new Error("미국 스크리닝이 갱신 중입니다. 잠시 후 새로고침해 주세요.");
      }
      index = projectUsDashboard(full);
    }
    // A failed cache write must not turn a successfully read result into an empty signal set.
    await writeJson(client, path, { key, index }).catch(() => undefined);
    return index;
  })();
  inFlight.set(key, promise);
  try {
    const index = await promise;
    if (memory.size >= 8) memory.delete(memory.keys().next().value!);
    memory.set(key, { expires: Date.now() + 5 * 60_000, index });
    return observed(index);
  } finally {
    inFlight.delete(key);
  }
}
export async function portfolioEtfContext(client: SupabaseClient, uid: string) {
  const [index, tracked] = await Promise.all([
    projection(client, uid, "kr"),
    readJson<{ symbols: string[] }>(client, `${uid}/${ETF_HOLDINGS_PATH}`),
  ]);
  return {
    rows: index?.rows.filter((r) => r.market === "ETF") ?? [],
    trackedSymbols: tracked?.symbols ?? [],
    date: index?.date ?? null,
  };
}
async function documentFor<T extends LedgerDocument | UsActualDocument>(
  client: SupabaseClient,
  uid: string,
  table: "portfolio_ledgers" | "us_actual_portfolio_ledgers",
): Promise<T | null> {
  return (await readWebsiteDocument<T>(client, uid, table))?.payload ?? null;
}
function quotesFor(index: DashboardIndex | null): Record<string, Quote> {
  return Object.fromEntries(
    (index?.rows ?? [])
      .filter((r) => r.price !== null && r.price > 0)
      .map((r) => [r.symbol, { price: r.price!, date: r.date, exitSignal: r.exitReason }]),
  );
}

export async function loadDashboardOperations(accessToken: string): Promise<DashboardOperations> {
  const { client, uid } = await authenticate(accessToken);
  const warnings: string[] = [];
  async function safe<T>(label: string, load: () => Promise<T>): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : "조회 실패"}`);
      return null;
    }
  }
  const [kr, us, krDoc, usDoc, etfHoldings, usOrderPreview] = await Promise.all([
    safe("국내 신호", () => projection(client, uid, "kr")),
    safe("미국 신호", () => projection(client, uid, "us")),
    safe("국내 실제 보유", () => documentFor<LedgerDocument>(client, uid, "portfolio_ledgers")),
    safe("미국 실제 보유", () =>
      documentFor<UsActualDocument>(client, uid, "us_actual_portfolio_ledgers"),
    ),
    safe("ETF 보유", () =>
      readJson<NonNullable<DashboardOperations["etfHoldings"]>>(
        client,
        `${uid}/${ETF_HOLDINGS_PATH}`,
      ),
    ),
    safe("US 주문 미리보기", () => loadUsOrderPreview(client, uid, "A0_QUARTER_PRIMARY")),
  ]);
  if (kr?.rows.some((r) => r.market === "ETF" && r.etfEntry?.dataStatus === "krx_batch_pending")) {
    warnings.push(
      `ETF ${kr.date}: 최신 KRX 금액·기초지수 일괄 미수신. 신규 진입·청산 판단 대기, 다음 자료 수집 후 재확인 필요.`,
    );
  }
  const krActual = krDoc
    ? await safe("국내 실제 원장", async () =>
        calculateActual(
          krDoc.actualCapital,
          krDoc.executions.filter((e) => e.market !== "ETF"),
          quotesFor(kr),
          kr?.date ?? null,
        ),
      )
    : null;
  const usActual = usDoc
    ? await safe("미국 실제 원장", async () =>
        calculateActual(usDoc.capital, usDoc.executions, quotesFor(us), us?.date ?? null),
      )
    : null;
  const etfActual = krDoc
    ? await safe("ETF 실제 원장", async () =>
        calculateActual(
          krDoc.etfCapital ?? 10_000_000,
          krDoc.executions.filter((e) => e.market === "ETF"),
          quotesFor(kr),
          kr?.date ?? null,
        ),
      )
    : null;
  const etf = etfHoldings
    ? await safe("ETF 보유정보 검증", async () =>
        validateEtfHoldingSymbols(etfHoldings.symbols).map((symbol) => ({
          symbol,
          name: symbol,
          shares: 1,
          firstEntryDate: "",
        })),
      )
    : null;
  const enteredEtfs = new Set(
    krDoc?.executions.filter((e) => e.market === "ETF").map((e) => e.symbol) ?? [],
  );
  const etfPositions = etfActual
    ? [...etfActual.positions, ...(etf ?? []).filter((p) => !enteredEtfs.has(p.symbol))]
    : etf;
  const sectorContext = projectDashboardSectorContext(krDoc, kr?.screeningCreatedAt);
  const markets = DASHBOARD_MARKETS.map((market) =>
    marketSignals(
      market === "US" ? us : kr,
      market,
      market === "US"
        ? (usActual?.positions ?? null)
        : market === "ETF"
          ? etfPositions
          : (krActual?.positions ?? null),
      market === "US"
        ? (usActual?.executions ?? [])
        : market === "ETF"
          ? (etfActual?.executions ?? [])
          : (krActual?.executions ?? []),
      sectorContext,
    ),
  );
  if (!krDoc)
    warnings.push("국내 실제 원장이 없거나 조회되지 않아 국내 EXIT는 집계하지 않았습니다.");
  if (!usDoc)
    warnings.push(
      "미국 실제 원장이 없거나 조회되지 않아 A0 실제 포트폴리오와 EXIT는 미확인으로 표시합니다.",
    );
  for (const [label, index, positions] of [
    ["국내", kr, krActual?.positions],
    ["미국", us, usActual?.positions],
  ] as const) {
    if (!index || !positions) continue;
    const available = new Set(index.rows.filter((r) => r.date === index.date).map((r) => r.symbol));
    const missing = positions.filter((p) => !available.has(p.symbol));
    if (missing.length)
      warnings.push(
        `${label} 보유 ${missing.length}종목은 최신 스크리닝에 없어 신호 확인이 필요합니다.`,
      );
  }
  return {
    markets,
    usOrderPreview,
    usPortfolio:
      usDoc && usActual
        ? {
            capital: usDoc.capital,
            summary: usActual.summary,
            unpricedPositions: usActual.positions.filter(
              (p) => !p.markDate || p.markDate !== us?.date,
            ).length,
          }
        : null,
    etfHoldings: etf === null ? null : etfHoldings,
    warnings,
  };
}

export async function saveDashboardEtfHoldings(accessToken: string, input: unknown) {
  const { client, uid } = await authenticate(accessToken);
  const symbols = validateEtfHoldingSymbols(input);
  const kr = await projection(client, uid, "kr");
  if (!kr) throw new Error("국내 스크리닝 결과를 먼저 확인해 주세요.");
  const known = new Set(kr.rows.filter((r) => r.market === "ETF").map((r) => r.symbol));
  if (symbols.some((s) => !known.has(s)))
    throw new Error("현재 ETF 스크리너에 있는 종목코드만 등록할 수 있습니다.");
  const value = { symbols, updatedAt: new Date().toISOString() };
  await writeJson(client, `${uid}/${ETF_HOLDINGS_PATH}`, value);
  return value;
}
