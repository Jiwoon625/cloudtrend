import { expect, it, vi } from "vitest";
import { budgetTransport } from "./budget-transport";
const expectedOrigin = "https://example.supabase.co";
const url = `${expectedOrigin}/rest/v1/table`;
function chunks(values: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const value of values) c.enqueue(new TextEncoder().encode(value));
      c.close();
    },
  });
}
it("counts streamed bytes and rejects before returning the excessive chunk", async () => {
  const fetch = vi.fn(async () => new Response(chunks(["abc", "def"]), { status: 200 }));
  const t = budgetTransport({ expectedOrigin, fetch, maxBytes: 5, maxRequests: 3 });
  const response = await t.fetch(url),
    reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("abc");
  await expect(reader.read()).rejects.toThrow("byte budget");
  expect(t.usage()).toEqual({ bytes: 3, requests: 1, exhausted: true });
  await expect(t.fetch(url)).rejects.toThrow("budget exhausted");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("accepts exact byte cap and shares accounting across responses", async () => {
  const t = budgetTransport({
    expectedOrigin,
    fetch: async () => new Response("abc"),
    maxBytes: 6,
    maxRequests: 3,
  });
  expect(await (await t.fetch(url)).text()).toBe("abc");
  expect(await (await t.fetch(url)).text()).toBe("abc");
  await expect((await t.fetch(url)).text()).rejects.toThrow("byte budget");
  expect(t.usage().bytes).toBe(6);
});
it("enforces request cap before network and preserves original request arguments", async () => {
  const fetch = vi.fn(
    async () =>
      new Response("ok", { status: 201, statusText: "Created", headers: { "x-original": "yes" } }),
  );
  const t = budgetTransport({ expectedOrigin, fetch, maxBytes: 50, maxRequests: 1 });
  const init = { headers: { Authorization: "synthetic" }, method: "POST", body: "payload" };
  const response = await t.fetch(url, init);
  expect(fetch.mock.calls[0]).toEqual([url, init]);
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(response.headers.get("x-original")).toBe("yes");
  expect(await response.text()).toBe("ok");
  await expect(t.fetch(url)).rejects.toThrow("budget exhausted");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("preserves empty response and ignores unrelated origins", async () => {
  const response = new Response(null, { status: 204 });
  const fetch = vi.fn(async () => response);
  const t = budgetTransport({ expectedOrigin, fetch, maxBytes: 5, maxRequests: 1 });
  expect(await t.fetch("https://other.test/path")).toBe(response);
  expect(t.usage().requests).toBe(0);
  expect(await t.fetch(url)).toBe(response);
  expect(t.usage().requests).toBe(1);
});
it("counts failed network attempts without retries", async () => {
  const fetch = vi.fn(async () => {
    throw Error("network failed");
  });
  const t = budgetTransport({ expectedOrigin, fetch, maxBytes: 5, maxRequests: 2 });
  await expect(t.fetch(url)).rejects.toThrow("network failed");
  expect(t.usage().requests).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([0, -1, NaN, Infinity, 1.5])("rejects unsafe budget %s", (maxBytes) => {
  expect(() => budgetTransport({ expectedOrigin, fetch, maxBytes, maxRequests: 1 })).toThrow(
    "limits required",
  );
});
