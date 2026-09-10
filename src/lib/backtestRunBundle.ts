import type { BacktestResult } from "@/lib/engine/backtestV4";
import { SCORE_CHANGE_BUCKETS } from "@/lib/engine/strategyValidation";

export interface BacktestDataFileVersion {
  id: string;
  fileName: string | null;
  bytes: number;
  savedAt: string;
}

export interface BacktestDataVersionInput {
  source: "SUPABASE_BACKTEST" | "SUPABASE_KR" | "LOCAL_FILES";
  datasetVersion: string;
  asOfDate: string;
  files: BacktestDataFileVersion[];
}

export interface BacktestExecutionConfig {
  symbols: string[];
  limit: number;
  includeEtf: boolean;
  roundTripCostBps: number;
}

export interface BacktestRunBundle {
  schemaVersion: 1;
  run: {
    id: string;
    createdAt: string;
    engineVersion: "CloudTrend V6";
    codeVersion: string;
    dataVersion: string;
  };
  data: BacktestDataVersionInput;
  config: {
    execution: BacktestExecutionConfig;
    engine: BacktestResult["config"];
    scoreChangeBuckets: typeof SCORE_CHANGE_BUCKETS;
  };
  result: BacktestResult;
}

export interface BacktestRunIndexEntry {
  id: string;
  createdAt: string;
  engineVersion: string;
  codeVersion: string;
  dataVersion: string;
  asOfDate: string;
  symbolCount: number;
  from: string;
  to: string;
  path: string;
}

function canonicalDataManifest(input: BacktestDataVersionInput) {
  return JSON.stringify({
    source: input.source,
    datasetVersion: input.datasetVersion,
    asOfDate: input.asOfDate,
    files: [...input.files]
      .map((file) => ({
        id: file.id,
        fileName: file.fileName,
        bytes: file.bytes,
        savedAt: file.savedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createBacktestRunBundle(
  result: BacktestResult,
  data: BacktestDataVersionInput,
  execution: BacktestExecutionConfig,
  codeVersion: string,
): Promise<BacktestRunBundle> {
  const createdAt = new Date().toISOString();
  const dataVersion = `sha256:${await sha256(canonicalDataManifest(data))}`;
  const id = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${dataVersion.slice(7, 15)}`;
  return {
    schemaVersion: 1,
    run: { id, createdAt, engineVersion: "CloudTrend V6", codeVersion, dataVersion },
    data,
    config: { execution, engine: result.config, scoreChangeBuckets: SCORE_CHANGE_BUCKETS },
    result,
  };
}
