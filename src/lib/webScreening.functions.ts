import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";

import { compactDashboardRow } from "@/lib/dashboardRow";
import { parseManualMarketData } from "@/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "@/lib/engine/fullMarketAnalysis";
import { mergeScoringConfig, type ScoringConfig } from "@/lib/engine/scoring";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";
import {
  compareKospiRelativeQuality,
  isKospiRelativeMomentumConfirmed,
} from "@/lib/kospiRelativeQuality";
import { buildSnapshot } from "@/lib/screeningHistory";

const SUPABASE_URL =
  import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
  "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE";
const ANALYSIS_BUCKET = "cloudtrend-data";

// Keep these in sync with src/lib/screeningCache.ts. The server writes the same cache
// contract that the browser reads, but performs the expensive 40MB+ source parsing on
// the application server instead of the user's phone or PC.
const SCREENING_CACHE_VERSION = "screening-cache-v8-final-v3" as const;
const DASHBOARD_CACHE_VERSION = "dashboard-cache-v8-final-v4" as const;

interface ActiveSourceRecord {
  id: string;
  original_filename: string;
  storage_bucket: string;
  storage_path: string;
  file_hash: string;
  data_hash: string;
  schema_hash: string;
  activated_at: string | null;
  created_at: string;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function deterministicAnalysis(analysis: AnalysisResult) {
  return { ...analysis, calculatedAt: "" };
}

function resultDigest(analysis: AnalysisResult) {
  return sha256Text(stable(deterministicAnalysis(analysis)));
}

function inputFingerprint(sources: ActiveSourceRecord[], config: ScoringConfig) {
  return sha256Text(
    stable({
      version: SCREENING_CACHE_VERSION,
      strategyConfig: config,
      sources: sources
        .map((source) => ({
          id: source.id,
          dataHash: source.data_hash,
          schemaHash: source.schema_hash,
          activatedAt: source.activated_at,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      legacyFallback: null,
    }),
  );
}

function decodeSource(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

async function loadActiveSources(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("analysis_source_files")
    .select(
      "id,original_filename,storage_bucket,storage_path,file_hash,data_hash,schema_hash,activated_at,created_at",
    )
    .eq("user_id", userId)
    .eq("source_type", "screening")
    .eq("status", "active")
    .order("activated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`스크리닝 원천데이터 목록 조회 실패: ${error.message}`);
  const sources = (data ?? []) as ActiveSourceRecord[];
  if (sources.length === 0) throw new Error("활성 스크리닝 원천데이터가 없습니다.");

  const texts: string[] = [];
  for (const source of sources) {
    const { data: blob, error: downloadError } = await client.storage
      .from(source.storage_bucket)
      .download(source.storage_path);
    if (downloadError)
      throw new Error(`스크리닝 원천파일 다운로드 실패 (${source.original_filename}): ${downloadError.message}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (fileHash !== source.file_hash)
      throw new Error(`스크리닝 원천파일 해시가 등록정보와 다릅니다: ${source.original_filename}`);
    texts.push(decodeSource(bytes));
  }
  return { sources, texts };
}

function buildRotationSectors(analysis: AnalysisResult) {
  const rotation = analysis.sectorRotation?.sectors ?? [];
  if (rotation.length > 0)
    return [...rotation]
      .sort((a, b) => a.rank - b.rank)
      .map((sector) => ({
        sectorCode: sector.sectorCode,
        sectorName: sector.sectorName,
        rank: sector.rank,
        prevRank: sector.prevRank,
        rs20: sector.rs20,
        score: sector.rotationScore,
        priceLeadership: sector.priceLeadership.score,
        moneyFlow: sector.moneyFlow.score,
      }));
  return [...analysis.sectors]
    .sort((a, b) => a.rank - b.rank)
    .map((sector) => ({
      sectorCode: sector.sectorCode,
      sectorName: sector.sectorName,
      rank: sector.rank,
      prevRank: sector.prevRank,
      rs20: sector.rs20,
      score: sector.score,
      priceLeadership: null,
      moneyFlow: null,
    }));
}

function signalPriority(a: ScreeningRow, b: ScreeningRow) {
  const priority = b.priority.points - a.priority.points;
  if (priority !== 0) return priority;
  const rotation = (b.sectorRotationScore ?? -Infinity) - (a.sectorRotationScore ?? -Infinity);
  if (rotation !== 0) return rotation;
  return (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity);
}

function buildDashboardSummary(analysis: AnalysisResult, fingerprint: string, digest: string) {
  const rows = analysis.rows;
  const passed = rows.filter((row) => row.hardFilterPassed);
  const onsetRows = [...rows]
    .filter((row) => row.kosdaq80Onset)
    .sort(signalPriority)
    .slice(0, 30);
  const kospiEntryRows = [...rows]
    .filter((row) => row.kospiEightPointEntry)
    .sort(compareKospiRelativeQuality)
    .slice(0, 30);
  const exitRows = [...rows]
    .filter(
      (row) =>
        row.instrument.instrumentType === "STOCK" &&
        row.instrument.market === "KOSDAQ" &&
        row.exitSignal !== null,
    )
    .sort((a, b) => (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity))
    .slice(0, 30);
  const top = [...passed]
    .filter((row) => row.instrument.instrumentType === "STOCK")
    .sort((a, b) => b.totalScoreNormalized - a.totalScoreNormalized)
    .slice(0, 10);

  const failMap = new Map<string, number>();
  for (const row of rows) {
    if (row.hardFilterPassed) continue;
    for (const reason of row.failedRules) failMap.set(reason, (failMap.get(reason) ?? 0) + 1);
  }

  return {
    version: DASHBOARD_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint: fingerprint,
    resultDigest: digest,
    asOfDate: analysis.asOfDate,
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    calculatedAt: analysis.calculatedAt,
    marketGate: analysis.marketGate,
    kospi: analysis.kospi,
    kosdaq: analysis.kosdaq,
    vkospi: analysis.vkospi,
    marketForeignNet5d: analysis.marketForeignNet5d,
    rotationSectors: buildRotationSectors(analysis),
    counts: {
      total: rows.length,
      passed: passed.length,
      disqualified: rows.length - passed.length,
      kosdaq80Onsets: rows.filter((row) => row.kosdaq80Onset).length,
      kospiEightPointEntries: rows.filter((row) => row.kospiEightPointEntry).length,
      kospiRelativeQualityConfirmed: rows.filter(
        (row) => row.kospiEightPointEntry && isKospiRelativeMomentumConfirmed(row),
      ).length,
      upsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "UP95",
      ).length,
      downsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "DOWN25",
      ).length,
      incomplete: rows.filter(
        (row) => row.instrument.instrumentType === "STOCK" && row.operatingScore10 === null,
      ).length,
    },
    failReasons: [...failMap.entries()].sort((a, b) => b[1] - a[1]),
    onsetRows: onsetRows.map(compactDashboardRow),
    kospiEntryRows: kospiEntryRows.map(compactDashboardRow),
    exitRows: exitRows.map(compactDashboardRow),
    top: top.map(compactDashboardRow),
  };
}

async function uploadJson(client: SupabaseClient, path: string, value: unknown) {
  const body = new Blob([JSON.stringify(value)], { type: "application/json" });
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(path, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`스크리닝 캐시 저장 실패 (${path}): ${error.message}`);
}

async function readJson<T>(client: SupabaseClient, path: string): Promise<T> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) throw new Error(`스크리닝 캐시 재검증 실패 (${path}): ${error.message}`);
  return JSON.parse(await data.text()) as T;
}

export const runWebScreeningServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; config?: unknown }) => ({
    accessToken: String(input.accessToken ?? ""),
    config: mergeScoringConfig(input.config),
  }))
  .handler(async ({ data }) => {
    if (data.accessToken.length < 20) throw new Error("로그인 세션을 확인할 수 없습니다.");
    const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${data.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await client.auth.getUser(data.accessToken);
    if (authError || !authData.user) throw new Error("로그인 세션 검증에 실패했습니다.");

    const { sources, texts } = await loadActiveSources(client, authData.user.id);
    const parsed = parseManualMarketData(texts);
    const { analysis } = runFullMarketAnalysis(parsed.dataset, data.config);
    const fingerprint = inputFingerprint(sources, data.config);
    const digest = resultDigest(analysis);
    const source = { live: true, credentialsConfigured: true, fallbackReason: null };
    const screening = {
      version: SCREENING_CACHE_VERSION,
      createdAt: new Date().toISOString(),
      inputFingerprint: fingerprint,
      resultDigest: digest,
      payload: { analysis, source },
    };
    const dashboard = buildDashboardSummary(analysis, fingerprint, digest);
    const screeningPath = `${authData.user.id}/cache/screening/latest.json`;
    const dashboardPath = `${authData.user.id}/cache/dashboard/latest.json`;

    await Promise.all([
      uploadJson(client, screeningPath, screening),
      uploadJson(client, dashboardPath, dashboard),
    ]);

    try {
      const snapshot = buildSnapshot(analysis);
      await client.from("screening_history").upsert(
        { user_id: authData.user.id, date: snapshot.date, snapshot },
        { onConflict: "user_id,date" },
      );
    } catch {
      // 이력 저장 실패가 웹 스크리닝 성공을 막지 않게 한다.
    }

    const roundTrip = await readJson<{
      version?: string;
      inputFingerprint?: string;
      resultDigest?: string;
      payload?: { analysis?: AnalysisResult };
    }>(client, screeningPath);
    const roundTripDigest = roundTrip.payload?.analysis ? resultDigest(roundTrip.payload.analysis) : null;
    if (
      roundTrip.version !== SCREENING_CACHE_VERSION ||
      roundTrip.inputFingerprint !== fingerprint ||
      roundTrip.resultDigest !== digest ||
      roundTripDigest !== digest
    )
      throw new Error("서버 스크리닝 캐시 저장 후 검증에 실패했습니다.");

    return {
      ok: true as const,
      asOfDate: analysis.asOfDate,
      rows: analysis.rows.length,
      sources: sources.length,
      inputFingerprint: fingerprint,
      resultDigest: digest,
    };
  });
