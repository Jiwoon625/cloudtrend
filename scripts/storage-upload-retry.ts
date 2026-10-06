/** Bounded application retries, only for idempotent Storage upserts of identical bytes. */
export const STORAGE_UPLOAD_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 2_000] as const;

type ErrorRecord = Record<string, unknown>;
type FailureKind = "permanent" | "transient" | "opaque";

export interface StorageUploadContext {
  bucket: string;
  objectPath: string;
  bytes: number;
}

export interface StorageUploadDiagnostic {
  operation: "storage.upload";
  bucket: string;
  objectPath: string;
  bytes: number;
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  attemptDurationMs: number;
  status: number | null;
  code: string | null;
  name: string | null;
  failureKind: FailureKind;
  reason:
    | "authorization"
    | "validation"
    | "http-client"
    | "http-transient"
    | "transport"
    | "opaque"
    | "unclassified";
  messagePresent: boolean;
  retryInMs: number | null;
}

interface RetryRuntime {
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  random: () => number;
  warn: (message: string) => void;
}

// https://supabase.com/docs/guides/storage/debugging/error-codes
const PERMANENT_CODES = new Set([
  "NoSuchBucket",
  "NoSuchKey",
  "NoSuchUpload",
  "InvalidJWT",
  "InvalidRequest",
  "TenantNotFound",
  "EntityTooLarge",
  "ResourceAlreadyExists",
  "InvalidBucketName",
  "InvalidKey",
  "InvalidRange",
  "InvalidMimeType",
  "InvalidUploadId",
  "KeyAlreadyExists",
  "BucketAlreadyExists",
  "InvalidSignature",
  "SignatureDoesNotMatch",
  "AccessDenied",
  "MissingContentLength",
  "MissingParameter",
  "InvalidUploadSignature",
  "S3InvalidAccessKeyId",
  "S3MaximumCredentialsLimit",
  "InvalidChecksum",
  "MissingPart",
  "Unauthorized",
  "Forbidden",
  "BadRequest",
  "NotFound",
  "Duplicate",
  "not_found",
  "already_exists",
  "unauthorized",
  "invalid_credentials",
  "insufficient_privilege",
  "42501",
  "EACCES",
  "EPERM",
  "ENOTFOUND",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const TRANSIENT_CODES = new Set([
  "InternalError",
  "DatabaseError",
  "DatabaseTimeout",
  "LockTimeout",
  "SlowDown",
  "RequestTimeout",
  "TooManyRequests",
  "ServiceUnavailable",
  "internal_server_error",
  "database_timeout",
  "too_many_requests",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "StorageError",
  "StorageApiError",
  "StorageUnknownError",
  "StorageClientError",
  "FetchError",
  "NetworkError",
  "TimeoutError",
  "AbortError",
  "ValidationError",
]);
const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
const permanentCodes = new Set([...PERMANENT_CODES].map(normalize));
const transientCodes = new Set([...TRANSIENT_CODES].map(normalize));

// Inspect only known SDK wrapper fields; never stringify errors, bodies, headers or credentials.
function errorRecords(error: unknown): ErrorRecord[] {
  const pending = [error];
  const visited = new Set<unknown>();
  const result: ErrorRecord[] = [];
  while (pending.length && result.length < 8) {
    const item = pending.shift();
    if (typeof item === "string") {
      result.push({ message: item });
    } else if (item && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      const record = item as ErrorRecord;
      result.push(record);
      for (const key of ["originalError", "cause", "error", "response"]) {
        const nested = readField(record, key);
        if (nested && (typeof nested === "object" || typeof nested === "string"))
          pending.push(nested);
      }
    }
  }
  return result;
}

function readField(record: ErrorRecord, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function textField(record: ErrorRecord, key: string): string {
  const value = readField(record, key);
  return typeof value === "string"
    ? value.trim().slice(0, 4_096)
    : key === "code" && typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
}

function httpStatus(value: unknown): number | null {
  const status =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function inspectFailure(error: unknown) {
  const records = errorRecords(error);
  const statuses = records.flatMap((record) =>
    ["status", "statusCode", "httpStatusCode"]
      .map((key) => httpStatus(readField(record, key)))
      .filter((value): value is number => value !== null),
  );
  const codes = records
    .flatMap((record) => [
      textField(record, "code"),
      textField(record, "error"),
      httpStatus(readField(record, "statusCode")) === null ? textField(record, "statusCode") : "",
    ])
    .filter(Boolean);
  const names = records.map((record) => textField(record, "name")).filter(Boolean);
  const messages = records
    .map((record) => textField(record, "message"))
    .filter((message) => message && !/^(?:<none>|undefined|null|unknown error)$/i.test(message));
  const normalizedCodes = codes.map(normalize);
  const description = [...codes, ...names, ...messages].join(" ");
  let kind: FailureKind = "permanent";
  let reason: StorageUploadDiagnostic["reason"] = "unclassified";

  // A denial or invalid request wins even if a proxy/wrapper also reports a server error.
  const authorization =
    normalizedCodes.some((code) => /^(?:42501|28\d{3}|eacces|eperm)$/.test(code)) ||
    statuses.some((status) => status === 401 || status === 403) ||
    /row[- ]level security|\brls\b|permission|access.?denied|unauthori[sz]ed|forbidden|not authori[sz]ed|\bAuth\w*Error\b|authentication (?:failed|required)|invalid.?(?:jwt|token|signature|api.?key)|signaturedoesnotmatch|s3invalidaccesskeyid|insufficient.?privilege|(?:jwt|token).*expired/i.test(
      description,
    );
  const validation =
    normalizedCodes.some(
      (code) => permanentCodes.has(code) || /^(?:invalid|missing|22\d{3}|23\d{3})/.test(code),
    ) ||
    /invalid (?:request|input|argument|parameter|mime|bucket|path)|validation|SyntaxError|RangeError|ReferenceError/i.test(
      description,
    );
  if (authorization) {
    reason = "authorization";
  } else if (validation) {
    reason = "validation";
  } else if (
    statuses.some(
      (status) =>
        status < 500 &&
        status !== 408 &&
        status !== 429 &&
        !(status === 423 && normalizedCodes.includes("locktimeout")),
    )
  ) {
    reason = "http-client";
  } else if (statuses.some((status) => status === 408 || status === 429 || status >= 500)) {
    kind = "transient";
    reason = "http-transient";
  } else if (
    normalizedCodes.some((code) => transientCodes.has(code)) ||
    /fetch failed|failed to fetch|network(?: request)? (?:error|failed)|NetworkError|TimeoutError|timed? ?out|timeout|socket hang up|connection (?:reset|refused|closed)/i.test(
      description,
    )
  ) {
    kind = "transient";
    reason = "transport";
  } else if (
    !statuses.length &&
    !codes.length &&
    !messages.length &&
    names.every((name) =>
      ["Error", "StorageError", "StorageApiError", "StorageUnknownError"].includes(name),
    )
  ) {
    // Missing SDK diagnostics are not proof of a transient error. Allow just one recovery try.
    kind = "opaque";
    reason = "opaque";
  }

  // Only recognized identifiers reach logs. Arbitrary messages/identifiers can contain secrets.
  const code =
    codes.find((value) => PERMANENT_CODES.has(value)) ??
    codes.find((value) => TRANSIENT_CODES.has(value)) ??
    (codes.length ? "<unrecognized>" : null);
  const name =
    names.find((value) => ERROR_NAMES.has(value)) ?? (names.length ? "<unrecognized>" : null);
  return {
    kind,
    reason,
    status: statuses[0] ?? null,
    code,
    name,
    messagePresent: messages.length > 0,
  };
}

/** Metadata may contain a signed URL by mistake. Redact URLs, query strings and token formats. */
function safeLocation(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/[?#].*$/s, "[redacted-query]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-credential]")
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+)\b/g,
      "[redacted-token]",
    )
    .replace(
      /(?:authorization|api[-_]?key|token|secret|password|cookie)\s*[:=]\s*\S+/gi,
      "[redacted-credential]",
    )
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 240);
}

export class StorageUploadError extends Error {
  constructor(public readonly diagnostic: StorageUploadDiagnostic) {
    super(`Supabase 업로드 실패: ${JSON.stringify(diagnostic)}`);
    this.name = "StorageUploadError";
    // Do not attach the original error as cause: callers log Error objects, including causes.
  }
}

/** The caller must capture the exact same object path, serialized bytes and upsert options. */
export async function retryIdempotentStorageUpload<T>(
  upload: () => Promise<T>,
  context: StorageUploadContext,
  runtimeOverrides: Partial<RetryRuntime> = {},
): Promise<T> {
  const runtime: RetryRuntime = {
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => performance.now(),
    random: Math.random,
    warn: (message) => console.warn(message),
    ...runtimeOverrides,
  };
  const started = runtime.now();
  for (let attempt = 1; ; attempt++) {
    const attemptStarted = runtime.now();
    try {
      return await upload();
    } catch (error) {
      const failure = inspectFailure(error);
      const maxAttempts = Math.max(
        attempt,
        failure.kind === "opaque"
          ? 2
          : failure.kind === "transient"
            ? STORAGE_UPLOAD_MAX_ATTEMPTS
            : 1,
      );
      const elapsed = runtime.now();
      const delay =
        attempt < maxAttempts
          ? (RETRY_DELAYS_MS[attempt - 1] ?? 2_000) +
            Math.floor(Math.max(0, Math.min(1, runtime.random())) * 250)
          : null;
      const diagnostic: StorageUploadDiagnostic = {
        operation: "storage.upload",
        bucket: safeLocation(context.bucket),
        objectPath: safeLocation(context.objectPath),
        bytes: context.bytes,
        attempt,
        maxAttempts,
        durationMs: Math.max(0, Math.round(elapsed - started)),
        attemptDurationMs: Math.max(0, Math.round(elapsed - attemptStarted)),
        status: failure.status,
        code: failure.code,
        name: failure.name,
        failureKind: failure.kind,
        reason: failure.reason,
        messagePresent: failure.messagePresent,
        retryInMs: delay,
      };
      if (delay === null) throw new StorageUploadError(diagnostic);
      runtime.warn(`[storage-upload-retry] ${JSON.stringify(diagnostic)}`);
      await runtime.sleep(delay);
    }
  }
}
