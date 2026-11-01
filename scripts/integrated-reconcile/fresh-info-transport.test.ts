import { expect, it, vi } from "vitest";
import { freshInfoTransport } from "./fresh-info-transport";
const origin = "https://example.supabase.co";
function fixture() {
  let n = 0;
  const calls: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return new Response("{}", { status: 200 });
  });
  const transport = freshInfoTransport({
    expectedOrigin: origin,
    fetch,
    nonce: () => `unique-${++n}`,
  });
  return { calls, fetch, transport };
}
it("freshens every info GET while preserving authorization and SDK query", async () => {
  const f = fixture();
  const url = `${origin}/storage/v1/object/info/cloudtrend-data/private/key.json?x=1&cacheNonce=old`;
  const init = {
    headers: { Authorization: "Bearer synthetic", apikey: "synthetic-key" },
    credentials: "omit" as const,
  };
  await f.transport(url, init);
  await f.transport(url, init);
  expect(f.calls.map((c) => new URL(c.url).searchParams.get("cacheNonce"))).toEqual([
    "unique-1",
    "unique-2",
  ]);
  for (const req of f.calls) {
    expect(new URL(req.url).searchParams.get("x")).toBe("1");
    expect(req.headers.get("authorization")).toBe("Bearer synthetic");
    expect(req.headers.get("apikey")).toBe("synthetic-key");
    expect(req.cache).toBe("no-store");
    expect(req.headers.get("cache-control")).toContain("no-store");
    expect(req.credentials).toBe("omit");
  }
});
it("supports Request input, init overrides and abort propagation", async () => {
  const f = fixture(),
    controller = new AbortController();
  const req = new Request(`${origin}/storage/v1/object/info/bucket/key`, {
    headers: { Authorization: "old" },
    signal: controller.signal,
  });
  await f.transport(req, { headers: { Authorization: "new" } });
  expect(f.calls[0].headers.get("authorization")).toBe("new");
  controller.abort();
  expect(f.calls[0].signal.aborted).toBe(true);
});
it.each([
  "https://evil.test",
  "http://example.supabase.co",
  "https://example.supabase.co.evil.test",
])("rejects cross-origin info before fetch %s", async (bad) => {
  const f = fixture();
  await expect(
    f.transport(`${bad}/storage/v1/object/info/bucket/key`, {
      headers: { Authorization: "synthetic" },
    }),
  ).rejects.toThrow("Cross-origin");
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each([
  "/rest/v1/ledger_model_sessions",
  "/storage/v1/object/bucket/key",
  "/storage/v1/object/infox/bucket/key",
])("leaves non-info arguments identical %s", async (path) => {
  const f = fixture(),
    url = `${origin}${path}`,
    init = { headers: { apikey: "key" }, cache: "default" as const };
  await f.transport(url, init);
  expect(f.fetch.mock.calls[0][0]).toBe(url);
  expect(f.fetch.mock.calls[0][1]).toBe(init);
});
it("leaves non-GET info requests unchanged", async () => {
  const f = fixture(),
    req = new Request(`${origin}/storage/v1/object/info/bucket/key`, {
      method: "POST",
      body: "body",
    });
  await f.transport(req);
  expect(f.fetch.mock.calls[0][0]).toBe(req);
});
it.each(["http://example.supabase.co", `${origin}/path`, `https://user:pass@example.supabase.co`])(
  "rejects unsafe expected origin %s",
  (value) => {
    expect(() => freshInfoTransport({ expectedOrigin: value, fetch })).toThrow("Exact HTTPS");
  },
);
it("propagates transport rejection without retries", async () => {
  const fetch = vi.fn(async () => {
    throw Error("transport failed");
  });
  const wrapped = freshInfoTransport({ expectedOrigin: origin, fetch });
  await expect(wrapped(`${origin}/storage/v1/object/info/b/key`)).rejects.toThrow(
    "transport failed",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
