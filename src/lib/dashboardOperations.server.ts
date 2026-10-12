import { dashboardSectorLimit } from "./dashboardOperationsSectorLimits";
import { gunzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { downloadFreshObject } from "./freshStorage";
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

import { loadActualPositionSnapshotForOwner } from "./websitePositionContext.server";
import { OPERATIONAL_SIGNAL_START, isOperationalSignalDate } from "./operationalSignalStart";
import type { NewActualPool } from "./newActualPortfolio";

const BUCKET = "cloudtrend-data";
const VERSION = "dashboard-operations-krx-reference-v7";
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
function poolSummary(pool: NewActualPool) {
  return {
    currency: pool.currency,
    fundingStatus: pool.fundingStatus,
    netContributions: pool.netContributions,
    cash: pool.cash,
    openPositions: pool.positions.length,
    assetPositions: {
      KR: pool.positions.filter((position) => position.asset === "KR").length,
      US: pool.positions.filter((position) => position.asset === "US").length,
      ETF: pool.positions.filter((position) => position.asset === "ETF").length,
    },
  };
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
  const [kr, us, actualSnapshot] = await Promise.all([
    safe("국내 신호", () => projection(client, uid, "kr")),
    safe("미국 신호", () => projection(client, uid, "us")),
    safe("신규 실제 보유", () => loadActualPositionSnapshotForOwner(client, uid)),
  ]);
  const context = actualSnapshot?.context ?? null;
  if (kr?.rows.some((r) => r.market === "ETF" && r.etfEntry?.dataStatus === "krx_batch_pending")) {
    warnings.push(
      `ETF ${kr.date}: KRX 기준일 자료 확인 대기. 다음 영업일 08:00 KST부터 조회 가능하며, 저녁 미공표는 정상입니다. 가용한 조건별 판단은 ETF 스크리너에서 확인하고 최종 진입은 자료 확인 후 판단합니다.`,
    );
  }
  const actualSectorCounts = new Map<string, number>();
  let actualSectorsKnown = !!context && !!kr;
  for (const position of context?.positions ?? []) {
    if (position.market !== "KOSPI" && position.market !== "KOSDAQ") continue;
    const row = kr?.rows.find(
      (row) =>
        row.symbol === position.symbol && row.market === position.market && row.date === kr.date,
    );
    const sector = row?.sectorCode;
    if (!sector || ["UNKNOWN", "ETC", "OTHER", "-"].includes(sector)) actualSectorsKnown = false;
    else actualSectorCounts.set(sector, (actualSectorCounts.get(sector) ?? 0) + 1);
  }
  // Only allocated actual fills determine dashboard holdings and consumed signals.
  // Shadow, old journals and manually tracked ETF membership are never a fallback.
  const markets = DASHBOARD_MARKETS.map((market) =>
    marketSignals(
      market === "US" ? us : kr,
      market,
      context ? context.positions.filter((position) => position.market === market) : null,
      context?.actualExecutions ?? [],
      {
        counts: actualSectorsKnown ? actualSectorCounts : null,
        maxPositions: 30,
        asOfDate: kr?.date ?? null,
        issue: actualSectorsKnown ? null : "실제 보유 섹터 자료 미확인",
      },
      OPERATIONAL_SIGNAL_START,
    ),
  );
  if (!context)
    warnings.push("신규 실제 보유정보를 확인하지 못해 보유 EXIT는 미확인으로 표시합니다.");
  for (const [label, index, market] of [
    ["국내", kr, "KR"],
    ["미국", us, "US"],
  ] as const) {
    if (!index) continue;
    if (!isOperationalSignalDate(index.date)) {
      warnings.push(
        `${label} ${index.date}: 신규 운용 시작 전 자료입니다. 10월 12일 이후 새 신호부터 진입 준비·EXIT를 표시합니다.`,
      );
      continue;
    }
    if (!context) continue;
    const positions = context.positions.filter((position) =>
      market === "US" ? position.market === "US" : position.market !== "US",
    );
    const available = new Set(
      index.rows.filter((row) => row.date === index.date).map((row) => row.symbol),
    );
    const missing = positions.filter((position) => !available.has(position.symbol));
    if (missing.length)
      warnings.push(
        `${label} 신규 보유 ${missing.length}종목은 최신 스크리닝에 없어 신호 확인이 필요합니다.`,
      );
  }
  const actualAllocation = actualSnapshot
    ? await safe("실제 배분 예산", async () => {
        const { projectDashboardActualAllocation } =
          await import("./dashboardActualAllocation.server");
        return projectDashboardActualAllocation({ actual: actualSnapshot, kr, us, markets });
      })
    : null;
  if (actualAllocation) {
    const sector = actualAllocation.sectorContext;
    const sectorContext = {
      ...sector,
      counts: sector.counts ? new Map(Object.entries(sector.counts)) : null,
      issue: sector.counts ? null : "실제 보유·미체결 예약 섹터 미확인",
    };
    for (const group of markets)
      for (const row of [...(group.conditions ?? []), ...group.onsets, ...(group.pending ?? [])]) {
        const limit = dashboardSectorLimit(row, sectorContext);
        if (limit) row.sectorLimit = limit;
      }
  }
  return {
    markets,
    actualAllocation,
    newActualPools: context
      ? { KRW: poolSummary(context.actualPools.KRW), USD: poolSummary(context.actualPools.USD) }
      : null,
    // Keep old response keys empty for older clients; no old values cross this boundary.
    usOrderPreview: null,
    usPortfolio: null,
    etfHoldings: null,
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
