import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_BUCKET, sha256, stableJson, uploadJson } from "../scripts/analysis-run-store";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function clientWith(upload: ReturnType<typeof vi.fn>) {
  const from = vi.fn(() => ({ upload }));
  return { from, client: { storage: { from } } as unknown as SupabaseClient };
}

describe("uploadJson resilient idempotent integration", () => {
  it("reuses exact serialized bytes, path, upsert and cache-control through retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const toJSON = vi.fn(() => ({ version: "unchanged", payload: "한글", generation: 1 }));
    const value = { toJSON };
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ error: { statusCode: "503", message: "<none>" } })
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue({ error: null });
    const { client, from } = clientWith(upload);
    const pending = uploadJson(client, "cache/dashboard/latest.json", value);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(3);
    for (const call of upload.mock.calls) {
      expect(call).toEqual([
        "cache/dashboard/latest.json",
        result.body,
        { contentType: "application/json", upsert: true, cacheControl: "0" },
      ]);
      expect(call[2]).toBe(upload.mock.calls[0]?.[2]);
    }
    expect(from.mock.calls).toEqual([[ANALYSIS_BUCKET], [ANALYSIS_BUCKET], [ANALYSIS_BUCKET]]);
    expect(result.body).toBe(
      JSON.stringify({ version: "unchanged", payload: "한글", generation: 1 }, null, 2),
    );
    expect(sha256(result.body)).toBe(sha256(upload.mock.calls[0]?.[1]));
  });

  it("preserves immutable-path options and JSON/hash semantics on first-attempt success", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientWith(upload);
    const value = { z: 2, a: [1, { y: false, x: null }] };
    const initial = stableJson(value);
    const result = await uploadJson(client, "runs/stable-id/payload.json", value);
    expect(result).toEqual({
      objectPath: "runs/stable-id/payload.json",
      body: JSON.stringify(value, null, 2),
    });
    expect(upload).toHaveBeenCalledExactlyOnceWith("runs/stable-id/payload.json", result.body, {
      contentType: "application/json",
      upsert: true,
    });
    expect(stableJson(value)).toBe(initial);
  });

  it("reports encoded byte length and terminal status without retrying denied writes", async () => {
    const upload = vi
      .fn()
      .mockResolvedValue({ error: { status: 403, error: "AccessDenied", message: "private" } });
    const { client } = clientWith(upload);
    const value = { message: "한글" };
    await expect(uploadJson(client, "cache/dashboard/latest.json", value)).rejects.toMatchObject({
      diagnostic: {
        operation: "storage.upload",
        bucket: ANALYSIS_BUCKET,
        objectPath: "cache/dashboard/latest.json",
        bytes: Buffer.byteLength(JSON.stringify(value, null, 2), "utf8"),
        status: 403,
        code: "AccessDenied",
        attempt: 1,
        failureKind: "permanent",
      },
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("recovers an opaque <none> SDK response once", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "<none>" } })
      .mockResolvedValue({ error: null });
    const { client } = clientWith(upload);
    const pending = uploadJson(client, "cache/dashboard/latest.json", { ok: true });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toHaveProperty("objectPath", "cache/dashboard/latest.json");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("never uploads or retries serialization errors", async () => {
    const upload = vi.fn();
    const { client } = clientWith(upload);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(
      uploadJson(client, "cache/dashboard/latest.json", circular),
    ).rejects.toBeInstanceOf(TypeError);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("uploadJson with the installed Supabase SDK and a local mock transport", () => {
  it("retries a real SDK 503 response without changing the outgoing bytes", async () => {
    const { createClient } =
      await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ statusCode: "503", code: "SlowDown" }), { status: 503 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({ Key: "cloudtrend-data/cache/dashboard/latest.json", Id: "test-id" }),
          { status: 200 },
        ),
      );
    const client = createClient("https://storage-test.invalid", "test-only-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetcher },
    });
    const pending = uploadJson(client, "cache/dashboard/latest.json", { payload: "same-bytes" });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toEqual(fetcher.mock.calls[1]?.[0]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options.body).toBe(result.body);
      expect(new Headers(options.headers).get("x-upsert")).toBe("true");
    }
  });

  it("does not retry a real SDK RLS denial response", async () => {
    const { createClient } =
      await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "AccessDenied",
          message: "new row violates row-level security policy",
        }),
        { status: 403 },
      ),
    );
    const client = createClient("https://storage-test.invalid", "test-only-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetcher },
    });
    await expect(
      uploadJson(client, "cache/dashboard/latest.json", { ok: true }),
    ).rejects.toMatchObject({
      diagnostic: {
        status: 403,
        code: "AccessDenied",
        name: "StorageApiError",
        reason: "authorization",
        attempt: 1,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
