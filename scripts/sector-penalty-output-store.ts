import { gzipSync } from "node:zlib";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SectorPenaltyPortfolioBacktestResult } from "../src/lib/engine/sectorPenaltyPortfolioBacktest";
import { ANALYSIS_BUCKET, sha256 } from "./analysis-run-store";

export const PORTFOLIO_RESULT_STORAGE_VERSION = "sector-v8-result-storage-v2" as const;

export const PORTFOLIO_DETAIL_FIELDS = [
  "yearlyReturns",
  "monthlyReturns",
  "regimeReturns",
  "equityCurve",
  "drawdownSeries",
] as const;

export type PortfolioDetailField = (typeof PORTFOLIO_DETAIL_FIELDS)[number];

export type PortfolioResultSummary = Omit<SectorPenaltyPortfolioBacktestResult, PortfolioDetailField>;

export interface PortfolioResultDetails {
  version: typeof PORTFOLIO_RESULT_STORAGE_VERSION;
  engineVersion: SectorPenaltyPortfolioBacktestResult["version"];
  yearlyReturns: SectorPenaltyPortfolioBacktestResult["yearlyReturns"];
  monthlyReturns: SectorPenaltyPortfolioBacktestResult["monthlyReturns"];
  regimeReturns: SectorPenaltyPortfolioBacktestResult["regimeReturns"];
  equityCurve: SectorPenaltyPortfolioBacktestResult["equityCurve"];
  drawdownSeries: SectorPenaltyPortfolioBacktestResult["drawdownSeries"];
}

export interface StoredCompressedJson {
  path: string;
  sha256: string;
  uncompressedBytes: number;
  compressedBytes: number;
}

/**
 * latest.json은 전략 비교에 자주 쓰는 rows/bestRows를 유지하고,
 * 대용량 기간별/곡선 데이터만 압축 sidecar로 분리한다.
 */
export function splitPortfolioResult(result: SectorPenaltyPortfolioBacktestResult): {
  summary: PortfolioResultSummary;
  details: PortfolioResultDetails;
} {
  const {
    yearlyReturns,
    monthlyReturns,
    regimeReturns,
    equityCurve,
    drawdownSeries,
    ...summary
  } = result;

  return {
    summary,
    details: {
      version: PORTFOLIO_RESULT_STORAGE_VERSION,
      engineVersion: result.version,
      yearlyReturns,
      monthlyReturns,
      regimeReturns,
      equityCurve,
      drawdownSeries,
    },
  };
}

export async function uploadCompactJson(
  client: SupabaseClient,
  objectPath: string,
  value: unknown,
) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, body, {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw new Error(`Supabase JSON 업로드 실패 (${objectPath}): ${error.message}`);
  return { path: objectPath, bytes: body.byteLength, sha256: sha256(body) };
}

export async function uploadGzipJson(
  client: SupabaseClient,
  objectPath: string,
  value: unknown,
): Promise<StoredCompressedJson> {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  const compressed = gzipSync(raw, { level: 9 });
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, compressed, {
    // cloudtrend-data bucket에서 허용되는 일반 바이너리 MIME을 사용한다.
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`Supabase gzip JSON 업로드 실패 (${objectPath}): ${error.message}`);
  return {
    path: objectPath,
    sha256: sha256(raw),
    uncompressedBytes: raw.byteLength,
    compressedBytes: compressed.byteLength,
  };
}
