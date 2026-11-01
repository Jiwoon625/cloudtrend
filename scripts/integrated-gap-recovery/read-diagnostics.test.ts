import { describe, expect, it, vi } from "vitest";
import {
  diagnosticFetch,
  diagnosticSnapshotFetch,
  runDiagnosticRead,
  type SafeReadDiagnostic,
} from "./read-diagnostics";
const url = "https://example.supabase.co/rest/v1/portfolio_ledgers?user_id=secret-owner";
async function run(body: string, status = 401, headers: Record<string, string> = {}) {
  const records: SafeReadDiagnostic[] = [];
  const response = new Response(body, { status, headers });
  const base = vi.fn<typeof fetch>().mockResolvedValue(response);
  const result = await diagnosticFetch(base, (r) => records.push(r))(url);
  return { records, base, response, result };
}
describe("safe one-shot read diagnostics", () => {
  it.each([
    ["PGRST303", "JWT issued at future", "JWT_CLAIMS", "JWT_ISSUED_AT_FUTURE"],
    ["PGRST301", "JWT expired", "JWT_INVALID", "JWT_EXPIRED"],
    ["42501", "JWT not yet valid", "PERMISSIONS", "JWT_NOT_YET_VALID"],
  ])("classifies only known values %s", async (code, message, cc, mc) => {
    const r = await run(JSON.stringify({ code, message }));
    expect(r.records[0]).toMatchObject({
      codeCategory: cc,
      messageCategory: mc,
      status: 401,
      method: "GET",
      bodyCategory: "JSON",
    });
    expect(r.result).toBe(r.response);
    expect(r.base).toHaveBeenCalledTimes(1);
    expect(await r.result.text()).toBe(JSON.stringify({ code, message }));
  });
  it("does not expose unknown secret message, query, headers or fields", async () => {
    const r = await run(
      JSON.stringify({ code: "secret-code", message: "secret-token", details: "secret-data" }),
      403,
      { authorization: "secret-header", "sb-request-id": "secret-id", date: "secret-date" },
    );
    const text = JSON.stringify(r.records);
    expect(text).not.toContain("secret");
    expect(r.records[0]).toMatchObject({ codeCategory: "OTHER", messageCategory: "OTHER" });
  });
  it("bounds oversized body and preserves original response", async () => {
    const body = JSON.stringify({ message: "s".repeat(3000) });
    const r = await run(body);
    expect(r.records[0].bodyCategory).toBe("OVERSIZED");
    expect(await r.result.text()).toBe(body);
  });
  it("does not read successful response body or emit", async () => {
    const r = await run("success", 200);
    expect(r.records).toEqual([]);
    expect(await r.result.text()).toBe("success");
  });
  it("preserves exact request arguments, headers and body without retry", async () => {
    const response = new Response("{}", { status: 401 });
    const base = vi.fn<typeof fetch>().mockResolvedValue(response);
    const request = new Request(url, { headers: { authorization: "test-only" } });
    const init = { headers: { "x-test": "unchanged" } };
    await diagnosticFetch(base, () => {})(request, init);
    expect(base).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(request.headers.get("authorization")).toBe("test-only");
    expect(init.headers).toEqual({ "x-test": "unchanged" });
  });
  it("never diagnoses POST or alters its body", async () => {
    const response = new Response("{}", { status: 403 }),
      emit = vi.fn();
    const base = vi.fn<typeof fetch>().mockResolvedValue(response);
    const init = {
      method: "POST",
      body: "sensitive-payload",
      headers: { authorization: "test-only" },
    };
    expect(await diagnosticFetch(base, emit)(url, init)).toBe(response);
    expect(base).toHaveBeenCalledExactlyOnceWith(url, init);
    expect(emit).not.toHaveBeenCalled();
  });
  it("reports validated date and UUID only", async () => {
    const r = await run("{}", 401, {
      date: "Sun, 01 Nov 2026 11:00:00 GMT",
      "sb-request-id": "12345678-1234-1234-1234-123456789ABC",
    });
    expect(r.records[0]).toMatchObject({
      responseDate: "Sun, 01 Nov 2026 11:00:00 GMT",
      requestId: "12345678-1234-1234-1234-123456789abc",
    });
    expect(Number.isFinite(Date.parse(r.records[0].observedAt))).toBe(true);
  });
  it("maps unlisted sensitive path to OTHER", async () => {
    const records: SafeReadDiagnostic[] = [];
    await diagnosticFetch(
      async () => new Response("{}", { status: 404 }),
      (r) => records.push(r),
    )("https://example.test/private/secret-owner");
    expect(records[0].path).toBe("OTHER");
  });
  it("preserves rejection without logging exception details or retry", async () => {
    const failure = new Error("secret"),
      base = vi.fn<typeof fetch>().mockRejectedValue(failure),
      emit = vi.fn();
    await expect(diagnosticFetch(base, emit)(url)).rejects.toBe(failure);
    expect(base).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });
  it("keeps response if logging throws", async () => {
    const response = new Response("{}", { status: 401 });
    expect(
      await diagnosticFetch(
        async () => response,
        () => {
          throw Error("logger");
        },
      )(url),
    ).toBe(response);
  });
  it("handles empty HEAD without reading or changing the original", async () => {
    const records: SafeReadDiagnostic[] = [],
      response = new Response(null, { status: 401 });
    const base = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await diagnosticFetch(base, (r) => records.push(r))(url, { method: "HEAD" })).toBe(
      response,
    );
    expect(records[0]).toMatchObject({ method: "HEAD", bodyCategory: "UNREADABLE" });
    expect(base).toHaveBeenCalledTimes(1);
  });
  it("never exposes invalid JSON content", async () => {
    const r = await run("secret not JSON");
    expect(r.records[0].bodyCategory).toBe("UNREADABLE");
    expect(JSON.stringify(r.records)).not.toContain("secret");
  });
  it("bounds stalled diagnostic reading without retry or affecting original stream", async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      const records: SafeReadDiagnostic[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const response = new Response(stream, { status: 401 });
      const base = vi.fn<typeof fetch>().mockResolvedValue(response);
      const pending = diagnosticFetch(base, (r) => records.push(r))(url);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe(response);
      expect(records[0].bodyCategory).toBe("UNREADABLE");
      expect(base).toHaveBeenCalledTimes(1);
      controller!.enqueue(new TextEncoder().encode("original-body"));
      controller!.close();
      controller = undefined;
      expect(await response.text()).toBe("original-body");
    } finally {
      controller?.close();
      vi.useRealTimers();
    }
  });
});

describe("five-path minimal read diagnostic", () => {
  const owner = "11111111-1111-4111-8111-111111111111",
    origin = "https://example.supabase.co";
  const minimal =
    origin + "/rest/v1/portfolio_ledgers?select=user_id&user_id=eq." + owner + "&limit=1";
  it("reads five unique paths once with only owner projection and unchanged credentials", async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const u = new URL(String(input));
      expect(u.searchParams.get("select")).toBe("user_id");
      expect(u.searchParams.get("limit")).toBe("1");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ apikey: "test-key", Authorization: "Bearer test-key" });
      return new Response(JSON.stringify([{ user_id: owner }]));
    });
    await runDiagnosticRead({ origin, owner, key: "test-key" }, base, () => {});
    expect(base).toHaveBeenCalledTimes(5);
    expect(new Set(base.mock.calls.map((c) => new URL(String(c[0])).pathname)).size).toBe(5);
  });
  it.each(["POST", "PATCH", "DELETE"])("rejects mutation %s", async (method) => {
    const base = vi.fn<typeof fetch>();
    await expect(
      diagnosticSnapshotFetch(base, origin, owner)(minimal, { method }),
    ).rejects.toThrow();
    expect(base).not.toHaveBeenCalled();
  });
  it.each(["select=*", "limit=2", "user_id=eq.foreign"])(
    "rejects broader query %s",
    async (query) => {
      const u = new URL(minimal),
        [k, v] = query.split("=");
      u.searchParams.set(k, v);
      const base = vi.fn<typeof fetch>();
      await expect(diagnosticSnapshotFetch(base, origin, owner)(u)).rejects.toThrow();
      expect(base).not.toHaveBeenCalled();
    },
  );
  it("rejects repeat path and failed read retry", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 401 }));
    const read = diagnosticSnapshotFetch(base, origin, owner, () => {});
    await read(minimal);
    await expect(read(minimal)).rejects.toThrow();
    expect(base).toHaveBeenCalledTimes(1);
  });
  it.each([
    "/rest/v1/shadow_replay_audit",
    "/rest/v1/ledger_provenance_archive",
    "/storage/v1/object/private",
    "/rest/v1/portfolio_trades",
  ])("rejects extra path %s", async (path) => {
    const u = new URL(minimal);
    u.pathname = path;
    const base = vi.fn<typeof fetch>();
    await expect(diagnosticSnapshotFetch(base, origin, owner)(u)).rejects.toThrow();
    expect(base).not.toHaveBeenCalled();
  });
  it.each([
    JSON.stringify([{ user_id: "other" }]),
    JSON.stringify([{ user_id: owner, secret: "x" }]),
    "x".repeat(4097),
  ])("rejects unexpected success body", async (body) => {
    await expect(
      runDiagnosticRead(
        { origin, owner, key: "test-key" },
        async () => new Response(body),
        () => {},
      ),
    ).rejects.toThrow();
  });
  it.each([
    { origin: "http://example.supabase.co" },
    { origin: "https://other.test" },
    { origin: "https://example.supabase.co/secret" },
    { origin: "https://example.supabase.co?secret=x" },
    { owner: "not-owner" },
    { key: "" },
  ])("rejects invalid connection before sending credentials", async (bad) => {
    const base = vi.fn<typeof fetch>();
    await expect(
      runDiagnosticRead({ origin, owner, key: "test-key", ...bad }, base, () => {}),
    ).rejects.toThrow();
    expect(base).not.toHaveBeenCalled();
  });
});
