import { expect, it, vi } from "vitest";
import { createReadOnlyProbe, PROBE_DATE } from "./probe";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { INTEGRATED_ALLOCATION_FROZEN_CODE_HASH } from "../../src/lib/integratedAllocationRuntimeAdmission";
const origin = "https://example.supabase.co",
  uid = "11111111-1111-4111-8111-111111111111";
const path = `/storage/v1/object/cloudtrend-data/${uid}/staging/integrated-allocation-inputs/v1/KR/${PROBE_DATE}.json`;
async function fixture(
  options: {
    changed?: boolean;
    huge?: boolean;
    weak?: boolean;
    badHash?: boolean;
    oversizedValid?: boolean;
    sizeMismatch?: boolean;
  } = {},
) {
  let infos = 0;
  const payload = {
    version: "integrated-kr-daily-evidence-v1",
    date: PROBE_DATE,
    ...(options.oversizedValid ? { padding: "x".repeat(4 * 1024 * 1024) } : {}),
    clock: {
      codeHash: INTEGRATED_ALLOCATION_FROZEN_CODE_HASH,
      sourceHash: `sha256:${"a".repeat(64)}`,
      openAt: "2026-10-28T00:00:00Z",
      closeAt: "2026-10-28T06:30:00Z",
      availableAt: "2026-10-29T08:00:00+09:00",
      decisionAt: "2026-10-29T08:10:00+09:00",
    },
  };
  const hash = await hashSeriesValue(payload);
  const body = JSON.stringify({
    hash: options.badHash ? `sha256:${"b".repeat(64)}` : hash,
    payload,
  });
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.url.includes("/object/info/")) {
      infos++;
      return new Response(
        JSON.stringify({
          id: "object",
          version: options.changed && infos >= 3 ? "v2" : "v1",
          etag: options.weak ? "" : "etag",
          size: options.oversizedValid ? 2048 : options.sizeMismatch ? bodyBytes - 1 : bodyBytes,
        }),
      );
    }
    if (options.huge) return new Response("x".repeat(8 * 1024 * 1024 + 1));
    return new Response(body);
  });
  const probe = createReadOnlyProbe({
    origin,
    uid,
    fetch,
    headers: { Authorization: "Bearer synthetic", apikey: "synthetic" },
  });
  return { probe, fetch, requests };
}
it("proves fresh strong cache hit with exactly one payload and no auth/DB calls", async () => {
  const f = await fixture(),
    result = await f.probe.run();
  expect(result).toMatchObject({
    market: "KR",
    date: PROBE_DATE,
    infoRequests: 3,
    payloadDownloads: 1,
    requests: 4,
    sameHash: true,
  });
  expect(Object.keys(result).sort()).toEqual([
    "bytes",
    "date",
    "infoRequests",
    "market",
    "payloadDownloads",
    "requests",
    "sameHash",
  ]);
  const nonces = f.requests.map((r) => new URL(r.url).searchParams.get("cacheNonce"));
  expect(new Set(nonces).size).toBe(4);
  for (const request of f.requests) {
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic");
    expect(request.headers.get("apikey")).toBe("synthetic");
    expect(new URL(request.url).pathname).toMatch(/^\/storage\/v1\/object\//);
  }
  await expect(f.probe.run()).rejects.toThrow("already used");
});
it("changed generation aborts before a second full download", async () => {
  const f = await fixture({ changed: true });
  await expect(f.probe.run()).rejects.toThrow("Second full payload read refused");
  expect(f.requests.filter((r) => !r.url.includes("/info/")).length).toBe(1);
});
it.each(["POST", "PUT", "DELETE", "PATCH", "HEAD"])(
  "rejects %s without network",
  async (method) => {
    const f = await fixture();
    await expect(f.probe.transport(`${origin}${path}?cacheNonce=n`, { method })).rejects.toThrow(
      "refused",
    );
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
it.each([
  "https://evil.test" + path,
  origin + "/auth/v1/token",
  origin + "/rest/v1/ledger_model_sessions",
  origin + path.replace(uid, "22222222-2222-4222-8222-222222222222"),
  origin + path.replace(PROBE_DATE, "2026-10-29"),
])("rejects outside exact scope %s", async (url) => {
  const f = await fixture();
  await expect(f.probe.transport(`${url}?cacheNonce=n`)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
});
it("rejects weak metadata before payload", async () => {
  const f = await fixture({ weak: true });
  await expect(f.probe.run()).rejects.toThrow("Strong bounded");
  expect(f.probe.usage().payloadDownloads).toBe(0);
});
it("rejects corrupt envelope", async () => {
  const f = await fixture({ badHash: true });
  await expect(f.probe.run()).rejects.toThrow("envelope verification");
});
it("bounds even an oversized payload response", async () => {
  const f = await fixture({ huge: true });
  await expect(f.probe.run()).rejects.toThrow("byte budget");
  expect(f.probe.usage().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
});
it("caps total requests before extra network", async () => {
  const f = await fixture();
  const info = `${origin}${path.replace("/object/", "/object/info/")}`;
  for (let i = 0; i < 12; i++) await (await f.probe.transport(info)).json();
  await expect(f.probe.transport(info)).rejects.toThrow("budget exhausted");
  expect(f.fetch).toHaveBeenCalledTimes(12);
});

it("rejects valid oversized JSON despite falsely small metadata", async () => {
  const f = await fixture({ oversizedValid: true });
  await expect(f.probe.run()).rejects.toThrow("Single payload byte limit exceeded");
  expect(f.probe.usage().payloadDownloads).toBe(1);
});
it("requires actual UTF-8 payload bytes to exactly match strong metadata size", async () => {
  const f = await fixture({ sizeMismatch: true });
  await expect(f.probe.run()).rejects.toThrow("Payload bytes differ from strong generation size");
  expect(f.probe.usage().payloadDownloads).toBe(1);
});
