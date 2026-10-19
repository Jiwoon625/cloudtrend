import process from "node:process";

import { createFileRoute } from "@tanstack/react-router";

import { trustedSupabaseClient } from "../../scripts/analysis-run-store";
import {
  registerSourceBytes,
  type SourceRegistrationMode,
} from "../../scripts/source-registry-store";
import { SOURCE_MAX_FILE_BYTES, type SourceType } from "../lib/sourceData";
import { notionTradeUrl, parseAssistantActualBuy, sameTradeEvidence } from "../lib/assistantActualTrade";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type OpenAIFile = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

type RegisterArgs = {
  file: OpenAIFile;
  sourceType: SourceType;
  mode?: SourceRegistrationMode;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const FILE_SCHEMA = {
  type: "object",
  properties: {
    download_url: { type: "string" },
    file_id: { type: "string" },
    mime_type: { type: "string" },
    file_name: { type: "string" },
  },
  required: ["download_url", "file_id"],
  additionalProperties: false,
} as const;

const REGISTER_TOOL = {
  name: "register_cloudtrend_source_file",
  title: "Register CloudTrend source file",
  description:
    "Use this when the user wants to register an attached CSV/XLSX/JSON file as CloudTrend screening or backtest source data in Supabase. The tool validates the file and stores it in the user's private CloudTrend source registry.",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE_SCHEMA,
      sourceType: {
        type: "string",
        enum: ["screening", "backtest"],
        description:
          "screening for the current screening/dashboard dataset, or backtest for long-term backtest data.",
      },
      mode: {
        type: "string",
        enum: ["replace", "append", "merge", "add", "replace_all"],
        description:
          "Optional registration mode. screening defaults to replace; backtest defaults to add. Use replace_all only when the user explicitly asks to replace all backtest data.",
      },
    },
    required: ["file", "sourceType"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  _meta: {
    "openai/fileParams": ["file"],
    "openai/toolInvocation/invoking": "CloudTrend 원천데이터를 등록하는 중…",
    "openai/toolInvocation/invoked": "CloudTrend 원천데이터 등록 완료",
  },
} as const;

const PROPOSE_BUY_TOOL = {
  name: "propose_cloudtrend_actual_buy",
  title: "Propose a CloudTrend actual buy",
  description:
    "Stage an actual KOSPI/KOSDAQ BUY from an evidenced Notion trade page for owner review. This does NOT record, simulate, approve, or alter any portfolio holding. Requires the user to have asked to record a real executed buy. No guessed dates, prices, fees, quantities, or source page IDs.",
  inputSchema: {
    type: "object",
    properties: {
      sourcePageId: {
        type: "string",
        description: "Exact UUID of the existing Notion trade evidence page",
      },
      date: { type: "string", description: "YYYY-MM-DD verified actual trade date" },
      symbol: {
        type: "string",
        description: "Six-character Korean listing code; preserve leading zero",
      },
      name: { type: "string" },
      market: { type: "string", enum: ["KOSPI", "KOSDAQ"] },
      side: { type: "string", const: "BUY" },
      shares: { type: "integer", minimum: 1 },
      price: { type: "number", exclusiveMinimum: 0 },
      fee: { type: "number", minimum: 0, description: "Verified broker fee; never infer" },
      accountLabel: { type: "string", enum: ["ISA", "GENERAL", "UNKNOWN"] },
    },
    required: [
      "sourcePageId",
      "date",
      "symbol",
      "name",
      "market",
      "side",
      "shares",
      "price",
      "fee",
    ],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  _meta: {
    "openai/toolInvocation/invoking": "CloudTrend 실제거래 승인 요청을 보관하는 중…",
    "openai/toolInvocation/invoked": "CloudTrend 실제거래 승인 요청을 보관했습니다",
  },
} as const;

async function callProposeBuy(args: unknown) {
  const trade = parseAssistantActualBuy(args);
  const userId = configuredUserId();
  const client = trustedSupabaseClient();

  // A unique (user_id, source_page_id) constraint owns idempotence.
  // Two racing callers may both see no row. Recover the winner after 23505.
  const {error: insertError}=await client.from("assistant_trade_proposals")
    .insert({user_id:userId,source_page_id:trade.sourcePageId,trade,status:"PENDING"});
  if(insertError && insertError.code!=="23505")
    throw new Error("승인대기함에 거래 제안을 저장하지 못했습니다.");
  const {data:existing,error:readError}=await client.from("assistant_trade_proposals")
    .select("id,trade,status")
    .eq("user_id",userId).eq("source_page_id",trade.sourcePageId).maybeSingle();
  if(readError || !existing)
    throw new Error("승인대기함에 등록된 거래 제안을 확인하지 못했습니다.");
  const old=parseAssistantActualBuy(existing.trade);
  if(!sameTradeEvidence(old,trade))
    throw new Error("같은 Notion 증빙으로 다른 체결을 요청했습니다. 기존 요청을 먼저 확인하세요.");
  const proposalId=existing.id as string, status=existing.status as string;
  return {
    structuredContent:{
      proposalId,status,sourceUrl:notionTradeUrl(trade.sourcePageId),
      reviewPath:"/assistant-trades",
      recordedInActualLedger:status==="RECORDED",
      next:status==="PENDING"
        ? "CloudTrend 소유자가 /assistant-trades에서 증빙 대조 후 승인해야 원장에 반영됩니다."
        : "이미 등록된 요청입니다. 상태를 확인하세요.",
    },
    content:[{type:"text",text:status==="PENDING"
      ? `${trade.name} ${trade.shares}주 매수 승인 요청을 보관했습니다. 실제 원장은 변경되지 않았습니다.`
      : `기존 요청 상태: ${status} (실거래 중복 기록 없음)`}],
    isError:false,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function configuredUserId() {
  const userId = process.env["SUPABASE_USER_ID"]?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(userId))
    throw new Error("SUPABASE_USER_ID가 설정되지 않았거나 UUID 형식이 아닙니다.");
  return userId;
}

function authorize(request: Request) {
  const expected = process.env["CLOUDTREND_GPT_API_KEY"]?.trim();
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && header.slice(7).trim() === expected) return true;

  const token = new URL(request.url).searchParams.get("token")?.trim();
  return Boolean(token && token === expected);
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

function parseRegisterArgs(value: unknown): RegisterArgs {
  if (!value || typeof value !== "object") throw new Error("도구 인자가 필요합니다.");
  const input = value as Record<string, unknown>;
  const sourceType = input["sourceType"];
  if (sourceType !== "screening" && sourceType !== "backtest")
    throw new Error("sourceType은 screening 또는 backtest여야 합니다.");

  const fileValue = input["file"];
  if (!fileValue || typeof fileValue !== "object") throw new Error("file 입력이 필요합니다.");
  const file = fileValue as Record<string, unknown>;
  if (typeof file["download_url"] !== "string" || !file["download_url"].startsWith("https://"))
    throw new Error("file.download_url은 HTTPS URL이어야 합니다.");
  if (typeof file["file_id"] !== "string" || !file["file_id"].trim())
    throw new Error("file.file_id가 필요합니다.");

  const mode = input["mode"];
  if (mode !== undefined && typeof mode !== "string")
    throw new Error("mode 형식이 올바르지 않습니다.");

  return {
    sourceType,
    ...(mode !== undefined ? { mode: mode as SourceRegistrationMode } : {}),
    file: {
      download_url: file["download_url"],
      file_id: file["file_id"],
      ...(typeof file["mime_type"] === "string" ? { mime_type: file["mime_type"] } : {}),
      ...(typeof file["file_name"] === "string" ? { file_name: file["file_name"] } : {}),
    },
  };
}

function safeFilename(file: OpenAIFile) {
  const fallback = `${file.file_id}.csv`;
  const raw = (file.file_name || fallback).normalize("NFKC");
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "-")
    .replace(/[\\/]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

async function downloadChatFile(file: OpenAIFile) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(file.download_url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { "user-agent": "CloudTrend-MCP/1.0" },
    });
    if (!response.ok) throw new Error(`ChatGPT 첨부파일 다운로드 실패: HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > SOURCE_MAX_FILE_BYTES)
      throw new Error("파일 1개 크기는 45MB 이하여야 합니다.");

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > SOURCE_MAX_FILE_BYTES)
      throw new Error("파일 1개 크기는 45MB 이하여야 합니다.");
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function callRegisterTool(args: unknown) {
  const input = parseRegisterArgs(args);
  const mode = resolveMode(input.sourceType, input.mode);
  const bytes = await downloadChatFile(input.file);
  const client = trustedSupabaseClient();
  const result = await registerSourceBytes({
    client,
    userId: configuredUserId(),
    sourceType: input.sourceType,
    mode,
    origin: "gpt",
    bytes,
    filename: safeFilename(input.file),
    contentType: input.file.mime_type,
    syncLegacy: input.sourceType === "screening",
  });

  const structuredContent = {
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
      warnings: result.validation.warnings,
    },
  };

  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: `${structuredContent.source.filename}을 CloudTrend ${structuredContent.source.sourceType} 원천데이터로 등록했습니다. ${structuredContent.source.rowCount.toLocaleString()}행, ${structuredContent.source.symbolCount.toLocaleString()}종목, ${structuredContent.source.minDate ?? "?"}~${structuredContent.source.maxDate ?? "?"}.`,
      },
    ],
    isError: false,
  };
}

async function handleRpc(body: JsonRpcRequest) {
  const { id, method, params } = body;
  if (body.jsonrpc !== "2.0" || typeof method !== "string")
    return rpcError(id, -32600, "Invalid Request");

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion:
        typeof params?.["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "cloudtrend", version: "1.0.0" },
      instructions:
        "Source files: register_cloudtrend_source_file. Real buy evidence: propose_cloudtrend_actual_buy saves a PENDING proposal only. The owner must sign in and explicitly approve at /assistant-trades before the unchanged owner-authorized actual ledger records anything. Never claim a pending proposal is a recorded fill.",
    });
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new Response(null, { status: 202 });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, { tools: [REGISTER_TOOL, PROPOSE_BUY_TOOL] });
  }

  if (method === "tools/call") {
    const name = params?.["name"];
    if (name !== REGISTER_TOOL.name && name !== PROPOSE_BUY_TOOL.name)
      return rpcError(id, -32601, `Unknown tool: ${String(name)}`);
    try {
      return rpcResult(
        id,
        name === REGISTER_TOOL.name
          ? await callRegisterTool(params?.["arguments"])
          : await callProposeBuy(params?.["arguments"]),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      return rpcResult(id, {
        content: [{ type: "text", text: `CloudTrend 도구 요청 실패: ${message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorize(request)) return json({ error: "Unauthorized" }, 401);
        return json({
          name: "cloudtrend",
          transport: "streamable-http",
          tools: [REGISTER_TOOL.name, PROPOSE_BUY_TOOL.name],
          fileParams: ["file"],
        });
      },
      POST: async ({ request }) => {
        if (!authorize(request)) return json({ error: "Unauthorized" }, 401);
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json"))
          return json({ error: "Unsupported Media Type" }, 415);
        try {
          const body = (await request.json()) as JsonRpcRequest;
          return await handleRpc(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid JSON";
          return rpcError(null, -32700, "Parse error", message);
        }
      },
      DELETE: async ({ request }) => {
        if (!authorize(request)) return json({ error: "Unauthorized" }, 401);
        return new Response(null, { status: 204 });
      },
    },
  },
});
