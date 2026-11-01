import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { INTEGRATED_ALLOCATION_FROZEN_CODE_HASH } from "../../src/lib/integratedAllocationRuntimeAdmission";
import { generationCachedLoader, type StrongGeneration } from "./generation-cache";
import { freshInfoTransport } from "./fresh-info-transport";
import { budgetTransport } from "./budget-transport";
export const PROBE_DATE = "2026-10-28";
const MAX_PAYLOAD = 4 * 1024 * 1024;
/** Exactly one existing dated object, GET only, no SDK/auth endpoint or mutation capability. */
export function createReadOnlyProbe(options: {
  origin: string;
  uid: string;
  fetch: typeof globalThis.fetch;
  headers: HeadersInit;
}) {
  if (
    !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(options.origin) ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(options.uid)
  )
    throw Error("Fixed probe identity required");
  const key = `cloudtrend-data/${options.uid}/staging/integrated-allocation-inputs/v1/KR/${PROBE_DATE}.json`;
  const infoPath = `/storage/v1/object/info/${key}`,
    payloadPath = `/storage/v1/object/${key}`;
  let infoRequests = 0,
    payloadDownloads = 0,
    started = false;
  const guard: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.origin !== options.origin ||
      url.username ||
      url.password ||
      url.hash ||
      ![infoPath, payloadPath].includes(url.pathname) ||
      [...url.searchParams.keys()].some((k) => k !== "cacheNonce") ||
      url.searchParams.getAll("cacheNonce").length !== 1 ||
      !url.searchParams.get("cacheNonce")
    )
      throw Error("Read-only fixed probe request refused");
    if (url.pathname === infoPath) infoRequests++;
    else {
      if (payloadDownloads >= 1) throw Error("Second full payload read refused");
      payloadDownloads++;
    }
    const headers = new Headers(request.headers);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    return options.fetch(new Request(request, { headers, redirect: "error" }));
  };
  const budget = budgetTransport({
    expectedOrigin: options.origin,
    fetch: guard,
    maxBytes: 8 * 1024 * 1024,
    maxRequests: 12,
  });
  const transport = freshInfoTransport({ expectedOrigin: options.origin, fetch: budget.fetch });
  async function json(path: string) {
    const response = await transport(`${options.origin}${path}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-store, no-cache" },
    });
    if (!response.ok) throw Error("Fixed probe read failed");
    return response.json();
  }
  let latestStrongSize: number | null = null;
  const load = generationCachedLoader({
    probe: async (): Promise<StrongGeneration> => {
      const data = await json(infoPath);
      if (
        ![data?.id, data?.version, data?.etag].every(
          (v) => typeof v === "string" && v.trim().length > 0,
        ) ||
        !Number.isSafeInteger(data.size) ||
        data.size <= 0 ||
        data.size > MAX_PAYLOAD
      )
        throw Error("Strong bounded object generation required");
      latestStrongSize = data.size;
      return {
        kind: "strong",
        objectId: data.id,
        version: data.version,
        etag: data.etag,
        size: data.size,
      };
    },
    loadValidated: async () => {
      const beforeBytes = budget.usage().bytes;
      const envelope = await json(`${payloadPath}?cacheNonce=${crypto.randomUUID()}`);
      const payloadBytes = budget.usage().bytes - beforeBytes;
      if (payloadBytes > MAX_PAYLOAD) throw Error("Single payload byte limit exceeded");
      if (latestStrongSize === null || payloadBytes !== latestStrongSize)
        throw Error("Payload bytes differ from strong generation size");
      const p = envelope?.payload,
        c = p?.clock;
      if (
        !/^sha256:[a-f0-9]{64}$/.test(envelope?.hash ?? "") ||
        p?.version !== "integrated-kr-daily-evidence-v1" ||
        p?.date !== PROBE_DATE ||
        c?.codeHash !== INTEGRATED_ALLOCATION_FROZEN_CODE_HASH ||
        !/^sha256:[a-f0-9]{64}$/.test(c?.sourceHash ?? "") ||
        ![c?.openAt, c?.closeAt, c?.availableAt, c?.decisionAt].every(
          (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
        ) ||
        Date.parse(c.openAt) >= Date.parse(c.closeAt) ||
        Date.parse(c.closeAt) > Date.parse(c.availableAt) ||
        Date.parse(c.availableAt) > Date.parse(c.decisionAt) ||
        (await hashSeriesValue(p)) !== envelope.hash
      )
        throw Error("Dated probe envelope verification failed");
      return { hash: envelope.hash as string };
    },
  });
  const usage = () => ({
    infoRequests,
    payloadDownloads,
    bytes: budget.usage().bytes,
    requests: budget.usage().requests,
  });
  return {
    usage,
    /** Exported guarded transport permits independent denial tests, but cannot broaden reads. */
    transport,
    async run() {
      if (started) throw Error("Probe invocation already used");
      started = true;
      const first = await load(),
        second = await load();
      if (
        !first ||
        !second ||
        first.hash !== second.hash ||
        payloadDownloads !== 1 ||
        infoRequests !== 3
      )
        throw Error("Fresh generation cache proof incomplete");
      return { market: "KR" as const, date: PROBE_DATE, ...usage(), sameHash: true as const };
    },
  };
}
