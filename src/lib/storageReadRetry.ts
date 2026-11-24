import type { SupabaseClient } from "@supabase/supabase-js";

/** Supabase Storage occasionally answers a plain immutable read with 403 Forbidden,
 * 429/5xx, an opaque `<none>` error, or no response at all. Published chart bundles and
 * readback markers are revision-scoped and never mutated, so repeating the same GET is
 * always safe. A genuinely missing object (404) or an unusable client error is returned
 * immediately so the caller can regenerate the cache instead of stalling the pipeline.
 */
export interface StorageReadErrorLike {
  message?: string | undefined;
  statusCode?: string | number | undefined;
}

export interface StorageReadRetryOptions {
  /** Extra attempts after the first one. Default 3. */
  retries?: number | undefined;
  /** Wait before each retry; the last entry repeats if retries outlast the list. */
  delaysMs?: readonly number[] | undefined;
  /** An attempt that never settles is abandoned and retried after this long. Default 20s. */
  timeoutMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  onRetry?:
    ((info: { attempt: number; delayMs: number; error: StorageReadErrorLike }) => void) | undefined;
}

export type StorageReadOutcome =
  | { status: "ok"; data: Blob; attempts: number }
  | { status: "missing"; attempts: number }
  | { status: "failed"; error: StorageReadErrorLike; attempts: number };

/** One first attempt plus three backoff retries: 500ms, 1000ms, 2000ms. */
export const STORAGE_READ_RETRIES = 3;
export const STORAGE_READ_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
export const STORAGE_READ_ATTEMPT_TIMEOUT_MS = 20_000;

/** Same rule the cache layer always used: only a real "no such object" means absent. */
export function isStorageObjectMissing(error: StorageReadErrorLike): boolean {
  return String(error.statusCode) === "404" || error.message === "Object not found";
}

// 403 is included on purpose: the Storage CDN intermittently forbids a read of an object
// that exists and is readable milliseconds later (2026-11-24 full-history verification).
const TRANSIENT_STATUSES = new Set([
  "403",
  "408",
  "425",
  "429",
  "500",
  "502",
  "503",
  "504",
  "520",
  "521",
  "522",
  "523",
  "524",
  "529",
]);
const OPAQUE_MESSAGES = new Set(["", "<none>", "none", "undefined", "null", "{}"]);
const TRANSIENT_MESSAGE =
  /forbidden|fetch failed|failed to fetch|network|timeout|timed out|aborted|abort|terminated|socket hang up|econnreset|econnrefused|etimedout|eai_again|enotfound|too many requests|rate limit|service unavailable|internal server error|bad gateway|gateway timeout|upstream|cloudflare|connection |temporar/i;

/** True when the same read is worth repeating; false for defects that will not heal. */
export function isTransientStorageReadError(error: StorageReadErrorLike): boolean {
  if (isStorageObjectMissing(error)) return false;
  const status = String(error.statusCode ?? "").trim();
  if (TRANSIENT_STATUSES.has(status)) return true;
  // Remaining 4xx answers (400, 401, 410, …) describe the request itself, not the moment.
  if (/^4\d\d$/.test(status)) return false;
  const message = (error.message ?? "").trim();
  // Supabase reports a failed or unreadable response as a bare "<none>" with no status.
  if (OPAQUE_MESSAGES.has(message.toLowerCase())) return true;
  return TRANSIENT_MESSAGE.test(message);
}

function asStorageError(thrown: unknown): StorageReadErrorLike {
  if (thrown && typeof thrown === "object") {
    const candidate = thrown as StorageReadErrorLike;
    return {
      message: typeof candidate.message === "string" ? candidate.message : String(thrown),
      statusCode: candidate.statusCode,
    };
  }
  return { message: thrown === undefined ? "<none>" : String(thrown) };
}

/** One read attempt, abandoned (and therefore retried) when it never settles. */
async function downloadOnce(
  client: SupabaseClient,
  bucket: string,
  path: string,
  timeoutMs: number,
): Promise<{ data: Blob | null; error: StorageReadErrorLike | null }> {
  // The rejection handler is attached immediately so a late failure after the timeout
  // never surfaces as an unhandled rejection once the attempt has been abandoned.
  const request = client.storage
    .from(bucket)
    .download(path)
    .then(
      (result) => ({ kind: "result" as const, result }),
      (thrown: unknown) => ({ kind: "thrown" as const, error: asStorageError(thrown) }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "thrown"; error: StorageReadErrorLike }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          kind: "thrown",
          error: { statusCode: "408", message: `차트 캐시 읽기 시간 초과 (${timeoutMs}ms)` },
        }),
      timeoutMs,
    );
  });
  try {
    const settled = await Promise.race([request, timeout]);
    if (settled.kind === "thrown") return { data: null, error: settled.error };
    const { data, error } = settled.result;
    if (error) return { data: null, error: asStorageError(error) };
    // A null body without an error is the same opaque failure: retry it, never cache it.
    if (!data) return { data: null, error: { message: "<none>" } };
    return { data, error: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read one storage object, retrying only failures that can heal on their own. */
export async function downloadStorageObject(
  client: SupabaseClient,
  bucket: string,
  path: string,
  options: StorageReadRetryOptions = {},
): Promise<StorageReadOutcome> {
  const retries = Math.max(0, options.retries ?? STORAGE_READ_RETRIES);
  const delays = options.delaysMs ?? STORAGE_READ_RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? STORAGE_READ_ATTEMPT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const { data, error } = await downloadOnce(client, bucket, path, timeoutMs);
    if (!error && data) return { status: "ok", data, attempts };
    const failure = error ?? { message: "<none>" };
    if (isStorageObjectMissing(failure)) return { status: "missing", attempts };
    const retriesUsed = attempts - 1;
    if (!isTransientStorageReadError(failure) || retriesUsed >= retries)
      return { status: "failed", error: failure, attempts };
    const delayMs = delays.length ? (delays[Math.min(retriesUsed, delays.length - 1)] ?? 0) : 0;
    options.onRetry?.({ attempt: attempts, delayMs, error: failure });
    if (delayMs > 0) await sleep(delayMs);
  }
}
