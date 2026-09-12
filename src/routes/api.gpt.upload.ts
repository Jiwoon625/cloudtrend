import path from "node:path";
import process from "node:process";

import { createFileRoute } from "@tanstack/react-router";

import { ANALYSIS_BUCKET, trustedSupabaseClient } from "../../scripts/analysis-run-store";
import {
  registerSourceBytes,
  type SourceRegistrationMode,
} from "../../scripts/source-registry-store";
import { SOURCE_MAX_FILE_BYTES, type SourceType } from "../lib/sourceData";

type InitRequest = {
  action: "init";
  filename: string;
  sizeBytes: number;
  contentType?: string;
  sourceType: SourceType;
  mode?: SourceRegistrationMode;
};

type FinalizeRequest = {
  action: "finalize";
  tempPath: string;
  filename: string;
  contentType?: string;
  sourceType: SourceType;
  mode?: SourceRegistrationMode;
};

type UploadRequest = InitRequest | FinalizeRequest;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function configuredUserId() {
  const userId = process.env["SUPABASE_USER_ID"]?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(userId))
    throw new Error("SUPABASE_USER_ID가 설정되지 않았거나 UUID 형식이 아닙니다.");
  return userId;
}

function authorize(request: Request) {
  const expected = process.env["CLOUDTREND_GPT_API_KEY"]?.trim();
  if (!expected) return { ok: false as const, response: json({ ok: false, error: "GPT 업로드 API가 비활성화되어 있습니다." }, 503) };
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied || supplied !== expected)
    return { ok: false as const, response: json({ ok: false, error: "인증에 실패했습니다." }, 401) };
  return { ok: true as const };
}

function normalizeFilename(filename: string) {
  const base = path
    .basename(filename || "source.csv")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "-")
    .replace(/[^0-9A-Za-z가-힣._ -]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return base || "source.csv";
}

function resolveMode(sourceType: SourceType, mode?: SourceRegistrationMode) {
  const resolved = mode ?? (sourceType === "screening" ? "replace" : "add");
  const allowed =
    sourceType === "screening"
      ? (["replace", "append", "merge"] as const)
      : (["add", "replace_all"] as const);
  if (!(allowed as readonly string[]).includes(resolved))
    throw new Error(`${sourceType} 데이터에 ${resolved} 모드를 사용할 수 없습니다.`);
  return resolved;
}

function validateCommon(sourceType: unknown, filename: unknown) {
  if (sourceType !== "screening" && sourceType !== "backtest")
    throw new Error("sourceType은 screening 또는 backtest여야 합니다.");
  if (typeof filename !== "string" || !filename.trim()) throw new Error("filename이 필요합니다.");
  return { sourceType, filename: normalizeFilename(filename) } as const;
}

async function initUpload(body: InitRequest) {
  const { sourceType, filename } = validateCommon(body.sourceType, body.filename);
  const mode = resolveMode(sourceType, body.mode);
  if (!Number.isInteger(body.sizeBytes) || body.sizeBytes <= 0)
    throw new Error("sizeBytes는 1 이상의 정수여야 합니다.");
  if (body.sizeBytes > SOURCE_MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다.");

  const userId = configuredUserId();
  const uploadId = crypto.randomUUID();
  const tempPath = `${userId}/incoming/gpt/${uploadId}/${filename}`;
  const client = trustedSupabaseClient();
  const { data, error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .createSignedUploadUrl(tempPath, { upsert: false });
  if (error || !data?.signedUrl || !data?.token)
    throw new Error(`Supabase signed upload URL 생성 실패: ${error?.message ?? "unknown"}`);

  return {
    ok: true,
    action: "init",
    uploadId,
    sourceType,
    mode,
    filename,
    sizeBytes: body.sizeBytes,
    contentType: body.contentType || "application/octet-stream",
    bucket: ANALYSIS_BUCKET,
    tempPath,
    signedUrl: data.signedUrl,
    signedToken: data.token,
    expiresInSeconds: 7200,
    next: "파일을 signedUrl/signedToken으로 Supabase Storage에 직접 업로드한 뒤 action=finalize를 호출하세요.",
  };
}

async function finalizeUpload(body: FinalizeRequest) {
  const { sourceType, filename } = validateCommon(body.sourceType, body.filename);
  const mode = resolveMode(sourceType, body.mode);
  const userId = configuredUserId();
  const allowedPrefix = `${userId}/incoming/gpt/`;
  if (typeof body.tempPath !== "string" || !body.tempPath.startsWith(allowedPrefix))
    throw new Error("허용되지 않은 임시 업로드 경로입니다.");

  const client = trustedSupabaseClient();
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(body.tempPath);
  if (error || !data) throw new Error(`임시 업로드 파일 다운로드 실패: ${error?.message ?? "unknown"}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength > SOURCE_MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다.");

  try {
    const result = await registerSourceBytes({
      client,
      userId,
      sourceType,
      mode,
      origin: "gpt",
      bytes,
      filename,
      contentType: body.contentType,
      syncLegacy: true,
    });
    return {
      ok: true,
      action: "finalize",
      reused: result.reused,
      source: {
        id: result.source.id,
        sourceType: result.source.source_type,
        status: result.source.status,
        filename: result.source.original_filename,
        fileSizeBytes: result.source.file_size_bytes,
        rowCount: result.source.row_count,
        symbolCount: result.source.symbol_count,
        minDate: result.source.min_date,
        maxDate: result.source.max_date,
        storageBucket: result.source.storage_bucket,
        storagePath: result.source.storage_path,
        fileHash: result.source.file_hash,
        dataHash: result.source.data_hash,
        schemaHash: result.source.schema_hash,
      },
      overlap: result.overlap,
      validation: {
        valid: result.validation.valid,
        format: result.validation.format,
        columns: result.validation.columns,
        stats: result.validation.stats,
        warningCount: result.validation.warnings.length,
        warnings: result.validation.warnings.slice(0, 100),
      },
    };
  } finally {
    const { error: cleanupError } = await client.storage.from(ANALYSIS_BUCKET).remove([body.tempPath]);
    if (cleanupError) console.error("GPT 임시 업로드 정리 실패", cleanupError);
  }
}

export const Route = createFileRoute("/api/gpt/upload")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = authorize(request);
        if (!auth.ok) return auth.response;
        return json({
          ok: true,
          service: "cloudtrend-gpt-upload",
          maxFileBytes: SOURCE_MAX_FILE_BYTES,
          maxFileMegabytes: 45,
          sourceTypes: ["screening", "backtest"],
          screeningModes: ["replace", "append", "merge"],
          backtestModes: ["add", "replace_all"],
          transport: "supabase-signed-upload",
        });
      },
      POST: async ({ request }) => {
        const auth = authorize(request);
        if (!auth.ok) return auth.response;
        try {
          const body = (await request.json()) as UploadRequest;
          if (body.action === "init") return json(await initUpload(body));
          if (body.action === "finalize") return json(await finalizeUpload(body));
          return json({ ok: false, error: "action은 init 또는 finalize여야 합니다." }, 400);
        } catch (error) {
          const message = error instanceof Error ? error.message : "알 수 없는 오류";
          const status = /인증/.test(message) ? 401 : /필요|허용|형식|크기|모드|sourceType|sizeBytes/.test(message) ? 400 : 500;
          return json({ ok: false, error: message }, status);
        }
      },
    },
  },
});
