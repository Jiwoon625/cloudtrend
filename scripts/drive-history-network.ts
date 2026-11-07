/** Enforced transport boundary, not a counter that silently permits forbidden requests. */
export interface NetworkReceipt {
  allowed: Record<string, number>;
  denied: Array<{ method: string; category: string }>;
  historicalSourceGETs: number;
  supabaseWrites: number;
}
export function installDriveReadOnlyNetwork() {
  const original = globalThis.fetch;
  let resultPaths = new Set<string>();
  const receipt: NetworkReceipt = {
    allowed: {},
    denied: [],
    historicalSourceGETs: 0,
    supabaseWrites: 0,
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (url.hostname.endsWith(".supabase.co")) {
      const decoded = decodeURIComponent(url.pathname);
      const historical = /\/source\/(?:screening|us-screening)\//.test(decoded);
      const isStorageList = method === "POST" && decoded.startsWith("/storage/v1/object/list/");
      const write = !["GET", "HEAD"].includes(method) && !isStorageList;
      const category = historical
        ? "historical-source"
        : write
          ? "supabase-write"
          : decoded.startsWith("/rest/")
            ? "db-read"
            : "storage-state-or-cache-read";
      const resultWrite = write && ["POST", "PUT"].includes(method) && resultPaths.has(decoded);
      if (historical || (write && !resultWrite)) {
        receipt.denied.push({ method, category });
        throw new Error(`Drive validation blocked ${category}: ${method} ${url.pathname}`);
      }
      if (resultWrite) receipt.supabaseWrites++;
      receipt.allowed[category] = (receipt.allowed[category] ?? 0) + 1;
    } else receipt.allowed["other-read"] = (receipt.allowed["other-read"] ?? 0) + 1;
    return original(input, init);
  };
  return {
    receipt,
    enableResultWrites: (owner: string, runId: string) => {
      if (!/^[a-f0-9-]{36}$/.test(owner) || !/^[A-Za-z0-9_-]{8,128}$/.test(runId))
        throw new Error("Invalid result write identity");
      const prefix = `/storage/v1/object/cloudtrend-data/${owner}/`;
      resultPaths = new Set(
        [
          "results/drive-screening/input-head/latest.json",
          "cache/screening/latest.json",
          "cache/dashboard/latest.json",
          "cache/screening/confirmed-etf-context.json",
          `results/screening/${runId}.json`,
          "results/screening/latest.json",
          `results/drive-screening/receipts/${runId}.json`,
        ].map((p) => prefix + p),
      );
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
