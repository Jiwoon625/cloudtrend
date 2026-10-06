import { describe, expect, it, vi } from "vitest";
import { retryIdempotentStorageUpload, StorageUploadError } from "../scripts/storage-upload-retry";

const context = { bucket: "cloudtrend-data", objectPath: "cache/dashboard/latest.json", bytes: 21 };

function runtime() {
  let time = 0;
  return {
    sleep: vi.fn(async (milliseconds: number) => {
      time += milliseconds;
    }),
    now: () => time,
    random: () => 0,
    warn: vi.fn(),
  };
}

async function failure(error: unknown) {
  const clock = runtime();
  const upload = vi.fn(async () => {
    throw error;
  });
  const result = await retryIdempotentStorageUpload(upload, context, clock).catch(
    (caught) => caught,
  );
  expect(result).toBeInstanceOf(StorageUploadError);
  return { upload, clock, result: result as StorageUploadError };
}

describe("bounded idempotent Storage upload retries", () => {
  it("returns first-attempt success without a retry or log", async () => {
    const clock = runtime();
    const upload = vi.fn(async () => "ok");
    await expect(retryIdempotentStorageUpload(upload, context, clock)).resolves.toBe("ok");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(clock.warn).not.toHaveBeenCalled();
  });

  it.each([408, 429, 500, 502, 503, 504, 520, 544])(
    "bounds HTTP %s to three total attempts",
    async (status) => {
      const { upload, clock, result } = await failure({
        statusCode: String(status),
        message: "<none>",
      });
      expect(upload).toHaveBeenCalledTimes(3);
      expect(clock.sleep.mock.calls).toEqual([[1_000], [2_000]]);
      expect(clock.warn).toHaveBeenCalledTimes(2);
      expect(result.diagnostic).toMatchObject({
        status,
        attempt: 3,
        maxAttempts: 3,
        durationMs: 3_000,
        failureKind: "transient",
        retryInMs: null,
      });
    },
  );

  it.each([
    { code: "ECONNRESET" },
    { code: "ETIMEDOUT" },
    { name: "TimeoutError" },
    new TypeError("fetch failed"),
    new Error("Failed to fetch"),
    { error: "SlowDown" },
    { statusCode: "SlowDown" },
    { status: 423, code: "LockTimeout" },
    { name: "StorageUnknownError", originalError: { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } } },
    { name: "StorageUnknownError", originalError: { httpStatusCode: 503 } },
    { response: { status: 502 } },
  ])("retries explicit transport/server failure %#", async (error) => {
    const { upload, result } = await failure(error);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(result.diagnostic.failureKind).toBe("transient");
  });

  it.each([400, 401, 403, 404, 409, 413, 415, 422])("does not retry HTTP %s", async (status) => {
    const { upload, clock, result } = await failure({ status, message: "<none>" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(result.diagnostic.failureKind).toBe("permanent");
  });

  it.each([
    { code: "42501" },
    { code: 42501 },
    { code: "ENOTFOUND", message: "fetch failed" },
    { code: "CERT_HAS_EXPIRED", message: "fetch failed" },
    { error: "AccessDenied" },
    { status: 503, statusCode: "AccessDenied" },
    { code: "InvalidJWT" },
    { code: "InvalidMimeType" },
    { code: "InvalidRequest" },
    { code: "EACCES" },
    { status: 500, message: "new row violates row-level security policy" },
    { status: 503, error: "AccessDenied", message: "<none>" },
    { status: 503, originalError: { code: "42501" } },
    { status: 429, message: "permission denied" },
    { name: "StorageUnknownError", message: "<none>", originalError: "AccessDenied" },
    { name: "ValidationError" },
    { status: 503, name: "AuthApiError" },
    new TypeError("Cannot read properties of undefined"),
    new SyntaxError("Unexpected token in JSON"),
    { name: "AbortError", message: "This operation was aborted" },
    { message: "An unrecognized meaningful error" },
    { code: "UnrecognizedCode" },
  ])("never retries permission, validation or other permanent error %#", async (error) => {
    const { upload, clock } = await failure(error);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(clock.warn).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { message: "<none>" },
    new Error(""),
    { name: "StorageUnknownError" },
    undefined,
    null,
  ])("gives opaque SDK failure only one cautious recovery try %#", async (error) => {
    const { upload, clock, result } = await failure(error);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(clock.sleep.mock.calls).toEqual([[1_000]]);
    expect(result.diagnostic).toMatchObject({ failureKind: "opaque", attempt: 2, maxAttempts: 2 });
  });

  it("returns a later success and stops retrying", async () => {
    const upload = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue("saved");
    const clock = runtime();
    await expect(retryIdempotentStorageUpload(upload, context, clock)).resolves.toBe("saved");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });

  it("stops immediately if a transient failure becomes a denial", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValue({ status: 403 });
    const clock = runtime();
    await expect(retryIdempotentStorageUpload(upload, context, clock)).rejects.toMatchObject({
      diagnostic: { status: 403, attempt: 2, failureKind: "permanent", retryInMs: null },
    });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("adds small bounded jitter and records both attempt and total duration", async () => {
    let now = 0;
    const upload = vi.fn(async () => {
      now += 50;
      throw { statusCode: "503" };
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    await expect(
      retryIdempotentStorageUpload(upload, context, {
        now: () => now,
        sleep,
        random: () => 1,
        warn: vi.fn(),
      }),
    ).rejects.toMatchObject({ diagnostic: { durationMs: 3_650, attemptDurationMs: 50 } });
    expect(sleep.mock.calls).toEqual([[1_250], [2_250]]);
  });

  it("handles circular causes and throwing field getters without exposing the raw error", async () => {
    const error: Record<string, unknown> = { status: 503 };
    error["cause"] = error;
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("private getter contents");
      },
    });
    const { upload, result } = await failure(error);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(result.message).not.toContain("private getter contents");
  });

  it("emits only sanitized allowlisted diagnostics, never messages, headers, bodies or causes", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.privateSignature";
    const secret = "sb_secret_privateCredentials123";
    const signedUrl = `https://example.supabase.co/storage/v1/object/sign/path?token=${jwt}`;
    const error = {
      name: "StorageUnknownError",
      status: 503,
      code: secret,
      message: `Upload failure ${signedUrl} Authorization: Bearer ${jwt} apikey=${secret}`,
      headers: { authorization: `Bearer ${jwt}`, apikey: secret },
      body: { privateData: "raw-body-secret" },
      originalError: { name: secret, code: "ECONNRESET", request: { secret } },
    };
    const { result, clock } = await failure(error);
    const printed = [
      result.message,
      result.stack,
      JSON.stringify(result),
      ...clock.warn.mock.calls.flat(),
    ].join(" ");
    for (const forbidden of [
      jwt,
      secret,
      signedUrl,
      "raw-body-secret",
      "authorization",
      "headers",
      "request",
    ])
      expect(printed).not.toContain(forbidden);
    expect(result).not.toHaveProperty("cause");
    expect(result.diagnostic).toMatchObject({
      ...context,
      operation: "storage.upload",
      status: 503,
      code: "ECONNRESET",
      name: "StorageUnknownError",
      messagePresent: true,
      attempt: 3,
    });
  });

  it("redacts accidental signed URLs and credential text in operation metadata", async () => {
    const clock = runtime();
    const upload = async () => {
      throw { status: 403 };
    };
    const result = await retryIdempotentStorageUpload(
      upload,
      {
        bucket: "Authorization: Bearer secretValue",
        objectPath: "https://user:password@example.org/signed?token=verySecret",
        bytes: 1,
      },
      clock,
    ).catch((error: StorageUploadError) => error);
    expect(String(result)).not.toMatch(/secretValue|password|verySecret|example\.org/);
    expect(String(result)).toContain("[redacted-url]");
  });
});
