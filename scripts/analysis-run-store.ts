import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AnalysisRunKind, AnalysisRunSummaryRecord } from "../src/lib/analysisRunBundle";

export const ANALYSIS_BUCKET = "cloudtrend-data";

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function codeVersion() {
  const explicit = process.env["GITHUB_SHA"] ?? process.env["VERCEL_GIT_COMMIT_SHA"];
  if (explicit) return explicit;
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return diff ? `${commit}+dirty:${sha256(diff).slice(0, 12)}` : commit;
  } catch {
    return "unknown";
  }
}

export function trustedSupabaseClient() {
  const url = process.env["SUPABASE_URL"];
  const secretKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !secretKey) {
    throw new Error("SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 필요합니다.");
  }
  return createClient(url, secretKey, { auth: { persistSession: false } });
}

export async function downloadJson<T>(client: SupabaseClient, objectPath: string): Promise<T> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(objectPath);
  if (error) throw new Error(`Supabase 다운로드 실패 (${objectPath}): ${error.message}`);
  return JSON.parse(await data.text()) as T;
}

export async function uploadJson(client: SupabaseClient, objectPath: string, value: unknown) {
  const body = JSON.stringify(value, null, 2);
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, body, {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw new Error(`Supabase 업로드 실패 (${objectPath}): ${error.message}`);
  return { objectPath, body };
}

export function analysisRunKey(input: {
  kind: AnalysisRunKind;
  codeVersion: string;
  dataVersion: string;
  config: unknown;
}) {
  return `sha256:${sha256(stableJson(input))}`;
}

export async function findReusableRun(
  client: SupabaseClient,
  userId: string,
  kind: AnalysisRunKind,
  runKey: string,
): Promise<AnalysisRunSummaryRecord | null> {
  const { data, error } = await client
    .from("analysis_runs")
    .select("*")
    .eq("user_id", userId)
    .eq("kind", kind)
    .eq("run_key", runKey)
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`기존 실행 조회 실패: ${error.message}`);
  return (data as AnalysisRunSummaryRecord | null) ?? null;
}

export async function saveRunRecord(client: SupabaseClient, record: AnalysisRunSummaryRecord) {
  const { error } = await client.from("analysis_runs").upsert(record, { onConflict: "id" });
  if (error) throw new Error(`실행 요약 저장 실패: ${error.message}`);
}

export function requestedBy() {
  return process.env["GITHUB_ACTOR"] ?? process.env["USER"] ?? "local";
}
